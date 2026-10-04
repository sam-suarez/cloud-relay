import {
  CreateUploadResponseSchema,
  MAX_UPLOAD_BYTES,
  StepEventSchema,
  type CreateUploadResponse,
} from '@cloud-relay/shared';
import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emit } from './emit.ts';
import { handler } from './presign.ts';

vi.mock('./emit.ts', () => ({ emit: vi.fn() }));

const sessionId = '0b1c2d3e-4f50-4a6b-8c7d-8e9fa0b1c2d3';
const context = {
  awsRequestId: 'req-123',
  logGroupName: '/aws/lambda/presign',
} as Context;

function request(body: unknown, { base64 = false } = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    body: base64 ? Buffer.from(raw).toString('base64') : raw,
    isBase64Encoded: base64,
  } as APIGatewayProxyEventV2;
}

async function invoke(event: APIGatewayProxyEventV2) {
  const result = await handler(event, context);
  return { ...result, json: JSON.parse(result.body ?? 'null') as unknown };
}

/** The policy is base64 JSON inside the form fields: what S3 checks the upload against. */
function decodePolicy(fields: Record<string, string>) {
  return JSON.parse(Buffer.from(fields.Policy ?? '', 'base64').toString('utf8')) as {
    expiration: string;
    conditions: unknown[];
  };
}

beforeEach(() => {
  vi.mocked(emit).mockClear();
});

describe('presign handler', () => {
  const valid = { contentType: 'image/png', size: 204_800, sessionId };

  it('returns a presigned POST for a server-chosen key', async () => {
    const res = await invoke(request(valid));

    expect(res.statusCode).toBe(200);
    expect(res.headers).toMatchObject({ 'cache-control': 'no-store' });
    const body = CreateUploadResponseSchema.parse(res.json);
    expect(body.key).toBe(`uploads/${sessionId}/${body.runId}.png`);
    expect(new URL(body.url).hostname).toContain('test-uploads-bucket');
    expect(body.fields).toMatchObject({ key: body.key, 'Content-Type': 'image/png' });
  });

  it('signs a policy that pins the key, content type, size range and a 60 s expiry', async () => {
    const before = Date.now();
    const body = (await invoke(request(valid))).json as CreateUploadResponse;
    const policy = decodePolicy(body.fields);

    expect(policy.conditions).toEqual(
      expect.arrayContaining([
        { bucket: 'test-uploads-bucket' },
        { key: body.key },
        ['content-length-range', 1, MAX_UPLOAD_BYTES],
        ['eq', '$Content-Type', 'image/png'],
      ]),
    );
    const ttl = Date.parse(policy.expiration) - before;
    expect(ttl).toBeGreaterThan(55_000);
    expect(ttl).toBeLessThanOrEqual(61_000);
  });

  it('signs the simulate-failure flag as S3 metadata, false unless asked for', async () => {
    const normal = (await invoke(request(valid))).json as CreateUploadResponse;
    expect(normal.fields).toMatchObject({ 'x-amz-meta-simulate-failure': 'false' });
    expect(decodePolicy(normal.fields).conditions).toContainEqual([
      'eq',
      '$x-amz-meta-simulate-failure',
      'false',
    ]);

    const failing = (await invoke(request({ ...valid, simulateFailure: true })))
      .json as CreateUploadResponse;
    expect(failing.fields).toMatchObject({ 'x-amz-meta-simulate-failure': 'true' });
    expect(decodePolicy(failing.fields).conditions).toContainEqual([
      'eq',
      '$x-amz-meta-simulate-failure',
      'true',
    ]);
  });

  it('gives every request a new runId', async () => {
    const a = (await invoke(request(valid))).json as CreateUploadResponse;
    const b = (await invoke(request(valid))).json as CreateUploadResponse;
    expect(a.runId).not.toBe(b.runId);
  });

  it('emits a valid presign step event for the run', async () => {
    const body = (await invoke(request(valid))).json as CreateUploadResponse;

    expect(emit).toHaveBeenCalledOnce();
    const event = StepEventSchema.parse(vi.mocked(emit).mock.calls[0]?.[0]);
    expect(event).toMatchObject({
      runId: body.runId,
      sessionId,
      step: 'presign',
      service: 'lambda',
      status: 'succeeded',
      detail: { key: body.key, expiresInSeconds: 60 },
      logRef: { logGroup: '/aws/lambda/presign', requestId: 'req-123' },
    });
  });

  it('accepts a base64-encoded body', async () => {
    const res = await invoke(request(valid, { base64: true }));
    expect(res.statusCode).toBe(200);
  });

  it.each([
    ['a missing body', undefined],
    ['invalid JSON', '{not json'],
    ['a gif', { ...valid, contentType: 'image/gif' }],
    ['a file over 5 MB', { ...valid, size: MAX_UPLOAD_BYTES + 1 }],
    ['a session ID that is not a UUID', { ...valid, sessionId: 'abc' }],
  ])('rejects %s with 400 and emits nothing', async (_label, body) => {
    const event = body === undefined ? ({} as APIGatewayProxyEventV2) : request(body);
    const res = await invoke(event);

    expect(res.statusCode).toBe(400);
    expect(res.json).toMatchObject({ message: 'Invalid upload request' });
    expect(emit).not.toHaveBeenCalled();
  });
});
