import { Stack, type StackProps } from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import type { Construct } from 'constructs';
import type { StatefulStack } from './stateful-stack.ts';
import { StaticSite } from './static-site.ts';
import { UploadApi } from './upload-api.ts';

export interface StatelessStackProps extends StackProps {
  /** Buckets, tables, etc. that this stack's compute reads and writes. */
  stateful: StatefulStack;
  /** Folder with the built SPA to upload. */
  webBuildDir: string;
}

/**
 * Compute and routing: Lambdas, API Gateway, CloudFront, ECS task definitions.
 * Nothing in here stores data, so it is always safe to replace or tear down.
 */
export class StatelessStack extends Stack {
  constructor(scope: Construct, id: string, props: StatelessStackProps) {
    super(scope, id, props);

    // Deploy order: stateful first. CDK also infers this from cross-stack
    // references once we start passing buckets and tables in.
    this.addStackDependency(props.stateful);

    const site = new StaticSite(this, 'Site', {
      bucket: props.stateful.siteBucket,
      buildDir: props.webBuildDir,
    });

    const uploadApi = new UploadApi(this, 'UploadApi', {
      uploadsBucket: props.stateful.uploadsBucket,
    });

    // Behaviors → /api/* goes to API Gateway instead of S3, so the SPA can call
    // a relative /api/uploads on its own domain: no CORS, no API URL to configure.
    // Path behaviors are matched before the default (*) one, and this one has
    // no SPA-rewrite function.
    site.distribution.addBehavior(
      '/api/*',
      new origins.HttpOrigin(uploadApi.domainName, {
        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      }),
      {
        // CloudFront offers three method sets; POST is only in "all methods".
        // API Gateway answers 404 for anything but the POST route.
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        // Redirecting a POST would drop its body, so plain HTTP is refused instead.
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        // Every API response is unique, so never cache.
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        // Forward headers, query string and cookies, but not Host: API Gateway
        // uses Host to find the API and would reject the CloudFront domain.
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
      },
    );
  }
}
