import { parseStepEvent } from '@cloud-relay/shared';
import type { EventStream, StepEventListener } from './event-stream.ts';

export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'reconnecting';

/**
 * Step events pushed by the backend over the API Gateway WebSocket API.
 *
 * The browser only listens: it opens `wss://<site>/ws?sessionId=…` and the
 * Lambdas push every step event of this session to it.
 */
export interface LiveEventStream extends EventStream {
  /** Opens the socket. Safe to call again after `disconnect()`. */
  connect(): void;
  /** Closes the socket and stops reconnecting, but keeps subscribers. */
  disconnect(): void;
  /** Resolves true once the socket is open, or false after `timeoutMs`. */
  whenOpen(timeoutMs?: number): Promise<boolean>;
  getStatus(): ConnectionStatus;
  /** For React's useSyncExternalStore. Returns an unsubscribe function. */
  subscribeStatus(onChange: () => void): () => void;
}

export interface LiveEventStreamOptions {
  /** Called on every (re)connect, so the URL is only built in the browser. */
  getUrl: () => string;
  /** Tests pass a fake socket. */
  createSocket?: (url: string) => WebSocket;
}

/** Reconnect after 1 s, then 2 s, 4 s… up to 30 s. Back to 1 s once a connection opens. */
const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

/**
 * API Gateway closes a WebSocket after 10 idle minutes, and every WebSocket
 * after 2 hours, so the stream reconnects whenever its socket closes. Each
 * reconnect runs the $connect Lambda again, which records the new connection.
 */
export function createLiveEventStream({
  getUrl,
  createSocket = (url) => new WebSocket(url),
}: LiveEventStreamOptions): LiveEventStream {
  const listeners = new Set<StepEventListener>();
  const statusListeners = new Set<() => void>();
  let status: ConnectionStatus = 'idle';
  let socket: WebSocket | null = null;
  let retryMs = FIRST_RETRY_MS;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  function setStatus(next: ConnectionStatus) {
    status = next;
    for (const onChange of statusListeners) onChange();
  }

  function open() {
    const current = createSocket(getUrl());
    socket = current;

    current.onopen = () => {
      retryMs = FIRST_RETRY_MS;
      setStatus('open');
    };
    current.onmessage = (message: MessageEvent) => {
      if (typeof message.data !== 'string') return;
      let json: unknown;
      try {
        json = JSON.parse(message.data);
      } catch {
        return;
      }
      // Same schema the Lambdas validated against. Anything else is ignored.
      const event = parseStepEvent(json);
      if (event) for (const listener of listeners) listener(event);
    };
    // Also fires after a failed handshake (e.g. $connect refused it).
    current.onclose = () => {
      if (socket !== current) return; // closed on purpose by disconnect()
      socket = null;
      setStatus('reconnecting');
      retryTimer = setTimeout(open, retryMs);
      retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
    };
  }

  function disconnect() {
    clearTimeout(retryTimer);
    const current = socket;
    socket = null;
    current?.close(1000);
    setStatus('idle');
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    connect() {
      if (socket || status === 'reconnecting') return;
      setStatus('connecting');
      open();
    },

    disconnect,

    dispose() {
      disconnect();
      listeners.clear();
      statusListeners.clear();
    },

    whenOpen(timeoutMs = 5_000) {
      if (status === 'open') return Promise.resolve(true);
      return new Promise((resolve) => {
        const onChange = () => {
          if (status !== 'open') return;
          finish(true);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        function finish(opened: boolean) {
          clearTimeout(timer);
          statusListeners.delete(onChange);
          resolve(opened);
        }
        statusListeners.add(onChange);
      });
    },

    getStatus: () => status,

    subscribeStatus(onChange) {
      statusListeners.add(onChange);
      return () => statusListeners.delete(onChange);
    },
  };
}
