import type { StepEvent } from '@cloud-relay/shared';

export type StepEventListener = (event: StepEvent) => void;

/**
 * Anything that delivers backend step events to the UI.
 * Implemented by the local mock stream and by the API Gateway WebSocket
 * client, so the UI doesn't care which one it's talking to.
 */
export interface EventStream {
  /** Returns an unsubscribe function. */
  subscribe(listener: StepEventListener): () => void;
  /** Stops timers or closes connections. */
  dispose(): void;
}
