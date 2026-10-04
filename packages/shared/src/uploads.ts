import { z } from 'zod';

/** Image types the demo accepts, mapped to the file extension used in the S3 key. */
export const UPLOAD_CONTENT_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;

export type UploadContentType = keyof typeof UPLOAD_CONTENT_TYPES;

/** 5 MB. Checked here for a friendly error, and enforced by S3 through the signed policy. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** How long a presigned POST stays valid. Short, because the browser uses it right away. */
export const UPLOAD_URL_TTL_SECONDS = 60;

/**
 * Key prefix for original uploads. The presign Lambda writes under it, its IAM
 * policy only allows it, and the bucket's lifecycle rule expires it.
 */
export const UPLOADS_PREFIX = 'uploads/';

const contentTypes = Object.keys(UPLOAD_CONTENT_TYPES) as [
  UploadContentType,
  ...UploadContentType[],
];

/**
 * S3 user metadata that tells the worker to fail on purpose, so visitors can
 * watch SQS retry and then park the message in the dead-letter queue. The
 * browser sends it as the form field `x-amz-meta-simulate-failure`; the worker
 * reads it back from GetObject as `Metadata['simulate-failure']`.
 */
export const SIMULATE_FAILURE_METADATA = 'simulate-failure';

/** Body of `POST /api/uploads`. The browser describes the file; the server picks the key. */
export const CreateUploadRequestSchema = z.object({
  contentType: z.enum(contentTypes),
  size: z.number().int().positive().max(MAX_UPLOAD_BYTES),
  sessionId: z.uuid(),
  simulateFailure: z.boolean().default(false),
});
export type CreateUploadRequest = z.infer<typeof CreateUploadRequestSchema>;

/**
 * A presigned POST: the browser sends `fields` plus the file as multipart form
 * data to `url`. The fields carry the signed policy (key, content type, size
 * range, expiry), so S3 rejects anything that doesn't match.
 */
export const CreateUploadResponseSchema = z.object({
  url: z.url(),
  fields: z.record(z.string(), z.string()),
  key: z.string().startsWith(UPLOADS_PREFIX),
  runId: z.uuid(),
  expiresAt: z.iso.datetime(),
});
export type CreateUploadResponse = z.infer<typeof CreateUploadResponseSchema>;

/** `uploads/{sessionId}/{runId}.{ext}`. Built on the server so visitors can't choose keys. */
export function uploadKey(
  sessionId: string,
  runId: string,
  contentType: UploadContentType,
): string {
  return `${UPLOADS_PREFIX}${sessionId}/${runId}.${UPLOAD_CONTENT_TYPES[contentType]}`;
}

const UPLOAD_KEY_PATTERN = new RegExp(
  `^${UPLOADS_PREFIX}([0-9a-f-]{36})/([0-9a-f-]{36})\\.(${Object.values(UPLOAD_CONTENT_TYPES).join('|')})$`,
);

/** The reverse of `uploadKey`. Returns null for any key the presign Lambda wouldn't have built. */
export function parseUploadKey(key: string): { sessionId: string; runId: string } | null {
  const match = UPLOAD_KEY_PATTERN.exec(key);
  if (!match) return null;
  const ids = z.object({ sessionId: z.uuid(), runId: z.uuid() }).safeParse({
    sessionId: match[1],
    runId: match[2],
  });
  return ids.success ? ids.data : null;
}
