import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { GalleryResponseSchema, processedKey, uuidv7, type ImageRecord } from '@cloud-relay/shared';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { handler } from './gallery.ts';

const sessionId = '0b1c2d3e-4f50-4a6b-8c7d-8e9fa0b1c2d3';
const runId = uuidv7(Date.parse('2026-10-04T20:44:02.180Z'));

const ready: ImageRecord = {
  sessionId,
  runId,
  status: 'ready',
  createdAt: '2026-10-04T20:44:02.180Z',
  expiresAt: 1791233042,
  originalBytes: 158227,
  display: { key: processedKey(runId, 'display'), width: 960, height: 1280, bytes: 87_000 },
  thumb: { key: processedKey(runId, 'thumb'), width: 240, height: 320, bytes: 9_352 },
  labels: [{ name: 'Lake', confidence: 99.1 }],
  moderation: [],
  rejection: null,
};

type Send = MockInstance<(command: unknown) => Promise<unknown>>;
let dynamoSend: Send;
/** What the Query returns. */
let storedItems: Record<string, unknown>[];

const request = (pathParameters: Record<string, string> | undefined) =>
  ({ pathParameters }) as unknown as APIGatewayProxyEventV2;

async function invoke(event: APIGatewayProxyEventV2) {
  const result = await handler(event);
  return { ...result, json: JSON.parse(result.body ?? 'null') as unknown };
}

/** The one Query the handler sent. */
function sentQuery() {
  const queries = dynamoSend.mock.calls
    .map(([command]) => command)
    .filter((c): c is QueryCommand => c instanceof QueryCommand);
  expect(queries).toHaveLength(1);
  return queries[0]!.input;
}

beforeEach(() => {
  storedItems = [ready];
  dynamoSend = vi.spyOn(DynamoDBDocumentClient.prototype, 'send') as unknown as Send;
  dynamoSend.mockImplementation(async () => ({
    Items: storedItems,
    Count: storedItems.length,
    ScannedCount: storedItems.length,
  }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('gallery handler', () => {
  it("Queries only the session's partition, newest first, skipping expired items", async () => {
    const before = Math.floor(Date.now() / 1000);
    await invoke(request({ sessionId }));
    const input = sentQuery();

    expect(input).toMatchObject({
      TableName: 'test-images-table',
      KeyConditionExpression: 'sessionId = :sessionId',
      FilterExpression: 'expiresAt > :now',
      ScanIndexForward: false,
      Limit: 24,
    });
    expect(input.ExpressionAttributeValues?.[':sessionId']).toBe(sessionId);
    expect(input.ExpressionAttributeValues?.[':now']).toBeGreaterThanOrEqual(before);
  });

  it('returns gallery items with same-origin image URLs, never cached', async () => {
    const res = await invoke(request({ sessionId }));

    expect(res.statusCode).toBe(200);
    expect(res.headers).toMatchObject({ 'cache-control': 'no-store' });
    const body = GalleryResponseSchema.parse(res.json);
    expect(body.items).toEqual([
      expect.objectContaining({
        runId,
        status: 'ready',
        thumb: { url: `/processed/${runId}/thumb.webp`, width: 240, height: 320 },
      }),
    ]);
    expect(JSON.stringify(res.json)).not.toContain(sessionId);
  });

  it('returns an empty list for a session with no images', async () => {
    storedItems = [];
    const res = await invoke(request({ sessionId }));

    expect(res.statusCode).toBe(200);
    expect(res.json).toEqual({ items: [] });
  });

  it('skips an item that is not a valid image record, without logging the session ID', async () => {
    storedItems = [{ sessionId, runId: 'broken' }, ready];
    const res = await invoke(request({ sessionId }));

    expect(GalleryResponseSchema.parse(res.json).items).toHaveLength(1);
    const warned = vi.mocked(console.warn).mock.calls.flat().join(' ');
    expect(warned).toContain('Skipping invalid image record');
    expect(warned).not.toContain(sessionId);
  });

  it.each([
    ['a session ID that is not a UUID', { sessionId: 'abc' }],
    ['no path parameters', undefined],
  ])('rejects %s with 400, without calling DynamoDB', async (_, params) => {
    const res = await invoke(request(params));

    expect(res.statusCode).toBe(400);
    expect(dynamoSend).not.toHaveBeenCalled();
  });
});
