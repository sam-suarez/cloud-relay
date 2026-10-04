import { StepEventSchema, type StepEvent } from '@cloud-relay/shared';

/**
 * Sends a step event to the visitor's browser.
 *
 * Same placeholder as services/api/src/emit.ts until Phase 6, which pushes it
 * over the WebSocket API (and gives both services one shared emitter). For now
 * it validates the event and writes it to the function's log.
 */
export async function emit(event: StepEvent): Promise<void> {
  console.log(JSON.stringify({ stepEvent: StepEventSchema.parse(event) }));
}
