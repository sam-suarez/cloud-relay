import { Background, MarkerType, ReactFlow, type Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useMemo } from 'react';
import { EDGES, NODES, type NodeId } from '../lib/pipeline.ts';
import type { RunState, StepState } from '../lib/run-state.ts';
import { ServiceNode, type ServiceNodeType } from './ServiceNode.tsx';

const nodeTypes = { service: ServiceNode };

interface Props {
  run: RunState | null;
  selected: NodeId | null;
  onSelect: (id: NodeId) => void;
}

/** The browser node "lights up" when it receives the final WebSocket message. */
function stateFor(run: RunState | null, id: NodeId): StepState | undefined {
  if (!run) return undefined;
  if (id === 'browser') {
    const notify = run.steps.notify;
    return notify?.status === 'succeeded' ? { ...notify, durationMs: null } : undefined;
  }
  return run.steps[id];
}

export function ArchitectureDiagram({ run, selected, onSelect }: Props) {
  const nodes = useMemo<ServiceNodeType[]>(
    () =>
      NODES.map((n) => ({
        id: n.id,
        type: 'service',
        position: n.position,
        data: {
          title: n.title,
          service: n.service,
          state: stateFor(run, n.id),
          selected: selected === n.id,
        },
        draggable: false,
      })),
    [run, selected],
  );

  const edges = useMemo<Edge[]>(
    () =>
      EDGES.map((e) => {
        // Data is "moving" along an edge while the step it leads to is running.
        const target = stateFor(run, e.to)?.status;
        const color =
          target === 'failed'
            ? '#f43f5e'
            : target === 'succeeded'
              ? '#10b981'
              : target === 'started'
                ? '#fbbf24'
                : target === 'missed'
                  ? '#94a3b8'
                  : '#475569';
        return {
          id: `${e.from}->${e.to}`,
          source: e.from,
          target: e.to,
          sourceHandle: `s-${e.fromSide}`,
          targetHandle: `t-${e.toSide}`,
          animated: target === 'started',
          style: { stroke: color, strokeWidth: 2 },
          markerEnd: { type: MarkerType.ArrowClosed, color },
        };
      }),
    [run],
  );

  return (
    <div className="h-[520px] w-full rounded-xl border border-slate-800 bg-slate-950">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        colorMode="dark"
        fitView
        nodesConnectable={false}
        onNodeClick={(_, node) => onSelect(node.id as NodeId)}
        proOptions={{ hideAttribution: false }}
      >
        <Background gap={24} />
      </ReactFlow>
    </div>
  );
}
