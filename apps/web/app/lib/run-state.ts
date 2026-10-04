import {
  STEPS,
  type LogRef,
  type Step,
  type StepDetail,
  type StepEvent,
  type StepStatus,
} from '@cloud-relay/shared';

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

/** "420 ms", "…" while running, or "—" when the service reported no timing. */
export function formatDuration(state: StepState): string {
  if (state.durationMs != null) return `${state.durationMs} ms`;
  return state.status === 'started' ? '…' : '—';
}

/** Epoch ms of the earliest step in the run. Used as t=0 for the timeline. */
export function runStartMs(run: RunState): number {
  const starts = Object.values(run.steps).map((s) => Date.parse(s.startedAt));
  return starts.length ? Math.min(...starts) : 0;
}

/** What happened to the upload, as far as the events received so far tell. */
export type RunOutcome =
  | { kind: 'running' }
  | { kind: 'ready'; labels: string[] }
  | { kind: 'rejected'; reason: string }
  | {
      kind: 'failed';
      step: Step;
      error: string;
      /** e.g. "retry in 5 s" or "dead-letter queue". */
      next: string | null;
      attempt: number | null;
      maxAttempts: number | null;
    };

/**
 * Reads the outcome from the step details the Lambdas sent: `persist` says
 * ready or rejected (and why), `label` lists the labels, and a failed step says
 * what went wrong and what SQS does next.
 */
export function runOutcome(run: RunState): RunOutcome {
  const failed = STEPS.find((step) => run.steps[step]?.status === 'failed');
  if (failed) {
    const detail = run.steps[failed]?.detail ?? {};
    return {
      kind: 'failed',
      step: failed,
      error: String(detail.error ?? 'Unknown error'),
      next: typeof detail.next === 'string' ? detail.next : null,
      attempt: typeof detail.attempt === 'number' ? detail.attempt : null,
      maxAttempts: typeof detail.maxAttempts === 'number' ? detail.maxAttempts : null,
    };
  }

  const persist = run.steps.persist;
  if (persist?.status !== 'succeeded') return { kind: 'running' };
  if (persist.detail.status === 'rejected') {
    return { kind: 'rejected', reason: String(persist.detail.reason ?? 'rejected') };
  }
  const labels = run.steps.label?.detail.labels;
  return {
    kind: 'ready',
    labels: typeof labels === 'string' && labels !== 'none' ? labels.split(', ') : [],
  };
}
