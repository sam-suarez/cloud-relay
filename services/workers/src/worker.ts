import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ChangeMessageVisibilityCommand, SQSClient } from '@aws-sdk/client-sqs';
import {
  DAILY_ANALYSIS_LIMIT,
  IMAGE_VARIANTS,
  RETRY_DELAY_SECONDS,
  SIMULATE_FAILURE_METADATA,
  STEP_SERVICE,
  WORKER_MAX_ATTEMPTS,
  imageExpiresAt,
  parseUploadKey,
  processedKey,
  type ImageFile,
  type ImageRecord,
  type ImageVariant,
  type LogRef,
  type Rejection,
  type Step,
  type StepDetail,
} from '@cloud-relay/shared';
import type {
  Context,
  SQSBatchItemFailure,
  SQSBatchResponse,
  SQSEvent,
  SQSRecord,
} from 'aws-lambda';
import {
  LABEL_MIN_CONFIDENCE,
  MODERATION_MIN_CONFIDENCE,
  detectLabels,
  moderate,
} from './analysis.ts';
import { emit } from './emit.ts';
import { requiredEnv } from './env.ts';
import { renderImages } from './images.ts';
import { putImageRecord, reserveAnalysis } from './records.ts';
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

/** Who this attempt is for, attached to every step event it emits. */
interface Run {
  sessionId: string;
  runId: string;
  /** 1 on the first delivery, 2 on the first retry, and so on. */
  attempt: number;
  logRef: LogRef;
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

/**
 * resize → moderate → label → persist. A failure in any step fails the whole
 * attempt, and the retry starts over. Every write is an overwrite of the same
 * key, so running a step twice is harmless.
 */
async function processUpload(upload: UploadedObject, record: SQSRecord, context: Context) {
  const ids = parseUploadKey(upload.key);
  if (!ids) {
    // Retrying can't fix a key the presign Lambda didn't create, so don't fail.
    console.warn(JSON.stringify({ message: 'Skipping unexpected key', key: upload.key }));
    return;
  }

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

  const run: Run = {
    ...ids,
    attempt,
    logRef: { logGroup: context.logGroupName, requestId: context.awsRequestId },
  };

  const images = await runStep(run, 'resize', async () => {
    const original = await s3.send(
      new GetObjectCommand({ Bucket: upload.bucket, Key: upload.key }),
    );
    // User metadata comes back without the x-amz-meta- prefix.
    if (original.Metadata?.[SIMULATE_FAILURE_METADATA] === 'true') throw new SimulatedFailure();
    if (!original.Body) throw new Error(`Empty body for ${upload.key}`);

    const { variants, analysis } = await renderImages(await original.Body.transformToByteArray());
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

    const files = Object.fromEntries(
      variants.map(({ variant, width, height, bytes }) => [
        variant,
        { key: processedKey(ids.sessionId, ids.runId, variant), width, height, bytes },
      ]),
    ) as Record<ImageVariant, ImageFile>;

    return {
      result: { files, analysis },
      detail: {
        format: 'webp',
        inputBytes: upload.size,
        outputBytes: variants.reduce((sum, image) => sum + image.bytes, 0),
        ...Object.fromEntries(variants.map((i) => [i.variant, `${i.width}×${i.height}`])),
        rekognitionJpegBytes: analysis.length,
      },
    };
  });

  const recordBase = {
    ...ids,
    createdAt: upload.eventTime,
    expiresAt: imageExpiresAt(upload.eventTime),
    originalBytes: upload.size,
  };

  // The daily cap is checked before Rekognition is called at all, so a capped
  // upload emits no moderate or label events: those services never ran.
  const reservation = await reserveAnalysis();
  if (!reservation.allowed) {
    await reject(
      run,
      upload,
      { ...recordBase, labels: [], moderation: [] },
      {
        reason: 'daily-limit',
        categories: [],
      },
    );
    return;
  }

  const moderation = await runStep(run, 'moderate', async () => {
    const result = await moderate(images.analysis);
    const found = [...new Set(result.labels.filter((l) => l.level === 1).map((l) => l.name))];
    return {
      result,
      detail: {
        flagged: result.blocked.length > 0,
        blocked: result.blocked.join(', ') || 'none',
        found: found.join(', ') || 'nothing',
        minConfidence: MODERATION_MIN_CONFIDENCE,
        model: result.model,
        analysesToday: `${reservation.used} of ${DAILY_ANALYSIS_LIMIT}`,
      },
    };
  });

  if (moderation.blocked.length > 0) {
    // Same answer every time, so this is a rejection, not a failure: no retry.
    await reject(
      run,
      upload,
      { ...recordBase, labels: [], moderation: moderation.labels },
      {
        reason: 'moderation',
        categories: moderation.blocked,
      },
    );
    return;
  }

  const labels = await runStep(run, 'label', async () => {
    const result = await detectLabels(images.analysis);
    return {
      result: result.labels,
      detail: {
        labels: result.labels.map((l) => l.name).join(', ') || 'none',
        count: result.labels.length,
        minConfidence: LABEL_MIN_CONFIDENCE,
        model: result.model,
      },
    };
  });

  await persist(run, {
    ...recordBase,
    status: 'ready',
    display: images.files.display,
    thumb: images.files.thumb,
    labels,
    moderation: moderation.labels,
    rejection: null,
  });
}

/** Writes the image record to DynamoDB. */
async function persist(run: Run, record: ImageRecord): Promise<void> {
  await runStep(run, 'persist', async () => ({
    result: undefined,
    detail: {
      table: requiredEnv('IMAGES_TABLE'),
      status: record.status,
      ...(record.rejection && { reason: describeRejection(record.rejection) }),
      consumedWcu: await putImageRecord(record),
    },
  }));
}

/**
 * Records a rejected upload, then deletes its original and processed files.
 * Nothing serves them in the meantime: only `ready` records are ever shown.
 */
async function reject(
  run: Run,
  upload: UploadedObject,
  partial: Omit<ImageRecord, 'status' | 'display' | 'thumb' | 'rejection'>,
  rejection: Rejection,
): Promise<void> {
  await persist(run, { ...partial, status: 'rejected', display: null, thumb: null, rejection });

  const processed = (Object.keys(IMAGE_VARIANTS) as ImageVariant[]).map((variant) => ({
    Bucket: requiredEnv('PROCESSED_BUCKET'),
    Key: processedKey(run.sessionId, run.runId, variant),
  }));
  await Promise.all(
    [{ Bucket: upload.bucket, Key: upload.key }, ...processed].map((object) =>
      s3.send(new DeleteObjectCommand(object)),
    ),
  );
}

function describeRejection(rejection: Rejection): string {
  return rejection.reason === 'moderation'
    ? `moderation: ${rejection.categories.join(', ')}`
    : `daily analysis limit reached (${DAILY_ANALYSIS_LIMIT} images)`;
}

/**
 * Runs one pipeline step and emits its events: `started`, then `succeeded`
 * with the step's detail, or `failed` with what happens next.
 */
async function runStep<T>(
  run: Run,
  step: Step,
  work: () => Promise<{ result: T; detail: StepDetail }>,
): Promise<T> {
  const started = Date.now();
  const event = {
    sessionId: run.sessionId,
    runId: run.runId,
    step,
    service: STEP_SERVICE[step],
    startedAt: new Date(started).toISOString(),
    logRef: run.logRef,
  };
  const attempt = run.attempt;
  await emit({ ...event, status: 'started', durationMs: null, detail: { attempt } });

  try {
    const { result, detail } = await work();
    await emit({
      ...event,
      status: 'succeeded',
      durationMs: Date.now() - started,
      detail: { attempt, ...detail },
    });
    return result;
  } catch (error) {
    await emit({
      ...event,
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
