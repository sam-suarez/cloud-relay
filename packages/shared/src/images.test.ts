import { describe, expect, it } from 'vitest';
import { ImageRecordSchema, imageExpiresAt, type ImageRecord } from './images.ts';

describe('imageExpiresAt', () => {
  it('is a day after the upload, in whole Unix seconds (what DynamoDB TTL reads)', () => {
    expect(imageExpiresAt('2026-10-04T03:13:46.441Z')).toBe(Date.UTC(2026, 9, 5, 3, 13, 46) / 1000);
  });
});

describe('ImageRecordSchema', () => {
  const rejected: ImageRecord = {
    sessionId: '0b1c2d3e-4f50-4a6b-8c7d-8e9fa0b1c2d3',
    runId: '01a104e7-413f-7086-9543-10fe1d5c53ce',
    status: 'rejected',
    createdAt: '2026-10-04T03:13:46.441Z',
    expiresAt: 1791169998,
    originalBytes: 158227,
    display: null,
    thumb: null,
    labels: [],
    moderation: [{ name: 'Violence', parentName: '', level: 1, confidence: 91.2 }],
    rejection: { reason: 'moderation', categories: ['Violence'] },
  };

  it('accepts a rejected image without files', () => {
    expect(ImageRecordSchema.parse(rejected)).toEqual(rejected);
  });

  it('requires the TTL attribute to be a number (TTL ignores strings)', () => {
    expect(ImageRecordSchema.safeParse({ ...rejected, expiresAt: '1791169998' }).success).toBe(
      false,
    );
  });
});
