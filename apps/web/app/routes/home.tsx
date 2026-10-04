import { useReducer, useState } from 'react';
import { ArchitectureDiagram } from '../components/ArchitectureDiagram.tsx';
import { NodeDetailPanel } from '../components/NodeDetailPanel.tsx';
import { RunResult } from '../components/RunResult.tsx';
import { TimelineView } from '../components/TimelineView.tsx';
import { UploadPanel } from '../components/UploadPanel.tsx';
import type { NodeId } from '../lib/pipeline.ts';
import { applyEvent, runStatus } from '../lib/run-state.ts';
import { getSessionId } from '../lib/session.ts';
import { useEventStream, type EventSource } from '../lib/use-event-stream.ts';

export function meta() {
  return [
    { title: 'Cloud Relay' },
    { name: 'description', content: 'Watch a photo upload travel through AWS, step by step.' },
  ];
}

export default function Home() {
  const [sessionId] = useState(getSessionId);
  const [run, dispatch] = useReducer(applyEvent, null);
  const [selected, setSelected] = useState<NodeId | null>(null);
  // The UI only changes when an event arrives from the stream.
  const source = useEventStream(sessionId, dispatch);

  const busy = run !== null && runStatus(run) === 'running';

  return (
    <main className="mx-auto max-w-7xl space-y-4 p-4 md:p-6">
      <header className="flex items-baseline justify-between">
        <h1 className="text-xl font-bold tracking-tight">Cloud Relay</h1>
        <StreamBadge source={source} />
      </header>

      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <ArchitectureDiagram run={run} selected={selected} onSelect={setSelected} />
        <div className="space-y-4">
          {source.mode === 'live' ? (
            <UploadPanel
              sessionId={sessionId}
              busy={busy}
              beforeUpload={() => source.stream.whenOpen()}
            />
          ) : (
            <UploadPanel
              sessionId={sessionId}
              busy={busy}
              // Local development has no backend: the mock replays the pipeline
              // under the real runId (if the upload API was reachable at all).
              onUploaded={(runId, { simulateFailure }) =>
                source.stream.startRun({
                  sessionId,
                  runId,
                  failAt: simulateFailure ? 'resize' : undefined,
                })
              }
              onSimulate={({ fail }) =>
                source.stream.startRun({ sessionId, failAt: fail ? 'resize' : undefined })
              }
            />
          )}
          <RunResult run={run} />
          <NodeDetailPanel nodeId={selected} run={run} onClose={() => setSelected(null)} />
        </div>
      </div>

      <TimelineView run={run} />
    </main>
  );
}

const BADGES = {
  mock: ['border-amber-500/50 text-amber-300', 'mock event stream'],
  idle: ['border-slate-600 text-slate-400', 'offline'],
  connecting: ['border-slate-600 text-slate-300', 'connecting…'],
  open: ['border-emerald-500/50 text-emerald-300', 'live · WebSocket open'],
  reconnecting: ['border-amber-500/50 text-amber-300', 'reconnecting…'],
} as const;

function StreamBadge({ source }: { source: EventSource }) {
  const [style, label] = BADGES[source.mode === 'mock' ? 'mock' : source.status];
  return <span className={`rounded-full border px-2 py-0.5 text-xs ${style}`}>{label}</span>;
}
