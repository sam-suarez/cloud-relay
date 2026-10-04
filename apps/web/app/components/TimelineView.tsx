import { STEPS } from '@cloud-relay/shared';
import { nodeInfo } from '../lib/pipeline.ts';
import { formatDuration, runStartMs, type RunState } from '../lib/run-state.ts';

const BAR_COLORS = {
  started: 'bg-amber-400/80 animate-pulse',
  succeeded: 'bg-emerald-500',
  failed: 'bg-rose-500',
} as const;

/** A waterfall of every step in the current run, like the browser's Network tab. */
export function TimelineView({ run }: { run: RunState | null }) {
  if (!run) {
    return (
      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-sm text-slate-400">
        The timeline fills in as backend events arrive.
      </section>
    );
  }

  const t0 = runStartMs(run);
  const rows = STEPS.flatMap((step) => {
    const state = run.steps[step];
    if (!state) return [];
    return [{ step, state, offset: Date.parse(state.startedAt) - t0 }];
  });
  // The scale is based only on what events have reported so far.
  const total = Math.max(1, ...rows.map((r) => r.offset + (r.state.durationMs ?? 0)));

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <h2 className="mb-3 text-sm font-semibold text-slate-200">
        Timeline <span className="font-normal text-slate-500">· {total} ms so far</span>
      </h2>
      <ol className="space-y-1.5">
        {rows.map(({ step, state, offset }) => {
          const left = (offset / total) * 100;
          // A running step stretches to the end; a finished step without a
          // duration (CloudFront reports none) is a thin marker.
          const width =
            state.durationMs != null
              ? Math.max((state.durationMs / total) * 100, 0.75)
              : state.status === 'started'
                ? 100 - left
                : 0.75;
          return (
            <li key={step} className="grid grid-cols-[11rem_1fr_4.5rem] items-center gap-3 text-xs">
              <span className="truncate text-slate-300">{nodeInfo(step).title}</span>
              <div className="relative h-3 rounded bg-slate-800">
                <div
                  className={`absolute top-0 h-3 rounded ${BAR_COLORS[state.status]}`}
                  style={{ left: `${left}%`, width: `${width}%` }}
                />
              </div>
              <span className="text-right tabular-nums text-slate-400">
                {formatDuration(state)}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
