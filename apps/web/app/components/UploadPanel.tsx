import { MAX_UPLOAD_BYTES, UPLOAD_CONTENT_TYPES } from '@cloud-relay/shared';
import { useState } from 'react';
import { UploadError, uploadPhoto } from '../lib/upload.ts';

interface Props {
  sessionId: string;
  busy: boolean;
  /** Called after S3 accepted the file, with the runId the presign Lambda assigned. */
  onUploaded: (runId: string) => void;
  onSimulate: (options: { fail: boolean }) => void;
}

type UploadState =
  | { status: 'idle' }
  | { status: 'uploading' }
  | { status: 'done'; key: string }
  | { status: 'error'; message: string };

const ACCEPT = Object.keys(UPLOAD_CONTENT_TYPES).join(',');

/** Real upload through the API (presigned POST to S3), plus scripted runs on the mock stream. */
export function UploadPanel({ sessionId, busy, onUploaded, onSimulate }: Props) {
  const [state, setState] = useState<UploadState>({ status: 'idle' });
  const disabled = busy || state.status === 'uploading';

  async function upload(file: File) {
    setState({ status: 'uploading' });
    try {
      const { key, runId } = await uploadPhoto(file, sessionId);
      setState({ status: 'done', key });
      onUploaded(runId);
    } catch (error) {
      const message =
        error instanceof UploadError ? error.message : 'Upload failed. Check your connection.';
      setState({ status: 'error', message });
    }
  }

  return (
    <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <h2 className="text-sm font-semibold text-slate-200">Upload</h2>

      <label
        className={`block rounded-lg bg-sky-500 px-3 py-1.5 text-center text-sm font-medium text-slate-950 hover:bg-sky-400 ${
          disabled ? 'pointer-events-none opacity-50' : 'cursor-pointer'
        }`}
      >
        {state.status === 'uploading' ? 'Uploading…' : 'Upload a photo'}
        <input
          type="file"
          accept={ACCEPT}
          disabled={disabled}
          className="sr-only"
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            e.currentTarget.value = ''; // lets you pick the same file again
            if (file) void upload(file);
          }}
        />
      </label>
      <p className="text-xs text-slate-400">
        JPEG, PNG or WebP up to {MAX_UPLOAD_BYTES / 1024 / 1024} MB. Deleted after a day.
      </p>

      {state.status === 'done' && (
        <p className="text-xs text-emerald-300">
          S3 stored <span className="font-mono break-all">{state.key}</span>
        </p>
      )}
      {state.status === 'error' && <p className="text-xs text-rose-300">{state.message}</p>}

      <p className="border-t border-slate-800 pt-3 text-xs text-slate-400">
        The diagram still plays the mock event stream (live events arrive in Phase 6).
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onSimulate({ fail: false })}
          className="rounded-lg border border-slate-600 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50"
        >
          Simulate upload
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onSimulate({ fail: true })}
          className="rounded-lg border border-rose-500/60 px-3 py-1.5 text-sm text-rose-200 hover:bg-rose-950 disabled:opacity-50"
        >
          Simulate worker failure
        </button>
      </div>
      <p className="font-mono text-[10px] text-slate-500">session {sessionId}</p>
    </section>
  );
}
