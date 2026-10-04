import type { StepEvent } from '@cloud-relay/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLiveEventStream } from './live-event-stream.ts';

const event: StepEvent = {
  runId: '0199a8f2-6b3a-7c1d-9e2f-3a4b5c6d7e8f',
  sessionId: '0b1c2d3e-4f50-4a6b-8c7d-8e9fa0b1c2d3',
  step: 'resize',
  service: 'lambda',
  status: 'started',
  startedAt: '2026-10-04T15:38:36.242Z',
  durationMs: null,
  detail: { attempt: 1 },
  logRef: null,
};

/** Just enough of a browser WebSocket for the stream to drive. */
class FakeSocket {
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  close = vi.fn(() => this.onclose?.());
  constructor(readonly url: string) {}
}

let sockets: FakeSocket[];
const latest = () => sockets.at(-1) as FakeSocket;

function createStream() {
  return createLiveEventStream({
    getUrl: () => 'wss://example.test/ws?sessionId=abc',
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
}

beforeEach(() => {
  sockets = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createLiveEventStream', () => {
  it('connects only when asked, to the URL built at that moment', () => {
    const stream = createStream();
    expect(sockets).toHaveLength(0);
    expect(stream.getStatus()).toBe('idle');

    stream.connect();

    expect(latest().url).toBe('wss://example.test/ws?sessionId=abc');
    expect(stream.getStatus()).toBe('connecting');
    latest().onopen?.();
    expect(stream.getStatus()).toBe('open');
  });

  it('passes valid step events to subscribers and ignores anything else', () => {
    const stream = createStream();
    const listener = vi.fn();
    stream.subscribe(listener);
    stream.connect();

    latest().onmessage?.({ data: JSON.stringify(event) });
    latest().onmessage?.({ data: 'not json' });
    latest().onmessage?.({ data: JSON.stringify({ message: 'Forbidden' }) });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(event);
  });

  it('reconnects with a growing delay, and resets the delay once connected', () => {
    const stream = createStream();
    stream.connect();

    latest().onclose?.(); // e.g. API Gateway's 10-minute idle timeout
    expect(stream.getStatus()).toBe('reconnecting');
    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);

    latest().onclose?.(); // refused again
    vi.advanceTimersByTime(1_999);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);

    latest().onopen?.();
    latest().onclose?.();
    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(4);
  });

  it('closes cleanly on disconnect, without reconnecting, and can connect again', () => {
    const stream = createStream();
    stream.connect();
    const first = latest();

    stream.disconnect();
    vi.advanceTimersByTime(60_000);

    expect(first.close).toHaveBeenCalledWith(1000);
    expect(sockets).toHaveLength(1);
    expect(stream.getStatus()).toBe('idle');

    stream.connect();
    expect(sockets).toHaveLength(2);
  });

  it('whenOpen resolves true when the socket opens, or false after the timeout', async () => {
    const stream = createStream();
    stream.connect();

    const opened = stream.whenOpen(5_000);
    latest().onopen?.();
    await expect(opened).resolves.toBe(true);
    await expect(stream.whenOpen()).resolves.toBe(true);

    latest().onclose?.();
    const timedOut = stream.whenOpen(5_000);
    vi.advanceTimersByTime(5_000);
    await expect(timedOut).resolves.toBe(false);
  });

  it('tells status subscribers about every change', () => {
    const stream = createStream();
    const onChange = vi.fn();
    const unsubscribe = stream.subscribeStatus(onChange);

    stream.connect();
    latest().onopen?.();
    unsubscribe();
    latest().onclose?.();

    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
