import { StepEventSchema, type StepEvent } from '@cloud-relay/shared';

/**
 * Sends a step event to the visitor's browser.
 *
 * Placeholder until Phase 6, which pushes it over the WebSocket API. For now it
 * validates the event and writes it to the function's log, so you can see in
 * CloudWatch exactly what the browser will receive later.
 */
export async function emit(event: StepEvent): Promise<void> {
  console.log(JSON.stringify({ stepEvent: StepEventSchema.parse(event) }));
}
