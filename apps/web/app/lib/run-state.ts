import type { LogRef, Step, StepDetail, StepEvent, StepStatus } from '@cloud-relay/shared';

export interface StepState {
  status: StepStatus;
  startedAt: string;
  durationMs: number | null;
  detail: StepDetail;
  logRef: LogRef | null;
  /** How many times this step has started. Above 1 means SQS redelivered and the step retried. */
  attempts: number;
}

export interface RunState {
  runId: string;
  steps: Partial<Record<Step, StepState>>;
  /** Every event received for this run, in arrival order. */
  events: StepEvent[];
}

export type RunStatus = 'running' | 'succeeded' | 'failed';

/**
 * Reducer: folds one backend event into the current run.
 * An event for a different runId means a new upload started, so we reset.
 */
export function applyEvent(run: RunState | null, event: StepEvent): RunState {
  const current: RunState =
    run && run.runId === event.runId ? run : { runId: event.runId, steps: {}, events: [] };

  const previous = current.steps[event.step];
  const attempts = (previous?.attempts ?? 0) + (event.status === 'started' ? 1 : 0);

  return {
    ...current,
    steps: {
      ...current.steps,
      [event.step]: {
        status: event.status,
        startedAt: event.startedAt,
        durationMs: event.durationMs,
        detail: { ...previous?.detail, ...event.detail },
        logRef: event.logRef ?? previous?.logRef ?? null,
        attempts: Math.max(attempts, 1),
      },
    },
    events: [...current.events, event],
  };
}

export function runStatus(run: RunState): RunStatus {
  if (run.steps.notify?.status === 'succeeded') return 'succeeded';
  const states = Object.values(run.steps);
  if (states.some((s) => s.status === 'failed')) return 'failed';
  return 'running';
}

/** Epoch ms of the earliest step in the run. Used as t=0 for the timeline. */
export function runStartMs(run: RunState): number {
  const starts = Object.values(run.steps).map((s) => Date.parse(s.startedAt));
  return starts.length ? Math.min(...starts) : 0;
}
