import { describe, expect, it } from 'vitest';
import { STEPS, STEP_SERVICE, parseStepEvent, type StepEvent } from './events.ts';

const validEvent: StepEvent = {
  runId: '6f1c2a5e-8a9b-4c1d-9e2f-3a4b5c6d7e8f',
  sessionId: '0b1c2d3e-4f50-4a6b-8c7d-8e9fa0b1c2d3',
  step: 'resize',
  service: 'lambda',
  status: 'succeeded',
  startedAt: '2026-10-01T12:00:00.000Z',
  durationMs: 412,
  detail: { width: 320, format: 'webp' },
  logRef: { logGroup: '/aws/lambda/worker', requestId: 'abc-123' },
};

describe('parseStepEvent', () => {
  it('accepts a valid event', () => {
    expect(parseStepEvent(validEvent)).toEqual(validEvent);
  });

  it('accepts a "started" event with no duration and no log yet', () => {
    const started = { ...validEvent, status: 'started', durationMs: null, logRef: null };
    expect(parseStepEvent(started)).toEqual(started);
  });

  it('rejects an unknown status', () => {
    expect(parseStepEvent({ ...validEvent, status: 'pending' })).toBeNull();
  });

  it('rejects an unknown step', () => {
    expect(parseStepEvent({ ...validEvent, step: 'teleport' })).toBeNull();
  });

  it('rejects a negative duration', () => {
    expect(parseStepEvent({ ...validEvent, durationMs: -5 })).toBeNull();
  });

  it('rejects a non-ISO timestamp', () => {
    expect(parseStepEvent({ ...validEvent, startedAt: 'yesterday' })).toBeNull();
  });

  it('rejects nested objects in detail (detail must stay flat for the UI)', () => {
    expect(parseStepEvent({ ...validEvent, detail: { nested: { a: 1 } } })).toBeNull();
  });
});

describe('STEP_SERVICE', () => {
  it('maps every step to a service', () => {
    for (const step of STEPS) {
      expect(STEP_SERVICE[step]).toBeDefined();
    }
  });
});
