import { GalleryResponseSchema, galleryPath, type GalleryItem } from '@cloud-relay/shared';

/** A gallery failure with a message that is safe to show the visitor. */
export class GalleryError extends Error {}

/**
 * `GET /api/sessions/{sessionId}/images` (CloudFront → API Gateway → gallery
 * Lambda → DynamoDB Query): the session's newest images, newest first.
 */
export async function fetchGallery(
  sessionId: string,
  fetchFn: typeof fetch = fetch,
): Promise<GalleryItem[]> {
  const response = await fetchFn(galleryPath(sessionId));
  if (response.status === 429) {
    throw new GalleryError('Too many requests right now (API Gateway throttling).');
  }
  if (!response.ok) throw new GalleryError(`The gallery API returned ${response.status}.`);
  // Same schema the Lambda built the response with. Anything else is an error.
  return GalleryResponseSchema.parse(await response.json()).items;
}
