import type { GalleryItem } from '@cloud-relay/shared';
import { describe, expect, it, vi } from 'vitest';
import { GalleryError, fetchGallery } from './gallery.ts';

const sessionId = '0b1c2d3e-4f50-4a6b-8c7d-8e9fa0b1c2d3';
const runId = '01a108a8-c4aa-7cd1-b999-a5e4c320e2b8';

const item: GalleryItem = {
  runId,
  status: 'ready',
  createdAt: '2026-10-04T20:44:02.180Z',
  thumb: { url: `/processed/${runId}/thumb.webp`, width: 240, height: 320 },
  display: { url: `/processed/${runId}/display.webp`, width: 960, height: 1280 },
  labels: [{ name: 'Lake', confidence: 99.1 }],
  rejection: null,
};

const respond = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('fetchGallery', () => {
  it("GETs the session's images from the relative API path", async () => {
    const fetchFn = respond(200, { items: [item] });

    await expect(fetchGallery(sessionId, fetchFn)).resolves.toEqual([item]);
    expect(fetchFn).toHaveBeenCalledWith(`/api/sessions/${sessionId}/images`);
  });

  it('explains throttling', async () => {
    await expect(fetchGallery(sessionId, respond(429, {}))).rejects.toThrow(/throttling/);
  });

  it('reports other HTTP errors with their status', async () => {
    const result = fetchGallery(sessionId, respond(503, {}));

    await expect(result).rejects.toBeInstanceOf(GalleryError);
    await expect(result).rejects.toThrow('503');
  });

  it('rejects a body that does not match the schema', async () => {
    await expect(fetchGallery(sessionId, respond(200, { items: [{}] }))).rejects.toThrow();
  });
});
