import { websocketUrl } from '@cloud-relay/shared';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { StepEventListener } from './event-stream.ts';
import {
  createLiveEventStream,
  type ConnectionStatus,
  type LiveEventStream,
} from './live-event-stream.ts';
import { createMockEventStream, type MockEventStream } from './mock-event-stream.ts';

export type EventSource =
  | { mode: 'mock'; stream: MockEventStream }
  | { mode: 'live'; stream: LiveEventStream; status: ConnectionStatus };

/**
 * Connects the page to its step events: the API Gateway WebSocket in the
 * deployed site, the scripted mock stream under `npm run dev` (which has no
 * backend). Either way, `onEvent` is the only thing that changes the diagram.
 */
export function useEventStream(sessionId: string, onEvent: StepEventListener): EventSource {
  // Creating a stream opens nothing; the effect below connects it.
  const [source] = useState(() =>
    import.meta.env.DEV
      ? ({ mode: 'mock', stream: createMockEventStream() } as const)
      : ({
          mode: 'live',
          stream: createLiveEventStream({
            getUrl: () => websocketUrl(window.location, sessionId),
          }),
        } as const),
  );

  useEffect(() => {
    const unsubscribe = source.stream.subscribe(onEvent);
    if (source.mode === 'live') source.stream.connect();
    return () => {
      unsubscribe();
      if (source.mode === 'live') source.stream.disconnect();
      else source.stream.dispose();
    };
  }, [source, onEvent]);

  const status = useSyncExternalStore(
    (onChange) => (source.mode === 'live' ? source.stream.subscribeStatus(onChange) : () => {}),
    () => (source.mode === 'live' ? source.stream.getStatus() : 'idle'),
    () => 'idle' as const,
  );

  return source.mode === 'live' ? { ...source, status } : source;
}
