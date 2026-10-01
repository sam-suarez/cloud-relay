interface Props {
  sessionId: string;
  busy: boolean;
  onRun: (options: { fail: boolean }) => void;
}

/** Triggers scripted runs on the mock stream until the upload API exists. */
export function UploadPanel({ sessionId, busy, onRun }: Props) {
  return (
    <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <h2 className="text-sm font-semibold text-slate-200">Upload</h2>
      <p className="text-xs text-slate-400">
        Local mock mode: events come from a scripted stream that uses the real event schema.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => onRun({ fail: false })}
          className="rounded-lg bg-sky-500 px-3 py-1.5 text-sm font-medium text-slate-950 hover:bg-sky-400 disabled:opacity-50"
        >
          Simulate upload
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onRun({ fail: true })}
          className="rounded-lg border border-rose-500/60 px-3 py-1.5 text-sm text-rose-200 hover:bg-rose-950 disabled:opacity-50"
        >
          Simulate worker failure
        </button>
      </div>
      <p className="font-mono text-[10px] text-slate-500">session {sessionId}</p>
    </section>
  );
}
