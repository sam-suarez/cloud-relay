import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  DetectLabelsCommand,
  DetectModerationLabelsCommand,
  RekognitionClient,
} from '@aws-sdk/client-rekognition';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ChangeMessageVisibilityCommand, SQSClient } from '@aws-sdk/client-sqs';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { emit } from '@cloud-relay/realtime';
import {
  ImageRecordSchema,
  StepEventSchema,
  uploadKey,
  uuidv7,
  type ImageRecord,
  type StepEvent,
} from '@cloud-relay/shared';
import type { Context, SQSEvent, SQSRecord } from 'aws-lambda';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { handler } from './worker.ts';

// Each call reaches one open browser tab.
vi.mock('@cloud-relay/realtime', () => ({ emit: vi.fn(async () => 1) }));

const sessionId = '0b1c2d3e-4f50-4a6b-8c7d-8e9fa0b1c2d3';
// Presign issued the upload URL 1.441 s before S3 stored the object (eventTime below).
const runId = uuidv7(Date.parse('2026-10-03T17:52:51.000Z'));
const key = uploadKey(sessionId, runId, 'image/jpeg');
const context = { awsRequestId: 'req-456', logGroupName: '/aws/lambda/worker' } as Context;

type Send = MockInstance<(command: unknown) => Promise<unknown>>;
let s3Send: Send;
let sqsSend: Send;
let rekognitionSend: Send;
let dynamoSend: Send;
let photo: Buffer;

/** What DetectModerationLabels finds. Empty = nothing unsafe. */
let moderationLabels: {
  Name: string;
  ParentName: string;
  TaxonomyLevel: number;
  Confidence: number;
}[];

const LABELS = [
  { Name: 'Lake', Confidence: 99.147 },
  { Name: 'Sky', Confidence: 98.967 },
];

/** What GetObject returns: the photo, plus the user metadata presign signed into the upload. */
function storedObject(simulateFailure: boolean) {
  return {
    Metadata: { 'simulate-failure': String(simulateFailure) },
    Body: { transformToByteArray: async () => new Uint8Array(photo) },
  };
}

function sqsRecord(body: unknown, receiveCount = 1): SQSRecord {
  return {
    messageId: `msg-${receiveCount}`,
    receiptHandle: 'receipt-handle',
    body: JSON.stringify(body),
    attributes: {
      ApproximateReceiveCount: String(receiveCount),
      SentTimestamp: String(Date.now() - 300),
      SenderId: 'AIDAEXAMPLE',
      ApproximateFirstReceiveTimestamp: String(Date.now() - 100),
    },
    messageAttributes: {},
    md5OfBody: '',
    eventSource: 'aws:sqs',
    eventSourceARN: 'arn:aws:sqs:us-east-2:123456789012:test-uploads-queue',
    awsRegion: 'us-east-2',
  };
}

const s3Notification = (objectKey = key) => ({
  Records: [
    {
      eventName: 'ObjectCreated:Post',
      eventTime: '2026-10-03T17:52:52.441Z',
      s3: { bucket: { name: 'uploads-bucket' }, object: { key: objectKey, size: 2048 } },
    },
  ],
});

const invoke = (...records: SQSRecord[]) => handler({ Records: records } as SQSEvent, context);

/** The step events emitted so far, validated against the shared schema. */
const emitted = () =>
  vi
    .mocked(emit)
    .mock.calls.flatMap((events) => events.map((e) => StepEventSchema.parse(e) as StepEvent));

beforeEach(async () => {
  photo = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#f00' } })
    .jpeg()
    .toBuffer();
  s3Send = vi.spyOn(S3Client.prototype, 'send') as unknown as Send;
  sqsSend = vi.spyOn(SQSClient.prototype, 'send') as unknown as Send;
  s3Send.mockImplementation(async (command) =>
    command instanceof GetObjectCommand ? storedObject(false) : {},
  );
  sqsSend.mockResolvedValue({});

  moderationLabels = [];
  rekognitionSend = vi.spyOn(RekognitionClient.prototype, 'send') as unknown as Send;
  rekognitionSend.mockImplementation(async (command) =>
    command instanceof DetectModerationLabelsCommand
      ? { ModerationModelVersion: '7.0', ModerationLabels: moderationLabels }
      : { LabelModelVersion: '3.0', Labels: LABELS },
  );
  dynamoSend = vi.spyOn(DynamoDBDocumentClient.prototype, 'send') as unknown as Send;
  dynamoSend.mockImplementation(async (command) =>
    command instanceof UpdateCommand
      ? { Attributes: { count: 12 } }
      : { ConsumedCapacity: { CapacityUnits: 1 } },
  );
});

/** The commands of one type sent through a client spy. */
function sent<T>(spy: Send, type: new (...args: never[]) => T): T[] {
  return spy.mock.calls.map(([command]) => command).filter((c): c is T => c instanceof type);
}

/** The image record written to DynamoDB. */
function storedRecord(): ImageRecord {
  const [put] = sent(dynamoSend, PutCommand);
  expect(put?.input.TableName).toBe('test-images-table');
  return ImageRecordSchema.parse(put?.input.Item);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(emit).mockClear();
  vi.mocked(emit).mockImplementation(async () => 1);
});

describe('worker handler', () => {
  it('reads the upload and writes a display image and a thumbnail to the processed bucket', async () => {
    const result = await invoke(sqsRecord(s3Notification()));

    expect(result).toEqual({ batchItemFailures: [] });
    const get = s3Send.mock.calls[0]?.[0] as GetObjectCommand;
    expect(get.input).toEqual({ Bucket: 'uploads-bucket', Key: key });

    const puts = s3Send.mock.calls
      .map(([command]) => command)
      .filter((command): command is PutObjectCommand => command instanceof PutObjectCommand);
    expect(puts.map((put) => put.input.Key).sort()).toEqual([
      `processed/${sessionId}/${runId}/display.webp`,
      `processed/${sessionId}/${runId}/thumb.webp`,
    ]);
    for (const put of puts) {
      expect(put.input).toMatchObject({
        Bucket: 'test-processed-bucket',
        ContentType: 'image/webp',
      });
    }
    expect(sqsSend).not.toHaveBeenCalled();
  });

  it('emits upload and enqueue, then each step started and succeeded, then notify', async () => {
    await invoke(sqsRecord(s3Notification()));

    expect(emitted().map((e) => [e.step, e.status])).toEqual([
      ['upload', 'succeeded'],
      ['enqueue', 'succeeded'],
      ['resize', 'started'],
      ['resize', 'succeeded'],
      ['moderate', 'started'],
      ['moderate', 'succeeded'],
      ['label', 'started'],
      ['label', 'succeeded'],
      ['persist', 'started'],
      ['persist', 'succeeded'],
      ['notify', 'started'],
      ['notify', 'succeeded'],
    ]);
    const [upload, enqueue, , done] = emitted();
    expect(upload).toMatchObject({
      runId,
      sessionId,
      service: 's3',
      startedAt: '2026-10-03T17:52:51.000Z',
      durationMs: 1441,
      detail: { bytes: 2048, key },
      logRef: null,
    });
    expect(enqueue).toMatchObject({ runId, sessionId, service: 'sqs', logRef: null });
    expect(enqueue?.detail).toEqual({ attempt: 1, maxAttempts: 5 });
    expect(done).toMatchObject({
      service: 'lambda',
      logRef: { logGroup: '/aws/lambda/worker', requestId: 'req-456' },
      detail: { attempt: 1, format: 'webp', display: '1280×960', thumb: '320×240' },
    });
  });

  it('reports how many browsers the final push reached', async () => {
    await invoke(sqsRecord(s3Notification()));

    expect(emitted().at(-1)).toMatchObject({
      step: 'notify',
      service: 'api-gateway-websocket',
      status: 'succeeded',
      detail: { connections: 1 },
      logRef: { logGroup: '/aws/lambda/worker' },
    });
    expect(emitted().at(-1)?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('keeps the WebSocket push out of the step durations', async () => {
    vi.mocked(emit).mockImplementation(async (...events) => {
      // A slow `started` push must not count as resize time.
      if (events[0]?.step === 'resize' && events[0].status === 'started') {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return 1;
    });

    await invoke(sqsRecord(s3Notification()));

    const resize = emitted().find((e) => e.step === 'resize' && e.status === 'succeeded');
    expect(resize?.durationMs).toBeLessThan(200);
  });

  it('sends Rekognition the in-memory JPEG, with our thresholds', async () => {
    await invoke(sqsRecord(s3Notification()));

    const [moderation] = sent(rekognitionSend, DetectModerationLabelsCommand);
    const [labels] = sent(rekognitionSend, DetectLabelsCommand);
    const bytes = moderation?.input.Image?.Bytes as Uint8Array;
    expect((await sharp(bytes).metadata()).format).toBe('jpeg'); // Rekognition refuses WebP
    expect(moderation?.input.MinConfidence).toBe(60);
    expect(labels?.input).toMatchObject({
      Image: { Bytes: bytes },
      MaxLabels: 10,
      MinConfidence: 75,
      Settings: { GeneralLabels: { LabelCategoryExclusionFilters: ['Person Description'] } },
    });
  });

  it('counts the analysis against today, then stores a ready record that expires a day after the upload', async () => {
    await invoke(sqsRecord(s3Notification()));

    const [reserve] = sent(dynamoSend, UpdateCommand);
    expect(reserve?.input).toMatchObject({
      TableName: 'test-usage-table',
      Key: { day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) },
      ExpressionAttributeValues: expect.objectContaining({ ':limit': 200 }),
    });
    expect(storedRecord()).toEqual({
      sessionId,
      runId,
      status: 'ready',
      createdAt: '2026-10-03T17:52:52.441Z',
      expiresAt: Date.UTC(2026, 9, 4, 17, 52, 52) / 1000,
      originalBytes: 2048,
      display: {
        key: `processed/${sessionId}/${runId}/display.webp`,
        width: 1280,
        height: 960,
        bytes: expect.any(Number),
      },
      thumb: {
        key: `processed/${sessionId}/${runId}/thumb.webp`,
        width: 320,
        height: 240,
        bytes: expect.any(Number),
      },
      labels: [
        { name: 'Lake', confidence: 99.1 },
        { name: 'Sky', confidence: 99 },
      ],
      moderation: [],
      rejection: null,
    });
    expect(emitted().find((e) => e.step === 'persist' && e.status === 'succeeded')?.detail).toEqual(
      { attempt: 1, table: 'test-images-table', status: 'ready', consumedWcu: 1 },
    );
  });

  it('rejects a flagged image: no labels, a rejected record, and its files deleted, without a retry', async () => {
    moderationLabels = [
      { Name: 'Violence', ParentName: '', TaxonomyLevel: 1, Confidence: 91.24 },
      { Name: 'Weapons', ParentName: 'Violence', TaxonomyLevel: 2, Confidence: 91.24 },
    ];

    const result = await invoke(sqsRecord(s3Notification()));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(sent(rekognitionSend, DetectLabelsCommand)).toHaveLength(0);
    expect(storedRecord()).toMatchObject({
      status: 'rejected',
      display: null,
      thumb: null,
      labels: [],
      moderation: [
        { name: 'Violence', parentName: '', level: 1, confidence: 91.2 },
        { name: 'Weapons', parentName: 'Violence', level: 2, confidence: 91.2 },
      ],
      rejection: { reason: 'moderation', categories: ['Violence'] },
    });
    expect(sent(s3Send, DeleteObjectCommand).map((d) => d.input)).toEqual([
      { Bucket: 'uploads-bucket', Key: key },
      { Bucket: 'test-processed-bucket', Key: `processed/${sessionId}/${runId}/display.webp` },
      { Bucket: 'test-processed-bucket', Key: `processed/${sessionId}/${runId}/thumb.webp` },
    ]);
    expect(emitted().map((e) => `${e.step}:${e.status}`)).not.toContain('label:started');
    expect(emitted().at(-1)).toMatchObject({ step: 'notify', status: 'succeeded' });
    expect(
      emitted().find((e) => e.step === 'moderate' && e.status === 'succeeded')?.detail,
    ).toMatchObject({
      flagged: true,
      blocked: 'Violence',
      found: 'Violence',
      analysesToday: '12 of 200',
    });
  });

  it('keeps an image whose only moderation labels are in allowed categories', async () => {
    moderationLabels = [{ Name: 'Alcohol', ParentName: '', TaxonomyLevel: 1, Confidence: 88 }];

    await invoke(sqsRecord(s3Notification()));

    expect(storedRecord()).toMatchObject({ status: 'ready', rejection: null });
    expect(storedRecord().moderation).toHaveLength(1);
    expect(sent(s3Send, DeleteObjectCommand)).toHaveLength(0);
  });

  it('rejects without calling Rekognition once the daily limit is reached', async () => {
    dynamoSend.mockImplementation(async (command) => {
      if (command instanceof UpdateCommand) {
        throw new ConditionalCheckFailedException({
          message: 'The conditional request failed',
          $metadata: {},
        });
      }
      return { ConsumedCapacity: { CapacityUnits: 1 } };
    });

    const result = await invoke(sqsRecord(s3Notification()));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(rekognitionSend).not.toHaveBeenCalled();
    expect(storedRecord()).toMatchObject({
      status: 'rejected',
      rejection: { reason: 'daily-limit', categories: [] },
    });
    expect(sent(s3Send, DeleteObjectCommand)).toHaveLength(3);
    expect(emitted().map((e) => e.step)).not.toContain('moderate');
    expect(emitted().at(-1)).toMatchObject({ step: 'notify', status: 'succeeded' });
  });

  it('fails and retries the attempt when Rekognition errors', async () => {
    rekognitionSend.mockRejectedValue(new Error('ThrottlingException'));

    const result = await invoke(sqsRecord(s3Notification()));

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'msg-1' }] });
    expect(dynamoSend.mock.calls.some(([c]) => c instanceof PutCommand)).toBe(false);
    expect(emitted().at(-1)).toMatchObject({
      step: 'moderate',
      status: 'failed',
      detail: { attempt: 1, error: 'ThrottlingException', next: 'retry in 5 s' },
    });
  });

  it('fails a simulated-failure upload, reports it, and shortens its visibility for a quick retry', async () => {
    s3Send.mockImplementation(async (command) =>
      command instanceof GetObjectCommand ? storedObject(true) : {},
    );

    const result = await invoke(sqsRecord(s3Notification(), 2));

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'msg-2' }] });
    expect(s3Send.mock.calls.some(([c]) => c instanceof PutObjectCommand)).toBe(false);

    const change = sqsSend.mock.calls[0]?.[0] as ChangeMessageVisibilityCommand;
    expect(change).toBeInstanceOf(ChangeMessageVisibilityCommand);
    expect(change.input).toEqual({
      QueueUrl: 'https://sqs.us-east-2.amazonaws.com/123456789012/test-uploads-queue',
      ReceiptHandle: 'receipt-handle',
      VisibilityTimeout: 5,
    });

    expect(emitted().at(-1)).toMatchObject({
      step: 'resize',
      status: 'failed',
      detail: { attempt: 2, maxAttempts: 5, next: 'retry in 5 s' },
    });
  });

  it('says the message goes to the dead-letter queue after the last attempt', async () => {
    s3Send.mockImplementation(async (command) =>
      command instanceof GetObjectCommand ? storedObject(true) : {},
    );

    await invoke(sqsRecord(s3Notification(), 5));

    expect(emitted().at(-1)?.detail).toMatchObject({ attempt: 5, next: 'dead-letter queue' });
  });

  it('still reports the failure if shortening the visibility fails', async () => {
    s3Send.mockRejectedValue(new Error('AccessDenied'));
    sqsSend.mockRejectedValue(new Error('Throttled'));

    const result = await invoke(sqsRecord(s3Notification()));

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'msg-1' }] });
    expect(emitted().at(-1)?.detail).toMatchObject({ error: 'AccessDenied' });
  });

  it('fails messages that are not S3 notifications, so they end up in the DLQ', async () => {
    const result = await invoke(sqsRecord({ hello: 'world' }));

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'msg-1' }] });
    expect(s3Send).not.toHaveBeenCalled();
  });

  it.each([
    ['the S3 test event', { Service: 'Amazon S3', Event: 's3:TestEvent' }],
    ['a key presign did not create', s3Notification('uploads/not-a-run.jpg')],
  ])('skips %s without failing or touching S3', async (_label, body) => {
    const result = await invoke(sqsRecord(body));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(s3Send).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});
