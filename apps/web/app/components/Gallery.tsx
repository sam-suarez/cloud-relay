import { describeRejection, type GalleryItem } from '@cloud-relay/shared';
import { useEffect, useRef, useState } from 'react';
import type { Gallery as GalleryState } from '../lib/use-gallery.ts';

/**
 * The session's images, newest first: thumbnails for ready images (served by
 * CloudFront from the processed bucket), a tile for rejected ones.
 */
export function Gallery({ gallery }: { gallery: GalleryState }) {
  const [opened, setOpened] = useState<GalleryItem | null>(null);

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <header className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-200">
          This session{' '}
          <span className="font-normal text-slate-500">· newest first, deleted after a day</span>
        </h2>
        {gallery.status === 'error' && (
          <button
            type="button"
            onClick={gallery.refresh}
            className="rounded-lg border border-slate-600 px-2 py-0.5 text-xs text-slate-200 hover:bg-slate-800"
          >
            Try again
          </button>
        )}
      </header>

      {gallery.error && <p className="mb-3 text-xs text-rose-300">{gallery.error}</p>}
      <GalleryBody gallery={gallery} onOpen={setOpened} />
      <ImageDialog item={opened} onClose={() => setOpened(null)} />
    </section>
  );
}

function GalleryBody({
  gallery,
  onOpen,
}: {
  gallery: GalleryState;
  onOpen: (item: GalleryItem) => void;
}) {
  if (gallery.status === 'unavailable') {
    return (
      <p className="text-xs text-slate-400">
        The gallery reads the deployed API (GET /api/sessions/&#123;id&#125;/images), so it stays
        empty in local development.
      </p>
    );
  }
  if (gallery.items.length === 0) {
    return (
      <p className="text-xs text-slate-400">
        {gallery.status === 'loading'
          ? 'Loading…'
          : 'No photos yet. Each upload appears here once the worker saves its record in DynamoDB.'}
      </p>
    );
  }
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
      {gallery.items.map((item) => (
        <li key={item.runId}>
          {item.status === 'ready' && item.thumb ? (
            <button
              type="button"
              onClick={() => onOpen(item)}
              className="block w-full overflow-hidden rounded-lg border border-slate-800 bg-slate-950 text-left hover:border-sky-500/60 focus-visible:outline-2 focus-visible:outline-sky-400"
            >
              <img
                src={item.thumb.url}
                width={item.thumb.width}
                height={item.thumb.height}
                alt={altText(item)}
                loading="lazy"
                className="aspect-square w-full object-cover"
              />
              <Caption item={item}>
                {item.labels
                  .slice(0, 3)
                  .map((label) => label.name)
                  .join(' · ') || 'No labels'}
              </Caption>
            </button>
          ) : (
            <div className="overflow-hidden rounded-lg border border-rose-500/40 bg-rose-950/20">
              <div className="flex aspect-square flex-col justify-center gap-1 p-3 text-[11px] text-rose-200">
                <span className="font-semibold">Rejected</span>
                <span className="text-rose-300/80">
                  {item.rejection ? describeRejection(item.rejection) : 'rejected'}
                </span>
                <span className="text-slate-500">Files deleted</span>
              </div>
              <Caption item={item}>No image kept</Caption>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function Caption({ item, children }: { item: GalleryItem; children: string }) {
  return (
    <div className="space-y-0.5 p-2 text-[11px]">
      <div className="truncate text-slate-300">{children}</div>
      <time className="text-slate-500" dateTime={item.createdAt}>
        {new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </time>
    </div>
  );
}

/** The 1280 px display image and its labels, in a native modal dialog (Esc closes it). */
function ImageDialog({ item, onClose }: { item: GalleryItem | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (item && !dialog?.open) dialog?.showModal();
    if (!item && dialog?.open) dialog.close();
  }, [item]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      // A click on the dialog element itself (not its content) is on the backdrop.
      onClick={(e) => {
        if (e.target === e.currentTarget) e.currentTarget.close();
      }}
      className="m-auto max-w-[min(64rem,calc(100vw-2rem))] rounded-xl border border-slate-700 bg-slate-950 p-0 text-slate-200 backdrop:bg-black/70"
    >
      {item?.display && (
        <figure>
          <img
            src={item.display.url}
            width={item.display.width}
            height={item.display.height}
            alt={altText(item)}
            className="max-h-[75vh] w-auto"
          />
          <figcaption className="flex flex-wrap items-center gap-1.5 p-3 text-xs">
            {item.labels.map((label) => (
              <span
                key={label.name}
                className="rounded-full bg-emerald-950 px-2 py-0.5 text-emerald-200"
              >
                {label.name} {Math.round(label.confidence)}%
              </span>
            ))}
            <span className="text-slate-500">
              {item.display.width}×{item.display.height} WebP · {item.display.url}
            </span>
            <button
              type="button"
              onClick={() => ref.current?.close()}
              className="ml-auto rounded-lg border border-slate-600 px-2 py-0.5 text-slate-200 hover:bg-slate-800"
            >
              Close
            </button>
          </figcaption>
        </figure>
      )}
    </dialog>
  );
}

function altText(item: GalleryItem): string {
  const labels = item.labels.map((label) => label.name).join(', ');
  return labels ? `Uploaded photo: ${labels}` : 'Uploaded photo';
}
