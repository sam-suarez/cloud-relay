import type { ReactNode } from 'react';
import { nodeInfo, type NodeId } from '../lib/pipeline.ts';
import { formatDuration, type RunState } from '../lib/run-state.ts';

interface Props {
  nodeId: NodeId | null;
  run: RunState | null;
  onClose: () => void;
}

export function NodeDetailPanel({ nodeId, run, onClose }: Props) {
  if (!nodeId) {
    return (
      <aside className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-sm text-slate-400">
        Click any service in the diagram to see what it did for your upload.
      </aside>
    );
  }

  const info = nodeInfo(nodeId);
  const state = nodeId === 'browser' ? undefined : run?.steps[nodeId];

  return (
    <aside className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-sm">
      <header className="flex items-start justify-between gap-2">
        <div>
          <div className="text-xs uppercase tracking-wider text-slate-500">{info.service}</div>
          <h2 className="text-lg font-semibold text-slate-100">{info.title}</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded px-2 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
          aria-label="Close details"
        >
          ×
        </button>
      </header>

      <Section title="What it is">{info.about}</Section>
      <Section title="Its job here">{info.role}</Section>

      {state?.status === 'missed' && (
        <Section title="Event missed">
          This step&apos;s last event never reached this tab: WebSocket pushes are at-most-once (a
          throttled post or a reconnect loses them). The image record in DynamoDB shows the run
          finished, so the page caught up from the gallery API instead.
        </Section>
      )}

      {state && (
        <Section title="This upload">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-xs">
            <dt className="text-slate-500">status</dt>
            <dd>{state.status}</dd>
            <dt className="text-slate-500">duration</dt>
            <dd>{formatDuration(state)}</dd>
            {state.attempts > 1 && (
              <>
                <dt className="text-slate-500">attempts</dt>
                <dd>{state.attempts}</dd>
              </>
            )}
            {Object.entries(state.detail).map(([key, value]) => (
              <DetailRow key={key} label={key} value={String(value)} />
            ))}
          </dl>
        </Section>
      )}

      {info.iamAction && (
        <Section title="IAM permission used">
          <code className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-sky-300">
            {info.iamAction}
          </code>
        </Section>
      )}

      {state?.logRef && (
        <Section title="Log line">
          <div className="font-mono text-xs text-slate-400">
            {state.logRef.logGroup}
            <br />
            requestId {state.logRef.requestId}
          </div>
        </Section>
      )}
    </aside>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-1 text-xs font-medium uppercase tracking-wider text-slate-500">{title}</h3>
      <div className="text-slate-300">{children}</div>
    </section>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-slate-500">{label}</dt>
      <dd className="break-all">{value}</dd>
    </>
  );
}
