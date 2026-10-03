import { useEffect, useMemo, useReducer, useState } from 'react';
import { ArchitectureDiagram } from '../components/ArchitectureDiagram.tsx';
import { NodeDetailPanel } from '../components/NodeDetailPanel.tsx';
import { TimelineView } from '../components/TimelineView.tsx';
import { UploadPanel } from '../components/UploadPanel.tsx';
import { createMockEventStream } from '../lib/mock-event-stream.ts';
import type { NodeId } from '../lib/pipeline.ts';
import { applyEvent, runStatus } from '../lib/run-state.ts';
import { getSessionId } from '../lib/session.ts';

export function meta() {
  return [
    { title: 'Cloud Relay' },
    { name: 'description', content: 'Watch a photo upload travel through AWS, step by step.' },
  ];
}

export default function Home() {
  const [sessionId] = useState(getSessionId);
  const stream = useMemo(() => createMockEventStream(), []);
  const [run, dispatch] = useReducer(applyEvent, null);
  const [selected, setSelected] = useState<NodeId | null>(null);

  // The UI only changes when an event arrives from the stream.
  useEffect(() => stream.subscribe(dispatch), [stream]);
  useEffect(() => () => stream.dispose(), [stream]);

  const busy = run !== null && runStatus(run) === 'running';

  return (
    <main className="mx-auto max-w-7xl space-y-4 p-4 md:p-6">
      <header className="flex items-baseline justify-between">
        <h1 className="text-xl font-bold tracking-tight">Cloud Relay</h1>
        <span className="rounded-full border border-amber-500/50 px-2 py-0.5 text-xs text-amber-300">
          mock event stream
        </span>
      </header>

      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <ArchitectureDiagram run={run} selected={selected} onSelect={setSelected} />
        <div className="space-y-4">
          <UploadPanel
            sessionId={sessionId}
            busy={busy}
            // Until Phase 6 the mock replays the pipeline under the real runId.
            onUploaded={(runId) => stream.startRun({ sessionId, runId })}
            onSimulate={({ fail }) =>
              stream.startRun({ sessionId, failAt: fail ? 'resize' : undefined })
            }
          />
          <NodeDetailPanel nodeId={selected} run={run} onClose={() => setSelected(null)} />
        </div>
      </div>

      <TimelineView run={run} />
    </main>
  );
}
