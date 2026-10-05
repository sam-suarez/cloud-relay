import type { GalleryItem } from '@cloud-relay/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { GalleryError, fetchGallery } from './gallery.ts';
import type { EventSource } from './use-event-stream.ts';

export interface Gallery {
  /** `unavailable` on the mock stream: local development has no API. */
  status: 'unavailable' | 'loading' | 'ready' | 'error';
  /** Newest first. Kept on error, so a failed refresh doesn't empty the gallery. */
  items: GalleryItem[];
  error: string | null;
  refresh: () => void;
}

/**
 * The session's images from the gallery API. Fetched when the page loads, and
 * again whenever an event says there may be something new. No polling, no
 * timers:
 * - the WebSocket reopened: the closed socket may have missed a run's events;
 * - a run's final push (`notify`) arrived: its record is saved by now.
 */
export function useGallery(sessionId: string, source: EventSource): Gallery {
  const live = source.mode === 'live';
  const [state, setState] = useState<Omit<Gallery, 'refresh'>>({
    status: live ? 'loading' : 'unavailable',
    items: [],
    error: null,
  });
  // Responses can arrive out of order; only the latest request's counts.
  const latest = useRef(0);

  const refresh = useCallback(() => {
    if (!live) return;
    const request = ++latest.current;
    fetchGallery(sessionId).then(
      (items) => {
        if (request === latest.current) setState({ status: 'ready', items, error: null });
      },
      (error: unknown) => {
        if (request !== latest.current) return;
        const message =
          error instanceof GalleryError ? error.message : 'Could not load the gallery.';
        setState((previous) => ({ ...previous, status: 'error', error: message }));
      },
    );
  }, [sessionId, live]);

  useEffect(refresh, [refresh]);

  // The first open needs no fetch (the page just loaded); every later one is a
  // reconnect, after which a run that finished meanwhile can only be found here.
  const status = live ? source.status : null;
  const opened = useRef(false);
  useEffect(() => {
    if (status !== 'open') return;
    if (opened.current) refresh();
    opened.current = true;
  }, [status, refresh]);

  const stream = source.stream;
  useEffect(() => {
    if (!live) return;
    return stream.subscribe((event) => {
      if (event.step === 'notify') refresh();
    });
  }, [live, stream, refresh]);

  return { ...state, refresh };
}
