import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Annotations, CfnOutput, Duration } from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';

const SPA_REWRITE_FILE = fileURLToPath(new URL('./functions/spa-rewrite.js', import.meta.url));

export interface StaticSiteProps {
  /** Private bucket (from the stateful stack) that holds the built SPA. */
  bucket: s3.IBucket;
  /** Local folder with the built SPA: index.html plus hashed files in assets/. */
  buildDir: string;
}

/**
 * Serves the SPA from a private S3 bucket through CloudFront:
 * Origin Access Control for bucket access, a CloudFront Function for client-side
 * routes, and two uploads with different cache headers.
 */
export class StaticSite extends Construct {
  readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: StaticSiteProps) {
    super(scope, id);

    if (!existsSync(join(props.buildDir, 'index.html'))) {
      throw new Error(
        `No index.html in ${props.buildDir}. Build the web app first: npm run build -w @cloud-relay/web`,
      );
    }

    // Re-import the bucket by name instead of using the Bucket object directly.
    // Otherwise CDK puts the OAC statement into a bucket policy in the stateful
    // stack, and that policy would need this stack's distribution ARN: a circular
    // dependency between the two stacks. We write the bucket policy here instead.
    const bucket = s3.Bucket.fromBucketAttributes(this, 'Bucket', {
      bucketArn: props.bucket.bucketArn,
      bucketName: props.bucket.bucketName,
    });

    const spaRewrite = new cloudfront.Function(this, 'SpaRewrite', {
      code: cloudfront.FunctionCode.fromFile({ filePath: SPA_REWRITE_FILE }),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: 'Serve index.html for client-side routes',
    });

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'Cloud Relay web app',
      defaultRootObject: 'index.html',
      defaultBehavior: {
        // Creates an OAC: CloudFront signs every request to S3 (SigV4).
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        // AWS-managed policies: the same ones the console's "recommended settings" pick.
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        functionAssociations: [
          { function: spaRewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
        ],
      },
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      // Cheapest edge locations (North America, Europe, Israel). Visitors elsewhere
      // are still served, just from a farther edge.
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });

    // CDK can't edit an imported bucket's policy and warns about it; we add it below.
    Annotations.of(this).acknowledgeWarning(
      '@aws-cdk/aws-cloudfront-origins:updateImportedBucketPolicyOac',
    );

    // A bucket has exactly one bucket policy, and this is it.
    const policy = new s3.BucketPolicy(this, 'BucketPolicy', { bucket });
    policy.document.addStatements(
      // OAC: only this distribution (via the CloudFront service principal) may read.
      new iam.PolicyStatement({
        sid: 'AllowCloudFrontRead',
        principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
        actions: ['s3:GetObject'],
        resources: [bucket.arnForObjects('*')],
        conditions: { StringEquals: { 'AWS:SourceArn': this.distribution.distributionArn } },
      }),
      new iam.PolicyStatement({
        sid: 'DenyInsecureTransport',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:*'],
        resources: [bucket.bucketArn, bucket.arnForObjects('*')],
        conditions: { Bool: { 'aws:SecureTransport': 'false' } },
      }),
    );

    // BucketDeployment runs a CDK-managed Lambda during `cdk deploy` that copies
    // files into the bucket. Hashed assets never change, so they cache for a year.
    const assets = new s3deploy.BucketDeployment(this, 'DeployAssets', {
      sources: [s3deploy.Source.asset(join(props.buildDir, 'assets'))],
      destinationBucket: bucket,
      destinationKeyPrefix: 'assets/',
      cacheControl: [
        s3deploy.CacheControl.setPublic(),
        s3deploy.CacheControl.maxAge(Duration.days(365)),
        s3deploy.CacheControl.immutable(),
      ],
      // Keep old hashed files so a tab open on the previous version can still load its chunks.
      prune: false,
    });

    // index.html must always be revalidated so a deploy shows up right away.
    const shell = new s3deploy.BucketDeployment(this, 'DeployShell', {
      sources: [s3deploy.Source.asset(props.buildDir, { exclude: ['assets', '.vite'] })],
      destinationBucket: bucket,
      // .vite/ is Vite's build manifest, not needed by the site. Leave assets/ alone
      // when pruning files that are no longer in the build.
      exclude: ['assets/*'],
      cacheControl: [s3deploy.CacheControl.noCache()],
      distribution: this.distribution,
      distributionPaths: ['/index.html'],
    });
    // Upload the new assets before the index.html that references them.
    shell.node.addDependency(assets);

    new CfnOutput(this, 'SiteUrl', {
      value: `https://${this.distribution.distributionDomainName}`,
    });
    new CfnOutput(this, 'DistributionId', { value: this.distribution.distributionId });
    new CfnOutput(this, 'BucketName', { value: bucket.bucketName });
  }
}
