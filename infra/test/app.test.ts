import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../lib/app.ts';

const webBuildDir = fileURLToPath(new URL('./fixtures/site', import.meta.url));

// Synthesizing bundles the Lambdas with esbuild (and npm-installs sharp), so do
// it once for all tests.
let templates: { stateful: Template; stateless: Template; assemblyDir: string } | undefined;
function synthTemplates() {
  if (!templates) {
    const app = new App();
    const { stateful, stateless } = buildApp(app, { webBuildDir });
    templates = {
      stateful: Template.fromStack(stateful),
      stateless: Template.fromStack(stateless),
      assemblyDir: app.synth().directory,
    };
  }
  return templates;
}

/** Every IAM statement attached to the role of the one function matching `props`. */
function roleStatements(template: Template, props: object) {
  const resources = template.toJSON().Resources;
  const fn = logicalId(template, 'AWS::Lambda::Function', props);
  const role = resources[fn].Properties.Role['Fn::GetAtt'][0] as string;
  const policies = template.findResources('AWS::IAM::Policy', {
    Properties: { Roles: [{ Ref: role }] },
  });
  return {
    managed: resources[role].Properties.ManagedPolicyArns as unknown[],
    statements: Object.values(policies).flatMap(
      (p) => p.Properties.PolicyDocument.Statement as { Action: unknown; Resource: unknown }[],
    ),
  };
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
      LifecycleConfiguration: Match.absent(),
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

  it('gives the presign role s3:PutObject on uploads/* and the emit permissions, plus basic logging', () => {
    const { stateless } = synthTemplates();
    const { managed, statements } = roleStatements(stateless, presignProps);

    expect(managed).toHaveLength(1);
    expect(JSON.stringify(managed)).toContain('service-role/AWSLambdaBasicExecutionRole');
    expect(statements.map((s) => s.Action)).toEqual([
      's3:PutObject',
      'execute-api:ManageConnections',
      ['dynamodb:Query', 'dynamodb:DeleteItem'],
    ]);
    // Resource is the bucket ARN (imported from the stateful stack) + "/uploads/*".
    expect(JSON.stringify(statements[0]?.Resource)).toMatch(/"\/uploads\/\*"\]\]\}$/);
  });

  it('routes POST /api/uploads to the Lambda, with no CORS', () => {
    const { stateless } = synthTemplates();

    stateless.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      ProtocolType: 'HTTP',
      CorsConfiguration: Match.absent(),
    });
    stateless.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: 'POST /api/uploads' });
    stateless.hasResourceProperties('AWS::ApiGatewayV2::Integration', {
      IntegrationType: 'AWS_PROXY',
      PayloadFormatVersion: '2.0',
    });
  });

  it('throttles the $default stage to 1 request/s with a burst of 5', () => {
    const { stateless } = synthTemplates();

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
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({
            PathPattern: '/api/*',
            AllowedMethods: Match.arrayWith(['POST']),
            ViewerProtocolPolicy: 'https-only',
            CachePolicyId: cloudfront.CachePolicy.CACHING_DISABLED.cachePolicyId,
            OriginRequestPolicyId:
              cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER.originRequestPolicyId,
            FunctionAssociations: Match.absent(),
          }),
        ]),
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

describe('async pipeline: buckets and queues', () => {
  it('keeps processed images in a private bucket for a day', () => {
    const { stateful } = synthTemplates();

    stateful.hasResource('AWS::S3::Bucket', {
      Properties: {
        CorsConfiguration: Match.absent(),
        PublicAccessBlockConfiguration: Match.objectLike({ RestrictPublicBuckets: true }),
        OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
        LifecycleConfiguration: {
          Rules: [
            {
              Id: 'expire-processed',
              Status: 'Enabled',
              Prefix: 'processed/',
              ExpirationInDays: 1,
            },
          ],
        },
      },
      DeletionPolicy: 'Retain',
    });
  });

  it('gives the uploads queue a 60 s lease (6 × the worker timeout), 1-day retention and a DLQ after 5 receives', () => {
    const { stateful } = synthTemplates();
    const dlq = logicalId(stateful, 'AWS::SQS::Queue', { RedrivePolicy: Match.absent() });

    stateful.hasResourceProperties('AWS::SQS::Queue', {
      VisibilityTimeout: 60,
      MessageRetentionPeriod: 86400,
      SqsManagedSseEnabled: true,
      RedrivePolicy: { deadLetterTargetArn: { 'Fn::GetAtt': [dlq, 'Arn'] }, maxReceiveCount: 5 },
    });
    // Longer than the source queue: retention counts from the original enqueue time.
    stateful.hasResourceProperties('AWS::SQS::Queue', {
      MessageRetentionPeriod: 345600,
      SqsManagedSseEnabled: true,
      RedrivePolicy: Match.absent(),
    });
  });

  it('notifies the queue for objects created under uploads/ only', () => {
    const { stateful } = synthTemplates();

    stateful.hasResourceProperties('Custom::S3BucketNotifications', {
      NotificationConfiguration: {
        QueueConfigurations: [
          {
            Events: ['s3:ObjectCreated:*'],
            Filter: { Key: { FilterRules: [{ Name: 'prefix', Value: 'uploads/' }] } },
            QueueArn: Match.anyValue(),
          },
        ],
      },
    });
  });

  it('lets only S3, for the uploads bucket in this account, send to the queue, over HTTPS', () => {
    const { stateful } = synthTemplates();
    const uploadsBucket = logicalId(stateful, 'AWS::S3::Bucket', {
      CorsConfiguration: Match.anyValue(),
    });

    stateful.hasResourceProperties('AWS::SQS::QueuePolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
          Match.objectLike({
            Effect: 'Allow',
            Principal: { Service: 's3.amazonaws.com' },
            Action: Match.arrayWith(['sqs:SendMessage']),
            Condition: { ArnLike: { 'aws:SourceArn': { 'Fn::GetAtt': [uploadsBucket, 'Arn'] } } },
          }),
          Match.objectLike({
            Sid: 'DenyS3FromOtherAccounts',
            Effect: 'Deny',
            Principal: { Service: 's3.amazonaws.com' },
            Condition: { StringNotEquals: { 'aws:SourceAccount': { Ref: 'AWS::AccountId' } } },
          }),
        ]),
      },
    });
  });
});

describe('async pipeline: worker', () => {
  const workerProps = { Description: Match.stringLikeRegexp('sharp') };

  it('runs on Node 24, arm64, 1024 MB, with a 10 s timeout and 1-week logs', () => {
    const { stateless } = synthTemplates();

    stateless.hasResourceProperties('AWS::Lambda::Function', {
      ...workerProps,
      Runtime: 'nodejs24.x',
      Architectures: ['arm64'],
      MemorySize: 1024,
      Timeout: 10,
      Environment: {
        Variables: Match.objectLike({
          PROCESSED_BUCKET: Match.anyValue(),
          QUEUE_URL: Match.anyValue(),
          IMAGES_TABLE: Match.anyValue(),
          USAGE_TABLE: Match.anyValue(),
        }),
      },
      LoggingConfig: { LogGroup: Match.anyValue() },
    });
  });

  it('is triggered by the queue one message at a time, with partial batch failures and at most 2 copies', () => {
    const { stateless } = synthTemplates();

    stateless.resourceCountIs('AWS::Lambda::EventSourceMapping', 1);
    stateless.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 1,
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      ScalingConfig: { MaximumConcurrency: 2 },
    });
    // The account's concurrency limit (10) leaves no room for reserved concurrency.
    stateless.hasResourceProperties('AWS::Lambda::Function', {
      ...workerProps,
      ReservedConcurrentExecutions: Match.absent(),
    });
  });

  it('may only use its objects, the two Rekognition calls, one action per table and the queue', () => {
    const { stateless } = synthTemplates();
    const { managed, statements } = roleStatements(stateless, workerProps);

    expect(managed).toHaveLength(1);
    expect(JSON.stringify(managed)).toContain('service-role/AWSLambdaBasicExecutionRole');
    const actions = statements.map((s) => (Array.isArray(s.Action) ? s.Action.sort() : s.Action));
    expect(actions).toEqual([
      ['s3:DeleteObject', 's3:GetObject'],
      ['s3:DeleteObject', 's3:PutObject'],
      ['rekognition:DetectLabels', 'rekognition:DetectModerationLabels'],
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
      [
        'sqs:ChangeMessageVisibility',
        'sqs:DeleteMessage',
        'sqs:GetQueueAttributes',
        'sqs:GetQueueUrl',
        'sqs:ReceiveMessage',
      ],
      'execute-api:ManageConnections',
      ['dynamodb:DeleteItem', 'dynamodb:Query'],
    ]);
    const resources = statements.map((s) => JSON.stringify(s.Resource));
    expect(resources[0]).toMatch(/"\/uploads\/\*"\]\]\}$/);
    expect(resources[1]).toMatch(/"\/processed\/\*"\]\]\}$/);
    // Detect* can't be scoped to a resource; nothing else may use "*".
    expect(resources.filter((r) => r === '"*"')).toEqual([resources[2]]);
    expect(resources[3]).toMatch(/ImagesTable/);
    expect(resources[4]).toMatch(/UsageTable/);
    expect(resources[7]).toMatch(/ConnectionsTable/);
  });

  it('bundles the linux-arm64 (glibc) build of sharp and no other platform', () => {
    const { assemblyDir } = synthTemplates();
    const withSharp = readdirSync(assemblyDir).filter((name) =>
      existsSync(join(assemblyDir, name, 'node_modules', 'sharp')),
    );
    expect(withSharp).toHaveLength(1);

    const platforms = readdirSync(
      join(assemblyDir, withSharp[0] as string, 'node_modules', '@img'),
    );
    expect(platforms).toEqual(
      expect.arrayContaining(['sharp-linux-arm64', 'sharp-libvips-linux-arm64']),
    );
    expect(platforms.filter((name) => /x64|musl|darwin|win32|wasm/.test(name))).toEqual([]);
  });
});

describe('image records', () => {
  it('keys images by session and run, on demand, with TTL on expiresAt', () => {
    const { stateful } = synthTemplates();

    stateful.hasResource('AWS::DynamoDB::Table', {
      Properties: {
        KeySchema: [
          { AttributeName: 'sessionId', KeyType: 'HASH' },
          { AttributeName: 'runId', KeyType: 'RANGE' },
        ],
        AttributeDefinitions: [
          { AttributeName: 'sessionId', AttributeType: 'S' },
          { AttributeName: 'runId', AttributeType: 'S' },
        ],
        BillingMode: 'PAY_PER_REQUEST',
        TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
        GlobalSecondaryIndexes: Match.absent(),
        PointInTimeRecoverySpecification: Match.absent(),
      },
      // The data expires within a day anyway.
      DeletionPolicy: 'Delete',
    });
  });

  it('keeps one usage counter per day, with TTL', () => {
    const { stateful } = synthTemplates();

    stateful.resourceCountIs('AWS::DynamoDB::Table', 3);
    stateful.hasResource('AWS::DynamoDB::Table', {
      Properties: {
        KeySchema: [{ AttributeName: 'day', KeyType: 'HASH' }],
        BillingMode: 'PAY_PER_REQUEST',
        TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
      },
      DeletionPolicy: 'Delete',
    });
  });
});

describe('real time: WebSocket API', () => {
  const connectProps = { Description: Match.stringLikeRegexp('WebSocket connection') };

  it('keys connections by session and connection ID, on demand, with TTL on expiresAt', () => {
    const { stateful } = synthTemplates();

    stateful.hasResource('AWS::DynamoDB::Table', {
      Properties: {
        KeySchema: [
          { AttributeName: 'sessionId', KeyType: 'HASH' },
          { AttributeName: 'connectionId', KeyType: 'RANGE' },
        ],
        BillingMode: 'PAY_PER_REQUEST',
        TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
        GlobalSecondaryIndexes: Match.absent(),
      },
      DeletionPolicy: 'Delete',
    });
  });

  it('has only a $connect route (no $disconnect, no message routes)', () => {
    const { stateless } = synthTemplates();
    const api = logicalId(stateless, 'AWS::ApiGatewayV2::Api', { ProtocolType: 'WEBSOCKET' });
    const routes = stateless.findResources('AWS::ApiGatewayV2::Route', {
      Properties: { ApiId: { Ref: api } },
    });

    expect(Object.values(routes).map((r) => r.Properties.RouteKey)).toEqual(['$connect']);
    stateless.hasResourceProperties('AWS::ApiGatewayV2::Integration', {
      ApiId: { Ref: api },
      IntegrationType: 'AWS_PROXY',
    });
  });

  it('deploys the "ws" stage: $connect throttled to 1/s (burst 3), @connections posts to 100/s', () => {
    const { stateless } = synthTemplates();
    const api = logicalId(stateless, 'AWS::ApiGatewayV2::Api', { ProtocolType: 'WEBSOCKET' });

    stateless.hasResource('AWS::ApiGatewayV2::Stage', {
      Properties: {
        ApiId: { Ref: api },
        StageName: 'ws',
        AutoDeploy: true,
        // The default also limits PostToConnection (429s at 1/s), and must be
        // explicit: removing it from the template leaves the old value.
        DefaultRouteSettings: { ThrottlingRateLimit: 100, ThrottlingBurstLimit: 200 },
        RouteSettings: { $connect: { ThrottlingRateLimit: 1, ThrottlingBurstLimit: 3 } },
      },
      // Route settings name a route that must already exist.
      DependsOn: Match.arrayWith([Match.stringLikeRegexp('connectRoute')]),
    });
  });

  it('runs the $connect Lambda on Node 24, arm64, 256 MB, 3 s, allowed only to PutItem', () => {
    const { stateless } = synthTemplates();

    stateless.hasResourceProperties('AWS::Lambda::Function', {
      ...connectProps,
      Runtime: 'nodejs24.x',
      Architectures: ['arm64'],
      MemorySize: 256,
      Timeout: 3,
      Environment: { Variables: { CONNECTIONS_TABLE: Match.anyValue() } },
      LoggingConfig: { LogGroup: Match.anyValue() },
    });
    const { statements } = roleStatements(stateless, connectProps);
    expect(statements.map((s) => s.Action)).toEqual(['dynamodb:PutItem']);
    expect(JSON.stringify(statements[0]?.Resource)).toMatch(/ConnectionsTable/);
  });

  it("lets presign and the worker post only to this stage's @connections", () => {
    const { stateless } = synthTemplates();

    for (const props of [
      { Description: Match.stringLikeRegexp('presigned S3 POST') },
      { Description: Match.stringLikeRegexp('sharp') },
    ]) {
      stateless.hasResourceProperties('AWS::Lambda::Function', {
        ...props,
        Environment: {
          Variables: Match.objectLike({
            CONNECTIONS_TABLE: Match.anyValue(),
            WEBSOCKET_CALLBACK_URL: Match.anyValue(),
          }),
        },
      });
      const manage = roleStatements(stateless, props).statements.find(
        (s) => s.Action === 'execute-api:ManageConnections',
      );
      expect(JSON.stringify(manage?.Resource)).toMatch(/"\/ws\/\*\/@connections\/\*"\]\]\}$/);
    }
  });

  it('serves /ws from the WebSocket API through CloudFront, uncached, forwarding the handshake headers', () => {
    const { stateless } = synthTemplates();

    stateless.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({
            PathPattern: '/ws',
            AllowedMethods: ['GET', 'HEAD'],
            ViewerProtocolPolicy: 'https-only',
            CachePolicyId: cloudfront.CachePolicy.CACHING_DISABLED.cachePolicyId,
            OriginRequestPolicyId:
              cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER.originRequestPolicyId,
            FunctionAssociations: Match.absent(),
          }),
        ]),
      }),
    });
  });
});
