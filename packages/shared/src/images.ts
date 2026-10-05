import { z } from 'zod';

/**
 * How long an image record lives: DynamoDB's TTL deletes it some time after
 * `expiresAt`. Matches the one-day S3 lifecycle rules on uploads/ and processed/.
 */
export const IMAGE_RECORD_TTL_SECONDS = 24 * 60 * 60;

/**
 * At most this many images go to Rekognition per UTC day. Past it the worker
 * rejects uploads without calling Rekognition, which caps a flood of uploads
 * at about $0.40 a day (two $0.001 calls per image).
 */
export const DAILY_ANALYSIS_LIMIT = 200;

export const ImageStatusSchema = z.enum(['ready', 'rejected']);
export type ImageStatus = z.infer<typeof ImageStatusSchema>;

export const ImageFileSchema = z.object({
  key: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  bytes: z.number().int().nonnegative(),
});
export type ImageFile = z.infer<typeof ImageFileSchema>;

/** What Rekognition's DetectLabels found, e.g. { name: 'Lake', confidence: 99.1 }. */
export const ImageLabelSchema = z.object({ name: z.string(), confidence: z.number() });
export type ImageLabel = z.infer<typeof ImageLabelSchema>;

/** One DetectModerationLabels hit. `level` is 1 for a top-level category, 2–3 for details. */
export const ModerationLabelSchema = z.object({
  name: z.string(),
  parentName: z.string(),
  level: z.number().int().min(1).max(3),
  confidence: z.number(),
});
export type ModerationLabel = z.infer<typeof ModerationLabelSchema>;

export const RejectionSchema = z.object({
  reason: z.enum(['moderation', 'daily-limit']),
  /** The blocked moderation categories that matched. Empty for `daily-limit`. */
  categories: z.array(z.string()),
});
export type Rejection = z.infer<typeof RejectionSchema>;

/** Why an image was rejected, in words, e.g. "moderation: Violence". */
export function describeRejection(rejection: Rejection): string {
  return rejection.reason === 'moderation'
    ? `moderation: ${rejection.categories.join(', ')}`
    : `daily analysis limit reached (${DAILY_ANALYSIS_LIMIT} images)`;
}

/**
 * One item in the Images table: partition key `sessionId`, sort key `runId`.
 * Run IDs are UUIDv7s, so a session's images sort by upload time.
 */
export const ImageRecordSchema = z.object({
  sessionId: z.uuid(),
  runId: z.uuid(),
  status: ImageStatusSchema,
  /** When S3 received the upload. */
  createdAt: z.iso.datetime(),
  /**
   * The TTL attribute: Unix time in seconds. TTL deletes lag by up to a few
   * days, so readers must also skip items whose `expiresAt` has passed.
   */
  expiresAt: z.number().int().positive(),
  originalBytes: z.number().int().nonnegative(),
  /** null when the image was rejected (its files are deleted). */
  display: ImageFileSchema.nullable(),
  thumb: ImageFileSchema.nullable(),
  labels: z.array(ImageLabelSchema),
  moderation: z.array(ModerationLabelSchema),
  rejection: RejectionSchema.nullable(),
});
export type ImageRecord = z.infer<typeof ImageRecordSchema>;

/** Unix time in seconds at which a record created at `createdAt` expires. */
export function imageExpiresAt(createdAt: string): number {
  return Math.floor(Date.parse(createdAt) / 1000) + IMAGE_RECORD_TTL_SECONDS;
}
