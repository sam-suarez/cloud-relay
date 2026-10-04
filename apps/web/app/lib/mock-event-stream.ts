import {
  MAX_UPLOAD_BYTES,
  STEPS,
  STEP_SERVICE,
  UPLOAD_URL_TTL_SECONDS,
  StepEventSchema,
  type Step,
  type StepDetail,
  type StepEvent,
} from '@cloud-relay/shared';
import type { EventStream, StepEventListener } from './event-stream.ts';

/**
 * LOCAL DEVELOPMENT ONLY. Stands in for the backend's WebSocket stream.
 *
 * It plays a scripted run, but every event goes through the real zod schema,
 * and the UI handles it exactly like a WebSocket message. The UI never runs
 * its own timers to fake progress.
 */
export interface MockEventStream extends EventStream {
  /** Pass `runId` to replay the pipeline for a real upload. */
  startRun(options: { sessionId: string; runId?: string; failAt?: Step }): string;
}

/** Rough real-world timings, so the mock looks like the real pipeline. */
const MOCK_STEPS: Record<Step, { durationMs: number; detail: StepDetail }> = {
  edge: { durationMs: 9, detail: { cache: 'Miss', pop: 'ORD58-P1' } },
  api: { durationMs: 14, detail: { route: 'POST /api/uploads', throttled: false } },
  presign: {
    durationMs: 48,
    detail: { expiresInSeconds: UPLOAD_URL_TTL_SECONDS, maxBytes: MAX_UPLOAD_BYTES },
  },
  upload: { durationMs: 640, detail: { bytes: 1_843_200, contentType: 'image/jpeg' } },
  enqueue: { durationMs: 180, detail: { attempt: 1, maxAttempts: 5 } },
  resize: {
    durationMs: 910,
    detail: {
      attempt: 1,
      format: 'webp',
      display: '1280×960',
      thumb: '320×240',
      outputBytes: 96_412,
    },
  },
  moderate: { durationMs: 430, detail: { flagged: false, minConfidence: 80 } },
  label: { durationMs: 610, detail: { labels: 'Dog, Pet, Grass', count: 3 } },
  persist: { durationMs: 22, detail: { table: 'images', consumedWcu: 1 } },
  notify: { durationMs: 35, detail: { connections: 1 } },
};

/** Steps that run our own Lambda code, and therefore write a log line. */
const LAMBDA_STEPS = new Set<Step>(['presign', 'resize', 'moderate', 'label', 'persist', 'notify']);

/** Small pause between one step finishing and the next starting. */
const HANDOFF_MS = 40;

export function createMockEventStream(): MockEventStream {
  const listeners = new Set<StepEventListener>();
  const timers = new Set<ReturnType<typeof setTimeout>>();

  function emit(event: StepEvent) {
    // Validate exactly as the WebSocket client does.
    const parsed = StepEventSchema.parse(event);
    for (const listener of listeners) listener(parsed);
  }

  function at(delayMs: number, fn: () => void) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, delayMs);
    timers.add(timer);
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    dispose() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      listeners.clear();
    },

    startRun({ sessionId, runId = crypto.randomUUID(), failAt }) {
      const t0 = Date.now();
      let offset = 0;

      for (const step of STEPS) {
        const { durationMs, detail } = MOCK_STEPS[step];
        const fails = step === failAt;
        const startedAt = new Date(t0 + offset).toISOString();
        const logRef = LAMBDA_STEPS.has(step)
          ? { logGroup: `/aws/lambda/mock-${step}`, requestId: crypto.randomUUID() }
          : null;
        const base = { runId, sessionId, step, service: STEP_SERVICE[step], startedAt, logRef };

        at(offset, () => emit({ ...base, status: 'started', durationMs: null, detail: {} }));
        at(offset + durationMs, () =>
          emit({
            ...base,
            status: fails ? 'failed' : 'succeeded',
            durationMs,
            detail: fails ? { error: 'Simulated failure' } : detail,
          }),
        );

        if (fails) break;
        offset += durationMs + HANDOFF_MS;
      }

      return runId;
    },
  };
}
