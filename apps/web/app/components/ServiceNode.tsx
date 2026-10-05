import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { motion } from 'motion/react';
import type { StepState } from '../lib/run-state.ts';

export type ServiceNodeData = {
  title: string;
  service: string;
  state: StepState | undefined;
  selected: boolean;
};

export type ServiceNodeType = Node<ServiceNodeData, 'service'>;

const STATUS_STYLES = {
  idle: 'border-slate-700 bg-slate-900 text-slate-400',
  started: 'border-amber-400 bg-amber-950/60 text-amber-100',
  succeeded: 'border-emerald-500 bg-emerald-950/60 text-emerald-100',
  failed: 'border-rose-500 bg-rose-950/60 text-rose-100',
  // The run finished (its record exists), but this step's closing event was lost.
  missed: 'border-dashed border-slate-500 bg-slate-900 text-slate-300',
} as const;

const SIDES = [Position.Top, Position.Right, Position.Bottom, Position.Left];

export function ServiceNode({ data }: NodeProps<ServiceNodeType>) {
  const status = data.state?.status ?? 'idle';
  const duration = data.state?.durationMs;

  return (
    <motion.div
      className={`w-48 rounded-lg border-2 px-3 py-2 text-left shadow-lg transition-colors ${STATUS_STYLES[status]} ${data.selected ? 'ring-2 ring-sky-400' : ''}`}
      // A short "pulse" each time the status changes, driven by the event that changed it.
      key={status}
      initial={{ scale: status === 'idle' ? 1 : 1.08 }}
      animate={{ scale: 1 }}
      transition={{ type: 'spring', stiffness: 400, damping: 18 }}
    >
      {/* One source and one target handle per side, so edges can leave/enter from any side. */}
      {SIDES.map((side) => (
        <Handle key={`t-${side}`} id={`t-${side}`} type="target" position={side} />
      ))}
      {SIDES.map((side) => (
        <Handle key={`s-${side}`} id={`s-${side}`} type="source" position={side} />
      ))}

      <div className="text-[10px] font-medium uppercase tracking-wider opacity-70">
        {data.service}
      </div>
      <div className="text-sm font-semibold">{data.title}</div>
      <div className="mt-1 h-4 text-xs tabular-nums">
        {status === 'started' && <span className="animate-pulse">working…</span>}
        {status === 'missed' && 'event missed'}
        {(status === 'succeeded' || status === 'failed') && duration != null && `${duration} ms`}
        {data.state && data.state.attempts > 1 && ` · attempt ${data.state.attempts}`}
      </div>
    </motion.div>
  );
}
