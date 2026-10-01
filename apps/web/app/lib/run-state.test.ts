import type { StepEvent } from '@cloud-relay/shared';
import { describe, expect, it } from 'vitest';
import { applyEvent, runStartMs, runStatus, type RunState } from './run-state.ts';

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
