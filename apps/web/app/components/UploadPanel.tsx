import { MAX_UPLOAD_BYTES, UPLOAD_CONTENT_TYPES, WORKER_MAX_ATTEMPTS } from '@cloud-relay/shared';
import { useState } from 'react';
import { UploadError, uploadPhoto } from '../lib/upload.ts';

interface Props {
  sessionId: string;
  busy: boolean;
  /** Runs before asking for an upload URL, e.g. waiting for the WebSocket to open. */
  beforeUpload?: () => Promise<unknown>;
  /** Called after S3 accepted the file, with the runId the presign Lambda assigned. */
  onUploaded?: (runId: string, options: { simulateFailure: boolean }) => void;
  /** Mock stream only: plays a scripted run without uploading anything. */
  onSimulate?: (options: { fail: boolean }) => void;
}

type UploadState =
  | { status: 'idle' }
  | { status: 'uploading' }
  | { status: 'done'; key: string }
  | { status: 'error'; message: string };

const ACCEPT = Object.keys(UPLOAD_CONTENT_TYPES).join(',');

/** Real upload through the API (presigned POST to S3), plus scripted runs on the mock stream. */
export function UploadPanel({ sessionId, busy, beforeUpload, onUploaded, onSimulate }: Props) {
  const [state, setState] = useState<UploadState>({ status: 'idle' });
  const [simulateFailure, setSimulateFailure] = useState(false);
  const disabled = busy || state.status === 'uploading';

  async function upload(file: File) {
    setState({ status: 'uploading' });
    try {
      // The first events (edge, api, presign) are pushed while this request is
      // in flight, so the socket must already be open to receive them.
      await beforeUpload?.();
      const { key, runId } = await uploadPhoto(file, sessionId, { simulateFailure });
      setState({ status: 'done', key });
      onUploaded?.(runId, { simulateFailure });
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
        JPEG, PNG or WebP up to {MAX_UPLOAD_BYTES / 1024 / 1024} MB. Deleted after a day. Photos are
        analyzed by Amazon Rekognition, and AWS may keep them to improve its AI services.
      </p>
      <label className="flex items-start gap-2 text-xs text-slate-300">
        <input
          type="checkbox"
          checked={simulateFailure}
          disabled={disabled}
          onChange={(e) => setSimulateFailure(e.currentTarget.checked)}
          className="mt-0.5 accent-rose-500"
        />
        <span>
          Make the worker fail: SQS retries it {WORKER_MAX_ATTEMPTS} times, then moves it to the
          dead-letter queue.
        </span>
      </label>

      {state.status === 'done' && (
        <p className="text-xs text-emerald-300">
          S3 stored <span className="font-mono break-all">{state.key}</span>
        </p>
      )}
      {state.status === 'error' && <p className="text-xs text-rose-300">{state.message}</p>}

      {onSimulate && (
        <>
          <p className="border-t border-slate-800 pt-3 text-xs text-slate-400">
            Local development: the diagram plays a scripted mock event stream.
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
        </>
      )}
      <p className="font-mono text-[10px] text-slate-500">session {sessionId}</p>
    </section>
  );
}
