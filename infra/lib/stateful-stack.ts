import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import {
  PROCESSED_PREFIX,
  UPLOADS_PREFIX,
  WORKER_MAX_ATTEMPTS,
  type ImageRecord,
} from '@cloud-relay/shared';
import type { Construct } from 'constructs';
import { WORKER_TIMEOUT } from './config.ts';

/**
 * Resources that hold data: S3 buckets, SQS queues, DynamoDB tables, the Aurora
 * cluster, the Cognito user pool.
 *
 * Kept separate so the stateless stack can be destroyed and redeployed freely
 * without any risk of replacing (and emptying) a bucket or table. Changes here
 * are rarer and deserve a careful `cdk diff` first.
 */
export class StatefulStack extends Stack {
  /** Private bucket for the built web app. Only CloudFront can read it. */
  readonly siteBucket: s3.Bucket;
  /** Private bucket that browsers upload originals to with a presigned POST. */
  readonly uploadsBucket: s3.Bucket;
  /** Private bucket for the worker's resized images. */
  readonly processedBucket: s3.Bucket;
  /** Receives an S3 notification for every new upload; the worker consumes it. */
  readonly uploadsQueue: sqs.Queue;
  /** Where SQS moves upload messages that failed WORKER_MAX_ATTEMPTS times. */
  readonly uploadsDeadLetterQueue: sqs.Queue;
  /** One item per processed upload, listed per session. */
  readonly imagesTable: dynamodb.Table;
  /** One counter per UTC day, for the daily Rekognition limit. */
  readonly usageTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // No bucketName: CDK generates a unique one, so no name (or account ID) lives in the repo.
    this.siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED, // "ACLs disabled"
      encryption: s3.BucketEncryption.S3_MANAGED, // SSE-S3
      // The bucket policy (OAC read access + HTTPS only) lives in the stateless
      // stack next to the distribution. See StaticSite for why.
      //
      // Kept on `cdk destroy`; empty and delete it by hand during teardown.
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Same defaults you checked on the create form: general purpose, global
    // namespace (generated name), ACLs disabled, all public access blocked,
    // versioning off (the default when `versioned` is omitted), SSE-S3.
    this.uploadsBucket = new s3.Bucket(this, 'UploadsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      encryption: s3.BucketEncryption.S3_MANAGED,
      // Adds a bucket policy that denies plain-HTTP requests. Nothing in the
      // stateless stack edits this bucket's policy, so it can live here.
      enforceSSL: true,
      // Permissions → CORS. Lets the page's JavaScript read S3's response to the
      // form POST. Any origin is fine: the signed policy is the real control.
      cors: [{ allowedMethods: [s3.HttpMethods.POST], allowedOrigins: ['*'], maxAge: 3000 }],
      // Management → lifecycle rule. Originals are temporary: S3 deletes them a
      // day after upload (at the next midnight UTC), and cleans up any multipart
      // upload left unfinished.
      lifecycleRules: [
        {
          id: 'expire-uploads',
          prefix: UPLOADS_PREFIX,
          expiration: Duration.days(1),
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
      ],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Same settings as the uploads bucket, minus CORS: browsers never write here.
    this.processedBucket = new s3.Bucket(this, 'ProcessedBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [
        { id: 'expire-processed', prefix: PROCESSED_PREFIX, expiration: Duration.days(1) },
      ],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // The "parking lot" for messages the worker couldn't process. Nothing consumes
    // it: you inspect it in the console and can redrive messages back later.
    // Retention counts from when the message first entered the source queue, so
    // it must be longer than the source queue's 1 day.
    //
    // No redrive allow policy (which source queues may use this DLQ): it would
    // have to name the source queue, whose redrive policy already names this
    // queue, and CloudFormation can't create two resources that reference each
    // other. The default allows queues in this account only.
    this.uploadsDeadLetterQueue = new sqs.Queue(this, 'UploadsDeadLetterQueue', {
      retentionPeriod: Duration.days(4),
      encryption: sqs.QueueEncryption.SQS_MANAGED, // SSE-SQS, free
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY, // messages expire anyway
    });

    // Same settings as the throwaway queue, at production values.
    this.uploadsQueue = new sqs.Queue(this, 'UploadsQueue', {
      // The lease: how long a received message stays hidden. Lambda refuses an
      // event source mapping whose function timeout is longer than this.
      visibilityTimeout: Duration.seconds(WORKER_TIMEOUT.toSeconds() * 6),
      retentionPeriod: Duration.days(1),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      // Redrive policy: after this many receives without a delete, move to the DLQ.
      deadLetterQueue: { queue: this.uploadsDeadLetterQueue, maxReceiveCount: WORKER_MAX_ATTEMPTS },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Properties → Event notifications: every object created under uploads/
    // sends a message to the queue. CDK also adds the queue policy that lets the
    // S3 service send to it for this bucket only (aws:SourceArn), like the one
    // you wrote in walkthrough 2.
    //
    // CloudFormation's own notification setting can't express this ordering
    // (S3 checks the queue policy at save time), so CDK manages it with a small
    // custom-resource Lambda that only runs during deploys.
    this.uploadsBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.SqsDestination(this.uploadsQueue),
      { prefix: UPLOADS_PREFIX },
    );
    // CDK's statement only checks the bucket ARN. Bucket names are global, so if
    // this bucket were ever deleted, another account could create one with the
    // same name. Pin the account too, as in walkthrough 2 ("confused deputy").
    this.uploadsQueue.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'DenyS3FromOtherAccounts',
        effect: iam.Effect.DENY,
        principals: [new iam.ServicePrincipal('s3.amazonaws.com')],
        actions: ['sqs:SendMessage'],
        resources: [this.uploadsQueue.queueArn],
        conditions: { StringNotEquals: { 'aws:SourceAccount': this.account } },
      }),
    );

    // Same table as the Phase 5 DynamoDB walkthrough. Only the key attributes are declared; every
    // other attribute (see ImageRecord) is schemaless and set per item.
    // Access patterns: Query by sessionId for a session's gallery (run IDs are
    // UUIDv7s, so the sort key orders them by upload time), GetItem for one run.
    this.imagesTable = new dynamodb.Table(this, 'ImagesTable', {
      partitionKey: {
        name: 'sessionId' satisfies keyof ImageRecord,
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: { name: 'runId' satisfies keyof ImageRecord, type: dynamodb.AttributeType.STRING },
      // On-demand: billed per request, nothing when idle, no capacity to plan.
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // Additional settings → Time to Live. DynamoDB deletes each item a while
      // after its expiresAt (Unix seconds), for free.
      timeToLiveAttribute: 'expiresAt' satisfies keyof ImageRecord,
      // Records expire after a day, so there is nothing worth keeping (or
      // backing up with point-in-time recovery, which stays off).
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Its own small table rather than special items in the Images table: a
    // different key (the day), and the worker may only update counters here.
    this.usageTable = new dynamodb.Table(this, 'UsageTable', {
      partitionKey: { name: 'day', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: RemovalPolicy.DESTROY,
    });
  }
}
