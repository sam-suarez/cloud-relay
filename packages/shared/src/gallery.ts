import { z } from 'zod';
import {
  ImageLabelSchema,
  ImageStatusSchema,
  RejectionSchema,
  type ImageFile,
  type ImageRecord,
} from './images.ts';
import { PROCESSED_PREFIX } from './processing.ts';

/**
 * The HTTP API route that lists a session's images. `{sessionId}` is a path
 * parameter: API Gateway passes it to the Lambda in `event.pathParameters`.
 */
export const GALLERY_ROUTE_PATH = '/api/sessions/{sessionId}/images';

/** The browser's URL for a session's gallery. Relative: same CloudFront domain as the page. */
export function galleryPath(sessionId: string): string {
  return GALLERY_ROUTE_PATH.replace('{sessionId}', encodeURIComponent(sessionId));
}

/** How many images the gallery shows: the newest ones. */
export const GALLERY_LIMIT = 24;

/**
 * The path parameters, checked by the Lambda. The session ID is the only
 * secret a visitor holds, so nothing but a well-formed UUID gets to DynamoDB.
 */
export const GalleryParamsSchema = z.object({ sessionId: z.uuid() });

/**
 * The browser URL of a processed image. CloudFront's `/processed/*` behavior
 * forwards the path to the processed bucket unchanged, so the URL is the S3 key.
 */
export function processedUrl(key: string): string {
  return `/${key}`;
}

/** A resized image as the browser loads it. Width and height reserve its space before it loads. */
export const GalleryImageSchema = z.object({
  url: z.string().startsWith(`/${PROCESSED_PREFIX}`),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type GalleryImage = z.infer<typeof GalleryImageSchema>;

/**
 * One image in the gallery: the public subset of an image record. Rejected
 * images have no files (the worker deleted them) but keep their rejection.
 */
export const GalleryItemSchema = z.object({
  runId: z.uuid(),
  status: ImageStatusSchema,
  createdAt: z.iso.datetime(),
  thumb: GalleryImageSchema.nullable(),
  display: GalleryImageSchema.nullable(),
  labels: z.array(ImageLabelSchema),
  rejection: RejectionSchema.nullable(),
});
export type GalleryItem = z.infer<typeof GalleryItemSchema>;

/** Body of `GET /api/sessions/{sessionId}/images`, newest first. */
export const GalleryResponseSchema = z.object({ items: z.array(GalleryItemSchema) });
export type GalleryResponse = z.infer<typeof GalleryResponseSchema>;

/** What the gallery shows for a stored record. */
export function toGalleryItem(record: ImageRecord): GalleryItem {
  return {
    runId: record.runId,
    status: record.status,
    createdAt: record.createdAt,
    thumb: record.thumb && toGalleryImage(record.thumb),
    display: record.display && toGalleryImage(record.display),
    labels: record.labels,
    rejection: record.rejection,
  };
}

// Built from the key stored in the record, not recomputed, so records written
// with an older key layout keep working.
function toGalleryImage({ key, width, height }: ImageFile): GalleryImage {
  return { url: processedUrl(key), width, height };
}
