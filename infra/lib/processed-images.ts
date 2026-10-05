import { Annotations, Duration } from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { PROCESSED_PREFIX } from '@cloud-relay/shared';
import { Construct } from 'constructs';

export interface ProcessedImagesProps {
  /** The site's distribution, which gets a `/processed/*` behavior. */
  distribution: cloudfront.Distribution;
  /** The worker's output bucket (from the stateful stack). */
  bucket: s3.IBucket;
}

/**
 * Serves the worker's resized images through the site's CloudFront domain:
 * `https://<site>/processed/{runId}/thumb.webp` is the S3 key
 * `processed/{runId}/thumb.webp`. The bucket stays private; CloudFront signs
 * its requests with Origin Access Control, as for the site bucket.
 */
export class ProcessedImages extends Construct {
  constructor(scope: Construct, id: string, props: ProcessedImagesProps) {
    super(scope, id);

    // Re-imported by name for the same reason as the site bucket (see
    // StaticSite): its policy must name this stack's distribution.
    const bucket = s3.Bucket.fromBucketAttributes(this, 'Bucket', {
      bucketArn: props.bucket.bucketArn,
      bucketName: props.bucket.bucketName,
    });

    // Policies → Cache → Create cache policy. What CloudFront caches an image
    // under (the cache key) and for how long.
    const cachePolicy = new cloudfront.CachePolicy(this, 'CachePolicy', {
      comment: 'Processed images: path-only cache key, edge copies at most 1 hour',
      // The worker sends Cache-Control max-age=1 year, which browsers keep.
      // CloudFront caches for the lesser of max-age and the maximum TTL, so an
      // edge copy never outlives an S3 lifecycle delete by more than an hour.
      minTtl: Duration.seconds(0),
      defaultTtl: Duration.hours(1),
      maxTtl: Duration.hours(1),
      // Run IDs make every URL unique, so the path alone is the cache key.
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      // WebP is already compressed: no gzip/brotli copies to cache.
      enableAcceptEncodingGzip: false,
      enableAcceptEncodingBrotli: false,
    });

    // Behaviors → /processed/* → the processed bucket. CloudFront forwards the
    // whole path, so the path pattern must equal the S3 key prefix.
    props.distribution.addBehavior(
      `/${PROCESSED_PREFIX}*`,
      // Creates a second OAC (the site origin has its own).
      origins.S3BucketOrigin.withOriginAccessControl(bucket),
      {
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy,
        compress: false,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
      },
    );

    // CDK can't edit an imported bucket's policy and warns about it; we add it below.
    Annotations.of(this).acknowledgeWarning(
      '@aws-cdk/aws-cloudfront-origins:updateImportedBucketPolicyOac',
    );

    // The bucket's one policy. Only GetObject under processed/: no ListBucket,
    // so a wrong URL gets 403 from S3 and nobody can list the keys.
    const policy = new s3.BucketPolicy(this, 'BucketPolicy', { bucket });
    policy.document.addStatements(
      new iam.PolicyStatement({
        sid: 'AllowCloudFrontRead',
        principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
        actions: ['s3:GetObject'],
        resources: [bucket.arnForObjects(`${PROCESSED_PREFIX}*`)],
        conditions: {
          StringEquals: { 'AWS:SourceArn': props.distribution.distributionArn },
        },
      }),
      // What enforceSSL added when the policy lived in the stateful stack.
      new iam.PolicyStatement({
        sid: 'DenyInsecureTransport',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:*'],
        resources: [bucket.bucketArn, bucket.arnForObjects('*')],
        conditions: { Bool: { 'aws:SecureTransport': 'false' } },
      }),
    );
  }
}
