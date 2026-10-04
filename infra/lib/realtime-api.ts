import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { WebSocketLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { WEBSOCKET_STAGE } from '@cloud-relay/shared';
import { Construct } from 'constructs';

const CONNECT_ENTRY = fileURLToPath(
  new URL('../../services/realtime/src/connect.ts', import.meta.url),
);

export interface RealtimeApiProps {
  /** Session → connection IDs (from the stateful stack). */
  connectionsTable: dynamodb.ITable;
}

/**
 * The WebSocket API that pushes step events to browsers.
 *
 * The browser connects to `wss://<site>/ws?sessionId=…` and never sends
 * anything; the $connect Lambda records the connection. Lambdas that emit step
 * events (see `grantEmit`) look the session's connections up and POST to each
 * one through the stage's @connections endpoint.
 */
export class RealtimeApi extends Construct {
  readonly api: apigwv2.WebSocketApi;
  readonly stage: apigwv2.WebSocketStage;
  /** execute-api hostname, used as the CloudFront origin. */
  readonly domainName: string;
  private readonly connectionsTable: dynamodb.ITable;

  constructor(scope: Construct, id: string, props: RealtimeApiProps) {
    super(scope, id);
    this.connectionsTable = props.connectionsTable;

    const logGroup = new logs.LogGroup(this, 'ConnectLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const connect = new nodejs.NodejsFunction(this, 'ConnectFunction', {
      description: 'Records each WebSocket connection under its session ID',
      entry: CONNECT_ENTRY,
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      // One validation and one PutItem: the smallest settings that start quickly.
      memorySize: 256,
      timeout: Duration.seconds(3),
      logGroup,
      environment: { CONNECTIONS_TABLE: props.connectionsTable.tableName },
      bundling: { externalModules: [], minify: true, sourceMap: true },
    });
    // One action on one table. (`grantWriteData` would add batch writes,
    // updates, deletes and DescribeTable.)
    connect.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:PutItem'],
        resources: [props.connectionsTable.tableArn],
      }),
    );

    // Create API → WebSocket API. The route selection expression (the default,
    // $request.body.action) only matters for messages, and the browser sends
    // none, so the only route is $connect. CDK also adds the resource-based
    // policy that lets this API invoke the function.
    this.api = new apigwv2.WebSocketApi(this, 'WebSocketApi', {
      description: 'Cloud Relay WebSocket API: pushes step events to browsers',
    });
    const connectRoute = this.api.addRoute('$connect', {
      integration: new WebSocketLambdaIntegration('ConnectIntegration', connect),
    });

    // Stages → ws. The stage name is the URL path, so CloudFront can forward
    // the site's /ws to it unchanged.
    this.stage = new apigwv2.WebSocketStage(this, 'Stage', {
      webSocketApi: this.api,
      stageName: WEBSOCKET_STAGE,
      autoDeploy: true,
      // Default route throttling, which also limits our Lambdas' @connections
      // POSTs (at 1/s it dropped step events: one upload sends ~14 in 2 s).
      // High enough for the pipeline, low enough to cap a flood of pushes to
      // many tabs at ~$0.36/hour of messages. Always set explicitly: removing
      // it from the template leaves the old value on the stage.
      throttle: { rateLimit: 100, burstLimit: 200 },
    });

    // Stages → ws → Route settings → $connect: throttle connects much harder,
    // so they leave room in the account's 10 concurrent Lambdas for the worker
    // (2) and the presign API (burst 5). Best-effort: a burst of 10 still got
    // through. CDK's stage construct has no per-route setting, so set the
    // CloudFormation property directly. The route must exist first.
    const cfnStage = this.stage.node.defaultChild as apigwv2.CfnStage;
    cfnStage.routeSettings = {
      [connectRoute.routeKey]: { ThrottlingRateLimit: 1, ThrottlingBurstLimit: 3 },
    };
    cfnStage.node.addDependency(connectRoute);

    const stack = Stack.of(this);
    this.domainName = `${this.api.apiId}.execute-api.${stack.region}.${stack.urlSuffix}`;

    new CfnOutput(this, 'WebSocketUrl', { value: this.stage.url });
    new CfnOutput(this, 'CallbackUrl', { value: this.stage.callbackUrl });
    new CfnOutput(this, 'ConnectFunctionName', { value: connect.functionName });
  }

  /**
   * Lets a Lambda push step events with `emit()` from @cloud-relay/realtime:
   * where to post (the stage's @connections URL), where to find the session's
   * connections, and the IAM permissions for both.
   */
  grantEmit(fn: lambda.Function): void {
    fn.addEnvironment('CONNECTIONS_TABLE', this.connectionsTable.tableName);
    fn.addEnvironment('WEBSOCKET_CALLBACK_URL', this.stage.callbackUrl);
    // execute-api:ManageConnections on this stage's @connections endpoint.
    this.stage.grantManagementApiAccess(fn);
    // Query the session's rows; delete the ones whose connection is gone.
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:Query', 'dynamodb:DeleteItem'],
        resources: [this.connectionsTable.tableArn],
      }),
    );
  }
}
