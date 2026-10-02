import { fileURLToPath } from 'node:url';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../lib/app.ts';

const webBuildDir = fileURLToPath(new URL('./fixtures/site', import.meta.url));

function synthTemplates() {
  const { stateful, stateless } = buildApp(new App(), { webBuildDir });
  return {
    stateful: Template.fromStack(stateful),
    stateless: Template.fromStack(stateless),
  };
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

    stateful.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: Match.absent(),
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
    });
    // The bucket policy lives in the stateless stack to avoid a circular dependency.
    stateful.resourceCountIs('AWS::S3::BucketPolicy', 0);
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
