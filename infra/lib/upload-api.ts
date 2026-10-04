import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import { UPLOADS_PREFIX } from '@cloud-relay/shared';
import { Construct } from 'constructs';

const PRESIGN_ENTRY = fileURLToPath(new URL('../../services/api/src/presign.ts', import.meta.url));

export interface UploadApiProps {
  /** Bucket (from the stateful stack) that browsers upload originals to. */
  uploadsBucket: s3.IBucket;
}

/**
 * `POST /api/uploads`: an HTTP API that invokes the presign Lambda, which
 * returns a presigned POST so the browser can upload straight to S3.
 */
export class UploadApi extends Construct {
  readonly httpApi: apigwv2.HttpApi;
  readonly presignFunction: nodejs.NodejsFunction;
  /** execute-api hostname, used as the CloudFront origin. */
  readonly domainName: string;

  constructor(scope: Construct, id: string, props: UploadApiProps) {
    super(scope, id);

    // Lambda logs to /aws/lambda/<name> by default, kept forever. An explicit
    // log group lets us set retention (and delete it with the stack).
    const logGroup = new logs.LogGroup(this, 'PresignLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // NodejsFunction bundles the TypeScript entry with esbuild at synth time,
    // so the zip holds one index.js instead of a node_modules folder.
    const presign = new nodejs.NodejsFunction(this, 'PresignFunction', {
      description: 'Returns a presigned S3 POST for one photo upload',
      entry: PRESIGN_ENTRY,
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64, // Graviton: about 20% cheaper per GB-second than x86
      memorySize: 256,
      timeout: Duration.seconds(5),
      logGroup,
      environment: { UPLOADS_BUCKET: props.uploadsBucket.bucketName },
      bundling: {
        // The Node.js runtime ships an AWS SDK, but not necessarily the
        // presigned-post helper, and its version changes without notice.
        // Bundling everything pins the versions in package-lock.json.
        externalModules: [],
        minify: true,
        sourceMap: true, // also sets NODE_OPTIONS=--enable-source-maps for readable stack traces
      },
    });
    this.presignFunction = presign;

    // The execution role CDK created for this function (one role per function)
    // already has AWSLambdaBasicExecutionRole for logs. Signing a POST needs
    // exactly one more action. `grantPut` would add five extras (tagging,
    // retention, legal hold, abort multipart) that this function never uses.
    presign.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject'],
        resources: [props.uploadsBucket.arnForObjects(`${UPLOADS_PREFIX}*`)],
      }),
    );

    // An HTTP API (API Gateway v2): cheaper and simpler than a REST API.
    // No CORS: the browser calls it on the site's own domain through CloudFront.
    this.httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      description: 'Cloud Relay HTTP API',
      // HttpApi's built-in $default stage can't take throttle settings,
      // so we create that stage ourselves below.
      createDefaultStage: false,
    });

    // Stages → $default, auto-deploy on, default route throttling. Throttling is
    // a best-effort token bucket: `burstLimit` requests at once, refilled at
    // `rateLimit` per second, across all callers. Excess requests get 429.
    new apigwv2.HttpStage(this, 'DefaultStage', {
      httpApi: this.httpApi,
      stageName: '$default',
      autoDeploy: true,
      throttle: { rateLimit: 1, burstLimit: 5 },
    });

    // Routes → POST /api/uploads, with a Lambda integration (payload format 2.0).
    // This also adds a resource-based policy on the function so that this API,
    // and only this route, may invoke it.
    this.httpApi.addRoutes({
      path: '/api/uploads',
      methods: [apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration('PresignIntegration', presign),
    });

    const stack = Stack.of(this);
    this.domainName = `${this.httpApi.apiId}.execute-api.${stack.region}.${stack.urlSuffix}`;

    new CfnOutput(this, 'ApiEndpoint', { value: this.httpApi.apiEndpoint });
    new CfnOutput(this, 'PresignFunctionName', { value: presign.functionName });
  }
}
