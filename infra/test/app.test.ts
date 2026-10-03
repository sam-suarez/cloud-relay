import { fileURLToPath } from 'node:url';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../lib/app.ts';

const webBuildDir = fileURLToPath(new URL('./fixtures/site', import.meta.url));

// Synthesizing bundles the Lambdas with esbuild, so do it once for all tests.
let templates: { stateful: Template; stateless: Template } | undefined;
function synthTemplates() {
  if (!templates) {
    const { stateful, stateless } = buildApp(new App(), { webBuildDir });
    templates = {
      stateful: Template.fromStack(stateful),
      stateless: Template.fromStack(stateless),
    };
  }
  return templates;
}

/** Logical ID of the one resource of `type` matching `props`. */
function logicalId(template: Template, type: string, props: object): string {
  const ids = Object.keys(template.findResources(type, { Properties: props }));
  expect(ids).toHaveLength(1);
  return ids[0] as string;
}

describe('CDK app', () => {
  it('creates the stateful and stateless stacks in us-east-2', () => {
    const { stateful, stateless } = buildApp(new App(), { webBuildDir });

    expect(stateful.region).toBe('us-east-2');
    expect(stateless.region).toBe('us-east-2');
  });

  it('deploys the stateful stack before the stateless one', () => {
    const { stateful, stateless } = buildApp(new App(), { webBuildDir });

    expect(stateless.dependencies).toContain(stateful);
  });

  it('tags every stack with the project name', () => {
    const app = new App();
    buildApp(app, { webBuildDir });
    const assembly = app.synth();

    for (const stack of assembly.stacks) {
      expect(stack.tags).toMatchObject({ project: 'cloud-relay' });
    }
  });

  it('fails with a clear message when the web app has not been built', () => {
    expect(() => buildApp(new App(), { webBuildDir: '/nonexistent' })).toThrow(/npm run build/);
  });
});

describe('static site', () => {
  it('keeps the site bucket private and generates its name', () => {
    const { stateful } = synthTemplates();
    const siteBucket = logicalId(stateful, 'AWS::S3::Bucket', {
      CorsConfiguration: Match.absent(),
    });
    const props = stateful.toJSON().Resources[siteBucket].Properties;

    expect(props.BucketName).toBeUndefined();
    expect(props).toMatchObject({
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
    });
    // Its bucket policy lives in the stateless stack to avoid a circular dependency.
    expect(
      stateful.findResources('AWS::S3::BucketPolicy', {
        Properties: { Bucket: { Ref: siteBucket } },
      }),
    ).toEqual({});
  });

  it('lets only this distribution read the bucket, over HTTPS', () => {
    const { stateless } = synthTemplates();

    stateless.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    stateless.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'AllowCloudFrontRead',
            Effect: 'Allow',
            Principal: { Service: 'cloudfront.amazonaws.com' },
            Action: 's3:GetObject',
            Condition: { StringEquals: { 'AWS:SourceArn': Match.anyValue() } },
          }),
          Match.objectLike({
            Sid: 'DenyInsecureTransport',
            Effect: 'Deny',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      },
    });
  });

  it('serves over HTTPS with the SPA rewrite and no WAF', () => {
    const { stateless } = synthTemplates();

    stateless.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: 'index.html',
        WebACLId: Match.absent(), // WAF on CloudFront is unavailable on this account
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: 'redirect-to-https',
          FunctionAssociations: [Match.objectLike({ EventType: 'viewer-request' })],
        }),
      }),
    });
  });

  it('uploads hashed assets with a long cache and index.html with no-cache', () => {
    const { stateless } = synthTemplates();

    stateless.hasResourceProperties('Custom::CDKBucketDeployment', {
      DestinationBucketKeyPrefix: 'assets/',
      SystemMetadata: { 'cache-control': 'public, max-age=31536000, immutable' },
      Prune: false,
    });
    stateless.hasResourceProperties('Custom::CDKBucketDeployment', {
      SystemMetadata: { 'cache-control': 'no-cache' },
      DistributionPaths: ['/index.html'],
    });
  });
});

describe('uploads bucket', () => {
  it('is private, ACL-free and HTTPS-only, with a generated name', () => {
    const { stateful } = synthTemplates();
    const bucket = logicalId(stateful, 'AWS::S3::Bucket', { CorsConfiguration: Match.anyValue() });
    const props = stateful.toJSON().Resources[bucket].Properties;

    expect(props.BucketName).toBeUndefined();
    expect(props.VersioningConfiguration).toBeUndefined();
    expect(props).toMatchObject({
      PublicAccessBlockConfiguration: { BlockPublicPolicy: true, RestrictPublicBuckets: true },
      OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
        ],
      },
    });
    stateful.hasResourceProperties('AWS::S3::BucketPolicy', {
      Bucket: { Ref: bucket },
      PolicyDocument: {
        Statement: [
          Match.objectLike({
            Effect: 'Deny',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ],
      },
    });
  });

  it('allows browser POSTs from any origin (CORS)', () => {
    const { stateful } = synthTemplates();

    stateful.hasResourceProperties('AWS::S3::Bucket', {
      CorsConfiguration: {
        CorsRules: [{ AllowedMethods: ['POST'], AllowedOrigins: ['*'], MaxAge: 3000 }],
      },
    });
  });

  it('expires uploads/ and unfinished multipart uploads after a day', () => {
    const { stateful } = synthTemplates();

    stateful.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: [
          {
            Id: 'expire-uploads',
            Status: 'Enabled',
            Prefix: 'uploads/', // no leading slash, or the rule matches nothing
            ExpirationInDays: 1,
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
          },
        ],
      },
    });
  });

  it('is kept when the stack is deleted', () => {
    const { stateful } = synthTemplates();

    stateful.hasResource('AWS::S3::Bucket', {
      Properties: { CorsConfiguration: Match.anyValue() },
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
  });
});

describe('upload API', () => {
  const presignProps = { Description: Match.stringLikeRegexp('presigned S3 POST') };

  it('runs the presign Lambda on Node 24, arm64, 256 MB, 5 s, with 1-week logs', () => {
    const { stateless } = synthTemplates();

    stateless.hasResourceProperties('AWS::Lambda::Function', {
      ...presignProps,
      Runtime: 'nodejs24.x',
      Architectures: ['arm64'],
      MemorySize: 256,
      Timeout: 5,
      Environment: { Variables: Match.objectLike({ UPLOADS_BUCKET: Match.anyValue() }) },
      LoggingConfig: { LogGroup: Match.anyValue() },
    });
    stateless.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 7 });
  });

  it('gives the presign role only s3:PutObject on uploads/*, plus basic logging', () => {
    const { stateless } = synthTemplates();
    const resources = stateless.toJSON().Resources;
    const fn = logicalId(stateless, 'AWS::Lambda::Function', presignProps);
    const role = resources[fn].Properties.Role['Fn::GetAtt'][0] as string;

    const managed = resources[role].Properties.ManagedPolicyArns as unknown[];
    expect(managed).toHaveLength(1);
    expect(JSON.stringify(managed)).toContain('service-role/AWSLambdaBasicExecutionRole');

    const policies = stateless.findResources('AWS::IAM::Policy', {
      Properties: { Roles: [{ Ref: role }] },
    });
    const statements = Object.values(policies).flatMap(
      (p) => p.Properties.PolicyDocument.Statement as { Action: unknown; Resource: unknown }[],
    );
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatchObject({ Effect: 'Allow', Action: 's3:PutObject' });
    // Resource is the bucket ARN (imported from the stateful stack) + "/uploads/*".
    expect(JSON.stringify(statements[0]?.Resource)).toMatch(/"\/uploads\/\*"\]\]\}$/);
  });

  it('routes POST /api/uploads to the Lambda, with no CORS', () => {
    const { stateless } = synthTemplates();

    stateless.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      ProtocolType: 'HTTP',
      CorsConfiguration: Match.absent(),
    });
    stateless.resourceCountIs('AWS::ApiGatewayV2::Route', 1);
    stateless.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: 'POST /api/uploads' });
    stateless.hasResourceProperties('AWS::ApiGatewayV2::Integration', {
      IntegrationType: 'AWS_PROXY',
      PayloadFormatVersion: '2.0',
    });
  });

  it('throttles the $default stage to 1 request/s with a burst of 5', () => {
    const { stateless } = synthTemplates();

    stateless.resourceCountIs('AWS::ApiGatewayV2::Stage', 1);
    stateless.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      StageName: '$default',
      AutoDeploy: true,
      DefaultRouteSettings: { ThrottlingRateLimit: 1, ThrottlingBurstLimit: 5 },
    });
  });

  it('serves /api/* from API Gateway through CloudFront, uncached and without the SPA rewrite', () => {
    const { stateless } = synthTemplates();

    stateless.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        CacheBehaviors: [
          Match.objectLike({
            PathPattern: '/api/*',
            AllowedMethods: Match.arrayWith(['POST']),
            ViewerProtocolPolicy: 'https-only',
            CachePolicyId: cloudfront.CachePolicy.CACHING_DISABLED.cachePolicyId,
            OriginRequestPolicyId:
              cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER.originRequestPolicyId,
            FunctionAssociations: Match.absent(),
          }),
        ],
        Origins: Match.arrayWith([
          Match.objectLike({
            DomainName: Match.objectLike({
              'Fn::Join': ['', Match.arrayWith([Match.stringLikeRegexp('execute-api')])],
            }),
            CustomOriginConfig: Match.objectLike({ OriginProtocolPolicy: 'https-only' }),
          }),
        ]),
      }),
    });
  });
});
