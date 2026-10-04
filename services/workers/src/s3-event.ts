import { z } from 'zod';

/** S3 sends this once, when a notification configuration is saved. It has no Records. */
const S3TestEventSchema = z.object({ Event: z.literal('s3:TestEvent') });

/** The parts of an S3 event notification the worker uses. */
const S3EventSchema = z.object({
  Records: z.array(
    z.object({
      eventName: z.string(),
      eventTime: z.iso.datetime(),
      s3: z.object({
        bucket: z.object({ name: z.string().min(1) }),
        object: z.object({ key: z.string().min(1), size: z.number().int().nonnegative() }),
      }),
    }),
  ),
});

export interface UploadedObject {
  bucket: string;
  /** Already URL-decoded. */
  key: string;
  size: number;
  eventName: string;
  eventTime: string;
}

/**
 * Parses the body of an SQS message that S3 sent. Returns no objects for the
 * test event, and throws for anything that isn't an S3 notification (the
 * message then fails, is retried, and ends up in the dead-letter queue).
 *
 * Only the fields above are kept. The full event also holds the uploader's IP
 * address, which this public demo never logs.
 */
export function parseS3Notification(body: string): UploadedObject[] {
  const json: unknown = JSON.parse(body);
  if (S3TestEventSchema.safeParse(json).success) return [];

  return S3EventSchema.parse(json).Records.map((record) => ({
    bucket: record.s3.bucket.name,
    key: decodeS3Key(record.s3.object.key),
    size: record.s3.object.size,
    eventName: record.eventName,
    eventTime: record.eventTime,
  }));
}

/** S3 event keys are URL-encoded with spaces as "+": `run+1.txt` is `run 1.txt`. */
export function decodeS3Key(raw: string): string {
  return decodeURIComponent(raw.replace(/\+/g, ' '));
}
