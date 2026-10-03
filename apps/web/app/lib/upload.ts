import {
  CreateUploadRequestSchema,
  CreateUploadResponseSchema,
  type CreateUploadResponse,
} from '@cloud-relay/shared';

/** An upload failure with a message that is safe to show the visitor. */
export class UploadError extends Error {}

/**
 * Uploads a photo in two requests:
 * 1. `POST /api/uploads` (CloudFront → API Gateway → presign Lambda) returns a presigned POST.
 * 2. The browser POSTs the file straight to S3 as a form. It never passes through a Lambda.
 */
export async function uploadPhoto(
  file: File,
  sessionId: string,
  fetchFn: typeof fetch = fetch,
): Promise<CreateUploadResponse> {
  // Same schema the Lambda uses, so the visitor gets the error before any request.
  const request = CreateUploadRequestSchema.safeParse({
    contentType: file.type,
    size: file.size,
    sessionId,
  });
  if (!request.success) throw new UploadError('Choose a JPEG, PNG or WebP image up to 5 MB.');

  // Relative URL: the SPA and the API share the CloudFront domain.
  const apiResponse = await fetchFn('/api/uploads', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request.data),
  });
  if (apiResponse.status === 429) {
    throw new UploadError(
      'Too many uploads right now (API Gateway throttling). Try again shortly.',
    );
  }
  if (!apiResponse.ok) throw new UploadError(`The upload API returned ${apiResponse.status}.`);
  const presigned = CreateUploadResponseSchema.parse(await apiResponse.json());

  // S3 reads the form in order and ignores fields after the file, so the
  // signed fields go first and the file last.
  const form = new FormData();
  for (const [name, value] of Object.entries(presigned.fields)) form.append(name, value);
  form.append('file', file);

  const s3Response = await fetchFn(presigned.url, { method: 'POST', body: form });
  // Success is 204 No Content. Errors are XML, e.g. <Code>EntityTooLarge</Code>.
  if (!s3Response.ok) {
    const code = /<Code>([^<]+)<\/Code>/.exec(await s3Response.text())?.[1] ?? s3Response.status;
    throw new UploadError(`S3 rejected the upload: ${code}.`);
  }

  return presigned;
}
