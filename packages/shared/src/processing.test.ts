import { describe, expect, it } from 'vitest';
import { IMAGE_VARIANTS, processedKey } from './processing.ts';

const sessionId = '0b1c2d3e-4f50-4a6b-8c7d-8e9fa0b1c2d3';
const runId = '6f1c2a5e-8a9b-4c1d-9e2f-3a4b5c6d7e8f';

describe('processedKey', () => {
  it('builds processed/{sessionId}/{runId}/{variant}.webp', () => {
    expect(processedKey(sessionId, runId, 'thumb')).toBe(
      `processed/${sessionId}/${runId}/thumb.webp`,
    );
  });
});

describe('IMAGE_VARIANTS', () => {
  it('renders a display size and a smaller thumbnail', () => {
    expect(IMAGE_VARIANTS).toEqual({ display: 1280, thumb: 320 });
  });
});
