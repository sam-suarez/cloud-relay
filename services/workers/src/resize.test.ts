import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ChangeMessageVisibilityCommand, SQSClient } from '@aws-sdk/client-sqs';
import { StepEventSchema, uploadKey, type StepEvent } from '@cloud-relay/shared';
import type { Context, SQSEvent, SQSRecord } from 'aws-lambda';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { emit } from './emit.ts';
import { handler } from './resize.ts';

vi.mock('./emit.ts', () => ({ emit: vi.fn() }));

const sessionId = '0b1c2d3e-4f50-4a6b-8c7d-8e9fa0b1c2d3';
const runId = '6f1c2a5e-8a9b-4c1d-9e2f-3a4b5c6d7e8f';
const key = uploadKey(sessionId, runId, 'image/jpeg');
const context = { awsRequestId: 'req-456', logGroupName: '/aws/lambda/worker' } as Context;

type Send = MockInstance<(command: unknown) => Promise<unknown>>;
let s3Send: Send;
let sqsSend: Send;
let photo: Buffer;

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
  vi.mocked(emit).mock.calls.map(([event]) => StepEventSchema.parse(event) as StepEvent);

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
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(emit).mockClear();
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

  it('emits enqueue, then resize started and succeeded, for the run', async () => {
    await invoke(sqsRecord(s3Notification()));

    expect(emitted().map((e) => [e.step, e.status])).toEqual([
      ['enqueue', 'succeeded'],
      ['resize', 'started'],
      ['resize', 'succeeded'],
    ]);
    const [enqueue, , done] = emitted();
    expect(enqueue).toMatchObject({ runId, sessionId, service: 'sqs', logRef: null });
    expect(enqueue?.detail).toEqual({ attempt: 1, maxAttempts: 5 });
    expect(done).toMatchObject({
      service: 'lambda',
      logRef: { logGroup: '/aws/lambda/worker', requestId: 'req-456' },
      detail: { attempt: 1, format: 'webp', display: '1280×960', thumb: '320×240' },
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
