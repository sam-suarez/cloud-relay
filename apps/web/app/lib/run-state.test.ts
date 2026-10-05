import type { GalleryItem, StepEvent } from '@cloud-relay/shared';
import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  formatDuration,
  runOutcome,
  runStartMs,
  runStatus,
  settle,
  type RunState,
} from './run-state.ts';

const RUN_A = '6f1c2a5e-8a9b-4c1d-9e2f-3a4b5c6d7e8f';
const RUN_B = '7a2d3b6f-9bac-4d2e-8f30-4b5c6d7e8f90';
const SESSION = '0b1c2d3e-4f50-4a6b-8c7d-8e9fa0b1c2d3';

function event(overrides: Partial<StepEvent>): StepEvent {
  return {
    runId: RUN_A,
    sessionId: SESSION,
    step: 'resize',
    service: 'lambda',
    status: 'started',
    startedAt: '2026-10-01T12:00:00.000Z',
    durationMs: null,
    detail: {},
    logRef: null,
    ...overrides,
  };
}

function fold(events: StepEvent[]): RunState {
  return events.reduce<RunState | null>(applyEvent, null)!;
}

describe('applyEvent', () => {
  it('marks a step as running when it starts', () => {
    const run = fold([event({ status: 'started' })]);
    expect(run.steps.resize).toMatchObject({ status: 'started', attempts: 1 });
    expect(runStatus(run)).toBe('running');
  });

  it('records duration and merges detail when the step succeeds', () => {
    const run = fold([
      event({ status: 'started', detail: { inputBytes: 2_000_000 } }),
      event({ status: 'succeeded', durationMs: 420, detail: { outputBytes: 40_000 } }),
    ]);
    expect(run.steps.resize).toMatchObject({
      status: 'succeeded',
      durationMs: 420,
      detail: { inputBytes: 2_000_000, outputBytes: 40_000 },
    });
  });

  it('counts retries when a failed step starts again', () => {
    const run = fold([
      event({ status: 'started' }),
      event({ status: 'failed', durationMs: 30 }),
      event({ status: 'started' }),
    ]);
    expect(run.steps.resize).toMatchObject({ status: 'started', attempts: 2 });
  });

  it('resets when an event for a new run arrives', () => {
    const run = fold([event({ runId: RUN_A }), event({ runId: RUN_B, step: 'edge' })]);
    expect(run.runId).toBe(RUN_B);
    expect(run.steps.resize).toBeUndefined();
    expect(run.events).toHaveLength(1);
  });
});

describe('runStatus', () => {
  it('is failed when any step failed', () => {
    const run = fold([event({ status: 'failed', durationMs: 10 })]);
    expect(runStatus(run)).toBe('failed');
  });

  it('is succeeded once the browser has been notified', () => {
    const run = fold([
      event({ status: 'failed', durationMs: 10 }),
      event({
        step: 'notify',
        service: 'api-gateway-websocket',
        status: 'succeeded',
        durationMs: 5,
      }),
    ]);
    expect(runStatus(run)).toBe('succeeded');
  });
});

describe('runStartMs', () => {
  it('returns the earliest startedAt', () => {
    const run = fold([
      event({ step: 'resize', startedAt: '2026-10-01T12:00:01.000Z' }),
      event({ step: 'edge', service: 'cloudfront', startedAt: '2026-10-01T12:00:00.000Z' }),
    ]);
    expect(runStartMs(run)).toBe(Date.parse('2026-10-01T12:00:00.000Z'));
  });
});

describe('runOutcome', () => {
  const persisted = (detail: StepEvent['detail']) =>
    event({ step: 'persist', service: 'dynamodb', status: 'succeeded', durationMs: 20, detail });

  it('is running until the record is saved', () => {
    expect(runOutcome(fold([event({ status: 'succeeded', durationMs: 900 })]))).toEqual({
      kind: 'running',
    });
  });

  it('is ready, with the labels DetectLabels returned', () => {
    const run = fold([
      event({
        step: 'label',
        service: 'rekognition',
        status: 'succeeded',
        durationMs: 150,
        detail: { labels: 'Lake, Sky' },
      }),
      persisted({ status: 'ready' }),
    ]);
    expect(runOutcome(run)).toEqual({ kind: 'ready', labels: ['Lake', 'Sky'] });
  });

  it('is rejected, with the reason the worker recorded', () => {
    const run = fold([persisted({ status: 'rejected', reason: 'moderation: Violence' })]);
    expect(runOutcome(run)).toEqual({ kind: 'rejected', reason: 'moderation: Violence' });
  });

  it('is failed while a step is failed, with what SQS does next', () => {
    const failed = event({
      status: 'failed',
      durationMs: 40,
      detail: { attempt: 2, maxAttempts: 5, error: 'Simulated failure', next: 'retry in 5 s' },
    });
    expect(runOutcome(fold([failed]))).toEqual({
      kind: 'failed',
      step: 'resize',
      error: 'Simulated failure',
      next: 'retry in 5 s',
      attempt: 2,
      maxAttempts: 5,
    });
    // The retry starts: running again.
    expect(runOutcome(fold([failed, event({ status: 'started' })]))).toEqual({ kind: 'running' });
  });
});

describe('settle (catch-up from the image record)', () => {
  const record = (overrides: Partial<GalleryItem> = {}): GalleryItem => ({
    runId: RUN_A,
    status: 'ready',
    createdAt: '2026-10-01T12:00:00.000Z',
    thumb: { url: `/processed/${RUN_A}/thumb.webp`, width: 240, height: 320 },
    display: { url: `/processed/${RUN_A}/display.webp`, width: 960, height: 1280 },
    labels: [{ name: 'Lake', confidence: 99.1 }],
    rejection: null,
    ...overrides,
  });

  // The final push was lost: persist succeeded, notify never finished.
  const stuck = fold([
    event({ step: 'resize', status: 'succeeded', durationMs: 900 }),
    event({ step: 'persist', service: 'dynamodb', status: 'started' }),
  ]);

  it('leaves the run alone while the gallery has no record for it', () => {
    const otherRun = record({ runId: RUN_B });
    expect(settle(stuck, [otherRun])).toBe(stuck);
    expect(runStatus(settle(stuck, []))).toBe('running');
  });

  it('finishes the run and marks steps still waiting for an event as missed', () => {
    const settled = settle(stuck, [record()]);

    expect(runStatus(settled)).toBe('succeeded');
    expect(settled.steps.persist?.status).toBe('missed');
    expect(formatDuration(settled.steps.persist!)).toBe('missed');
    // Never green from the record: steps without events stay absent.
    expect(settled.steps.resize?.status).toBe('succeeded');
    expect(settled.steps.label).toBeUndefined();
    expect(settled.steps.notify).toBeUndefined();
  });

  it('marks a failed step as missed, since a later attempt must have succeeded', () => {
    const run = fold([event({ status: 'failed', durationMs: 30, detail: { attempt: 1 } })]);
    const settled = settle(run, [record()]);

    expect(settled.steps.resize?.status).toBe('missed');
    expect(runOutcome(settled)).toEqual({ kind: 'ready', labels: ['Lake'] });
  });

  it('reads the outcome from the record, which beats the events', () => {
    const rejected = record({
      status: 'rejected',
      thumb: null,
      display: null,
      labels: [],
      rejection: { reason: 'moderation', categories: ['Violence'] },
    });

    expect(runOutcome(settle(stuck, [rejected]))).toEqual({
      kind: 'rejected',
      reason: 'moderation: Violence',
    });
  });

  it('lets a late event still finish its step normally', () => {
    const late = applyEvent(
      stuck,
      event({ step: 'persist', service: 'dynamodb', status: 'succeeded', durationMs: 20 }),
    );
    expect(settle(late, [record()]).steps.persist?.status).toBe('succeeded');
  });
});
