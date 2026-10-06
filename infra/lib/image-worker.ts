import { fileURLToPath } from 'node:url';
import { CfnOutput, RemovalPolicy } from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type * as sqs from 'aws-cdk-lib/aws-sqs';
import { PROCESSED_PREFIX, UPLOADS_PREFIX } from '@cloud-relay/shared';
import { Construct } from 'constructs';
import { WORKER_TIMEOUT } from './config.ts';

const WORKER_ENTRY = fileURLToPath(
  new URL('../../services/workers/src/worker.ts', import.meta.url),
);

/**
 * The account allows only 10 concurrent Lambda executions in total, so reserved
 * concurrency (which must leave 10 unreserved) is impossible. Capping the queue
 * trigger instead keeps the worker to 2 slots and leaves 8 for everything else.
 */
const WORKER_MAX_CONCURRENCY = 2;

export interface ImageWorkerProps {
  /** Where originals arrive (read, and delete when rejected). */
  uploadsBucket: s3.IBucket;
  /** Where resized images go (write, and delete when rejected). */
  processedBucket: s3.IBucket;
  /** The queue S3 notifies for every upload. */
  queue: sqs.IQueue;
  /** One record per upload (write only). */
  imagesTable: dynamodb.ITable;
  /** Daily Rekognition counters (update only). */
  usageTable: dynamodb.ITable;
}

/**
 * The SQS-triggered Lambda that runs the pipeline for each upload: resize with
 * sharp, moderate and label with Rekognition, save the record to DynamoDB.
 */
export class ImageWorker extends Construct {
  readonly function: nodejs.NodejsFunction;
  /** The worker's logs, where monitoring counts failed attempts. */
  readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: ImageWorkerProps) {
    super(scope, id);

    const logGroup = new logs.LogGroup(this, 'WorkerLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.logGroup = logGroup;

    this.function = new nodejs.NodejsFunction(this, 'WorkerFunction', {
      description:
        'Resizes each upload with sharp, analyzes it with Rekognition, saves it to DynamoDB',
      entry: WORKER_ENTRY,
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      // Lambda gives CPU in proportion to memory, and sharp is CPU-bound.
      memorySize: 1024,
      timeout: WORKER_TIMEOUT,
      logGroup,
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        PROCESSED_BUCKET: props.processedBucket.bucketName,
        // For ChangeMessageVisibility after a failed attempt.
        QUEUE_URL: props.queue.queueUrl,
        IMAGES_TABLE: props.imagesTable.tableName,
        USAGE_TABLE: props.usageTable.tableName,
      },
      bundling: {
        externalModules: [],
        minify: true,
        sourceMap: true,
        // sharp ships its native binary as a per-platform npm package, and
        // esbuild can't bundle .node files. `nodeModules` leaves sharp out of
        // the bundle and npm-installs it into the zip's node_modules instead,
        // at the version in package-lock.json.
        nodeModules: ['sharp'],
        // npm would install the binary for this machine (linux-x64). These npm
        // settings make it install the one for the function: Linux, arm64, glibc.
        environment: {
          npm_config_os: 'linux',
          npm_config_cpu: 'arm64',
          npm_config_libc: 'glibc',
        },
      },
    });

    // Least privilege: read originals, write outputs, and delete both when an
    // image is rejected. Nothing else in S3.
    // (`grantRead`/`grantPut` would add List*, GetBucket*, tagging and more.)
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:DeleteObject'],
        resources: [props.uploadsBucket.arnForObjects(`${UPLOADS_PREFIX}*`)],
      }),
    );
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject', 's3:DeleteObject'],
        resources: [props.processedBucket.arnForObjects(`${PROCESSED_PREFIX}*`)],
      }),
    );

    // Rekognition's Detect* actions analyze the bytes in the request and touch
    // no AWS resource, so IAM can't scope them: "*" is the only valid resource.
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['rekognition:DetectModerationLabels', 'rekognition:DetectLabels'],
        resources: ['*'],
      }),
    );

    // One action per table. (`grantWriteData` would add BatchWriteItem,
    // DeleteItem, UpdateItem and DescribeTable.)
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:PutItem'],
        resources: [props.imagesTable.tableArn],
      }),
    );
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:UpdateItem'],
        resources: [props.usageTable.tableArn],
      }),
    );

    // Lambda → Add trigger → SQS. Creates the event source mapping: Lambda polls
    // the queue, invokes the function, and deletes messages that succeeded. It
    // also grants the role the consume actions (ReceiveMessage, DeleteMessage,
    // ChangeMessageVisibility, GetQueueAttributes, GetQueueUrl) on this queue.
    this.function.addEventSource(
      new SqsEventSource(props.queue, {
        batchSize: 1, // one photo per invocation = one diagram run
        reportBatchItemFailures: true, // only messages listed as failed go back
        maxConcurrency: WORKER_MAX_CONCURRENCY,
      }),
    );

    new CfnOutput(this, 'WorkerFunctionName', { value: this.function.functionName });
  }
}
