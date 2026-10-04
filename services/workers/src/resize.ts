import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ChangeMessageVisibilityCommand, SQSClient } from '@aws-sdk/client-sqs';
import {
  RETRY_DELAY_SECONDS,
  SIMULATE_FAILURE_METADATA,
  STEP_SERVICE,
  WORKER_MAX_ATTEMPTS,
  parseUploadKey,
  processedKey,
} from '@cloud-relay/shared';
import type {
  Context,
  SQSBatchItemFailure,
  SQSBatchResponse,
  SQSEvent,
  SQSRecord,
} from 'aws-lambda';
import { emit } from './emit.ts';
import { renderVariants } from './images.ts';
import { parseS3Notification, type UploadedObject } from './s3-event.ts';

// Created once per execution environment and reused by warm invocations.
const s3 = new S3Client({});
const sqs = new SQSClient({});

/** Thrown when the upload asked to fail (the "Simulate failure" checkbox). */
export class SimulatedFailure extends Error {
  constructor() {
    super('Simulated failure (requested at upload)');
    this.name = 'SimulatedFailure';
  }
}

/**
 * Invoked by the SQS event source mapping with a batch of messages, each one an
 * S3 "object created" notification for an upload.
 *
 * Lambda deletes every message in the batch when the function returns, except
 * the ones listed in `batchItemFailures` ("partial batch response"). Those stay
 * in the queue, become visible again when their visibility timeout ends, and
 * after WORKER_MAX_ATTEMPTS receives SQS moves them to the dead-letter queue.
 */
export async function handler(event: SQSEvent, context: Context): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchItemFailure[] = [];

  // The mapping uses batch size 1, but the loop keeps this correct for any size.
  for (const record of event.Records) {
    try {
      await processMessage(record, context);
    } catch (error) {
      console.error(
        JSON.stringify({
          message: 'Attempt failed',
          messageId: record.messageId,
          error: errorMessage(error),
        }),
      );
      batchItemFailures.push({ itemIdentifier: record.messageId });
      await retrySoon(record);
    }
  }

  return { batchItemFailures };
}

async function processMessage(record: SQSRecord, context: Context): Promise<void> {
  const uploads = parseS3Notification(record.body);
  if (uploads.length === 0) {
    console.log(JSON.stringify({ message: 'Skipping S3 test event' }));
    return;
  }
  for (const upload of uploads) await processUpload(upload, record, context);
}

async function processUpload(upload: UploadedObject, record: SQSRecord, context: Context) {
  const ids = parseUploadKey(upload.key);
  if (!ids) {
    // Retrying can't fix a key the presign Lambda didn't create, so don't fail.
    console.warn(JSON.stringify({ message: 'Skipping unexpected key', key: upload.key }));
    return;
  }

  // 1 on the first delivery, 2 on the first retry, and so on.
  const attempt = Number(record.attributes.ApproximateReceiveCount);

  // enqueue: S3 sent the notification and SQS held it until this receive.
  // AWS did that work, so there is no log line to link to.
  const sentAt = Number(record.attributes.SentTimestamp);
  await emit({
    ...ids,
    step: 'enqueue',
    service: STEP_SERVICE.enqueue,
    status: 'succeeded',
    startedAt: new Date(sentAt).toISOString(),
    durationMs: Math.max(0, Date.now() - sentAt),
    detail: { attempt, maxAttempts: WORKER_MAX_ATTEMPTS },
    logRef: null,
  });

  const started = Date.now();
  const resize = {
    ...ids,
    step: 'resize',
    service: STEP_SERVICE.resize,
    startedAt: new Date(started).toISOString(),
    logRef: { logGroup: context.logGroupName, requestId: context.awsRequestId },
  } as const;
  await emit({ ...resize, status: 'started', durationMs: null, detail: { attempt } });

  try {
    const original = await s3.send(
      new GetObjectCommand({ Bucket: upload.bucket, Key: upload.key }),
    );
    // User metadata comes back without the x-amz-meta- prefix.
    if (original.Metadata?.[SIMULATE_FAILURE_METADATA] === 'true') throw new SimulatedFailure();
    if (!original.Body) throw new Error(`Empty body for ${upload.key}`);

    const variants = await renderVariants(await original.Body.transformToByteArray());
    await Promise.all(
      variants.map((image) =>
        s3.send(
          new PutObjectCommand({
            Bucket: requiredEnv('PROCESSED_BUCKET'),
            Key: processedKey(ids.sessionId, ids.runId, image.variant),
            Body: image.body,
            ContentType: 'image/webp',
            // Each run writes new keys, so the files never change once written.
            CacheControl: 'public, max-age=31536000, immutable',
          }),
        ),
      ),
    );

    await emit({
      ...resize,
      status: 'succeeded',
      durationMs: Date.now() - started,
      detail: {
        attempt,
        format: 'webp',
        inputBytes: upload.size,
        outputBytes: variants.reduce((sum, image) => sum + image.bytes, 0),
        ...Object.fromEntries(variants.map((i) => [i.variant, `${i.width}×${i.height}`])),
      },
    });
  } catch (error) {
    await emit({
      ...resize,
      status: 'failed',
      durationMs: Date.now() - started,
      detail: {
        attempt,
        maxAttempts: WORKER_MAX_ATTEMPTS,
        error: errorMessage(error),
        // After the last attempt SQS moves the message on its next receive.
        next:
          attempt >= WORKER_MAX_ATTEMPTS
            ? 'dead-letter queue'
            : `retry in ${RETRY_DELAY_SECONDS} s`,
      },
    });
    throw error;
  }
}

/**
 * A failed message would normally wait out the queue's full visibility timeout
 * (60 s) before SQS hands it out again. Shortening it to a few seconds makes the
 * retries quick enough to watch.
 */
async function retrySoon(record: SQSRecord): Promise<void> {
  try {
    await sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: requiredEnv('QUEUE_URL'),
        ReceiptHandle: record.receiptHandle,
        VisibilityTimeout: RETRY_DELAY_SECONDS,
      }),
    );
  } catch (error) {
    // Not fatal: the message is still retried, just after the full timeout.
    console.warn(
      JSON.stringify({ message: 'Could not shorten visibility', error: errorMessage(error) }),
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}
