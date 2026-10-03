import { describe, expect, it } from 'vitest';
import {
  CreateUploadRequestSchema,
  CreateUploadResponseSchema,
  MAX_UPLOAD_BYTES,
  uploadKey,
} from './uploads.ts';

const sessionId = '0b1c2d3e-4f50-4a6b-8c7d-8e9fa0b1c2d3';
const runId = '6f1c2a5e-8a9b-4c1d-9e2f-3a4b5c6d7e8f';

describe('CreateUploadRequestSchema', () => {
  const valid = { contentType: 'image/jpeg', size: 1_843_200, sessionId };

  it('accepts a jpeg, png or webp up to 5 MB', () => {
    for (const contentType of ['image/jpeg', 'image/png', 'image/webp']) {
      expect(CreateUploadRequestSchema.safeParse({ ...valid, contentType }).success).toBe(true);
    }
    expect(CreateUploadRequestSchema.safeParse({ ...valid, size: MAX_UPLOAD_BYTES }).success).toBe(
      true,
    );
  });

  it.each([
    ['another content type', { contentType: 'image/gif' }],
    ['a file over 5 MB', { size: MAX_UPLOAD_BYTES + 1 }],
    ['an empty file', { size: 0 }],
    ['a fractional size', { size: 1.5 }],
    ['a session ID that is not a UUID', { sessionId: '../other-session' }],
  ])('rejects %s', (_label, override) => {
    expect(CreateUploadRequestSchema.safeParse({ ...valid, ...override }).success).toBe(false);
  });
});

describe('CreateUploadResponseSchema', () => {
  it('accepts a presigned POST for a key under uploads/', () => {
    const response = {
      url: 'https://example-bucket.s3.us-east-2.amazonaws.com/',
      fields: { key: `uploads/${sessionId}/${runId}.jpg`, Policy: 'eyJ...' },
      key: `uploads/${sessionId}/${runId}.jpg`,
      runId,
      expiresAt: '2026-10-02T12:01:00.000Z',
    };
    expect(CreateUploadResponseSchema.parse(response)).toEqual(response);
  });
});

describe('uploadKey', () => {
  it('builds uploads/{sessionId}/{runId}.{ext} from the content type', () => {
    expect(uploadKey(sessionId, runId, 'image/jpeg')).toBe(`uploads/${sessionId}/${runId}.jpg`);
    expect(uploadKey(sessionId, runId, 'image/webp')).toBe(`uploads/${sessionId}/${runId}.webp`);
  });
});
