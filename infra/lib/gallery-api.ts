import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { GALLERY_ROUTE_PATH } from '@cloud-relay/shared';
import { Construct } from 'constructs';

const GALLERY_ENTRY = fileURLToPath(new URL('../../services/api/src/gallery.ts', import.meta.url));

export interface GalleryApiProps {
  /** The HTTP API that already serves POST /api/uploads. */
  httpApi: apigwv2.HttpApi;
  /** One record per upload (from the stateful stack). Read only. */
  imagesTable: dynamodb.ITable;
}

/**
 * `GET /api/sessions/{sessionId}/images`: a route on the existing HTTP API
 * that invokes its own read-only Lambda, which Queries the Images table.
 */
export class GalleryApi extends Construct {
  readonly function: nodejs.NodejsFunction;

  constructor(scope: Construct, id: string, props: GalleryApiProps) {
    super(scope, id);

    const logGroup = new logs.LogGroup(this, 'GalleryLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.function = new nodejs.NodejsFunction(this, 'GalleryFunction', {
      description: "Lists a session's newest images from DynamoDB",
      entry: GALLERY_ENTRY,
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      // One Query: a warm call takes tens of milliseconds, a cold one about a second.
      memorySize: 256,
      timeout: Duration.seconds(3),
      logGroup,
      environment: { IMAGES_TABLE: props.imagesTable.tableName },
      bundling: { externalModules: [], minify: true, sourceMap: true },
    });

    // Its own role, allowed one action on one table. (`grantReadData` would add
    // GetItem, Scan, BatchGetItem, ConditionCheckItem and DescribeTable.)
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:Query'],
        resources: [props.imagesTable.tableArn],
      }),
    );

    // Routes → GET /api/sessions/{sessionId}/images. The route inherits the
    // stage's default throttling (1/s, burst 5), which applies to each route
    // separately, so it doesn't eat into the upload route's budget.
    props.httpApi.addRoutes({
      path: GALLERY_ROUTE_PATH,
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration('GalleryIntegration', this.function),
    });

    new CfnOutput(this, 'GalleryFunctionName', { value: this.function.functionName });
  }
}
