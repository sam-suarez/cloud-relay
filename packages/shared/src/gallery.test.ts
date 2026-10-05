import { describe, expect, it } from 'vitest';
import {
  GalleryParamsSchema,
  GalleryResponseSchema,
  galleryPath,
  toGalleryItem,
} from './gallery.ts';
import type { ImageRecord } from './images.ts';
import { processedKey } from './processing.ts';

const sessionId = '0b1c2d3e-4f50-4a6b-8c7d-8e9fa0b1c2d3';
const runId = '01a108a8-c4aa-7cd1-b999-a5e4c320e2b8';

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

describe('galleryPath', () => {
  it('fills the session ID into the route', () => {
    expect(galleryPath(sessionId)).toBe(`/api/sessions/${sessionId}/images`);
  });
});

describe('GalleryParamsSchema', () => {
  it('accepts only a UUID session ID', () => {
    expect(GalleryParamsSchema.safeParse({ sessionId }).success).toBe(true);
    expect(GalleryParamsSchema.safeParse({ sessionId: 'abc' }).success).toBe(false);
    expect(GalleryParamsSchema.safeParse({}).success).toBe(false);
  });
});

describe('toGalleryItem', () => {
  it('turns stored keys into same-origin /processed/ URLs and drops internal fields', () => {
    const item = toGalleryItem(ready);

    expect(item).toEqual({
      runId,
      status: 'ready',
      createdAt: '2026-10-04T20:44:02.180Z',
      thumb: { url: `/processed/${runId}/thumb.webp`, width: 240, height: 320 },
      display: { url: `/processed/${runId}/display.webp`, width: 960, height: 1280 },
      labels: [{ name: 'Lake', confidence: 99.1 }],
      rejection: null,
    });
    expect(item).not.toHaveProperty('sessionId');
    expect(GalleryResponseSchema.parse({ items: [item] }).items).toHaveLength(1);
  });

  it('keeps the URL of a record written with the older key layout', () => {
    const oldKey = `processed/${sessionId}/${runId}/thumb.webp`;
    const item = toGalleryItem({ ...ready, thumb: { ...ready.thumb!, key: oldKey } });

    expect(item.thumb?.url).toBe(`/${oldKey}`);
  });

  it('has no images for a rejected record, only the rejection', () => {
    const item = toGalleryItem({
      ...ready,
      status: 'rejected',
      display: null,
      thumb: null,
      labels: [],
      rejection: { reason: 'moderation', categories: ['Violence'] },
    });

    expect(item).toMatchObject({
      status: 'rejected',
      thumb: null,
      display: null,
      rejection: { reason: 'moderation', categories: ['Violence'] },
    });
  });
});
