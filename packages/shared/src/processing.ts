/**
 * Key prefix for the worker's output in the processed bucket. The worker's IAM
 * policy only allows writing under it, and the bucket's lifecycle rule expires it.
 */
export const PROCESSED_PREFIX = 'processed/';

/** What the worker renders for every upload: the longest edge in pixels, as WebP. */
export const IMAGE_VARIANTS = {
  display: 1280,
  thumb: 320,
} as const;

export type ImageVariant = keyof typeof IMAGE_VARIANTS;

/**
 * `processed/{runId}/{variant}.webp`. CloudFront serves these keys as URLs, so
 * they leave out the session ID: a shared image link unlocks that image only,
 * not the session's gallery and live events. Run IDs are unguessable too
 * (UUIDv7: 74 random bits after the timestamp).
 */
export function processedKey(runId: string, variant: ImageVariant): string {
  return `${PROCESSED_PREFIX}${runId}/${variant}.webp`;
}

/**
 * How many times SQS hands a message to the worker before moving it to the
 * dead-letter queue (the queue's `maxReceiveCount`). AWS recommends at least 5
 * for Lambda, because throttled invocations also count as receives.
 */
export const WORKER_MAX_ATTEMPTS = 5;

/**
 * After a failed attempt the worker shortens the message's visibility timeout to
 * this, so the retry happens in seconds instead of after the full 60 s lease.
 */
export const RETRY_DELAY_SECONDS = 5;
