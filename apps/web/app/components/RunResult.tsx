import { STEPS } from '@cloud-relay/shared';
import type { ReactNode } from 'react';
import { nodeInfo } from '../lib/pipeline.ts';
import { runOutcome, type RunOutcome, type RunState } from '../lib/run-state.ts';

/** The outcome of the current upload, read from the step events received so far. */
export function RunResult({ run }: { run: RunState | null }) {
  if (!run) return null;
  const outcome = runOutcome(run);

  if (outcome.kind === 'running') {
    const current = STEPS.findLast((step) => run.steps[step]?.status === 'started');
    return (
      <Card tone="slate" title="Processing…">
        {current ? `${nodeInfo(current).title} is working.` : 'Waiting for the next step.'}
      </Card>
    );
  }

  if (outcome.kind === 'ready') {
    return (
      <Card tone="emerald" title="Ready">
        {outcome.labels.length > 0 ? (
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {outcome.labels.map((label) => (
              <li key={label} className="rounded-full bg-emerald-950 px-2 py-0.5 text-emerald-200">
                {label}
              </li>
            ))}
          </ul>
        ) : (
          'Rekognition found no labels above 75% confidence.'
        )}
      </Card>
    );
  }

  if (outcome.kind === 'rejected') {
    return (
      <Card tone="rose" title="Rejected">
        {outcome.reason}. The original and resized files were deleted.
      </Card>
    );
  }

  return (
    <Card tone="rose" title={`Failed at ${nodeInfo(outcome.step).title}`}>
      {outcome.error}
      <span className="mt-1 block text-slate-400">{whatNext(outcome)}</span>
    </Card>
  );
}

/**
 * What SQS does after a failed attempt, as the worker reported it. A fact, not
 * a countdown: the next attempt shows up as new events when SQS redelivers.
 */
function whatNext({ next, attempt, maxAttempts }: Extract<RunOutcome, { kind: 'failed' }>) {
  const which = attempt && maxAttempts ? `Attempt ${attempt} of ${maxAttempts} failed. ` : '';
  if (next === 'dead-letter queue') {
    return `${which}SQS moves the message to the dead-letter queue.`;
  }
  if (next?.startsWith('retry in ')) {
    return `${which}SQS hands the message to the worker again after ${next.slice('retry in '.length)}.`;
  }
  return which;
}

const TONES = {
  slate: 'border-slate-800 text-slate-200',
  emerald: 'border-emerald-500/50 text-emerald-300',
  rose: 'border-rose-500/50 text-rose-300',
} as const;

function Card({
  tone,
  title,
  children,
}: {
  tone: keyof typeof TONES;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className={`rounded-xl border bg-slate-900/60 p-4 text-xs ${TONES[tone]}`}>
      <h2 className="mb-1 text-sm font-semibold">{title}</h2>
      <div className="text-slate-300">{children}</div>
    </section>
  );
}
