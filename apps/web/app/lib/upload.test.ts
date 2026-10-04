import type { CreateUploadResponse } from '@cloud-relay/shared';
import { describe, expect, it, vi } from 'vitest';
import { UploadError, uploadPhoto } from './upload.ts';

const sessionId = '0b1c2d3e-4f50-4a6b-8c7d-8e9fa0b1c2d3';
const runId = '6f1c2a5e-8a9b-4c1d-9e2f-3a4b5c6d7e8f';
const presigned: CreateUploadResponse = {
  url: 'https://uploads-bucket.s3.us-east-2.amazonaws.com/',
  fields: { key: `uploads/${sessionId}/${runId}.jpg`, 'Content-Type': 'image/jpeg', Policy: 'p' },
  key: `uploads/${sessionId}/${runId}.jpg`,
  runId,
  expiresAt: '2026-10-02T12:01:00.000Z',
};

const photo = () => new File([new Uint8Array(1024)], 'dog.jpg', { type: 'image/jpeg' });

/** Fake fetch: first call is the API, second is S3. */
function fakeFetch(api: Response, s3 = new Response(null, { status: 204 })) {
  return vi.fn<typeof fetch>().mockResolvedValueOnce(api).mockResolvedValueOnce(s3);
}

describe('uploadPhoto', () => {
  it('asks the API for a presigned POST, then posts the fields and file to S3', async () => {
    const fetchFn = fakeFetch(Response.json(presigned));

    await expect(uploadPhoto(photo(), sessionId, { fetchFn })).resolves.toEqual(presigned);

    const [apiUrl, apiInit] = fetchFn.mock.calls[0] ?? [];
    expect(apiUrl).toBe('/api/uploads');
    expect(apiInit?.method).toBe('POST');
    expect(JSON.parse(apiInit?.body as string)).toEqual({
      contentType: 'image/jpeg',
      size: 1024,
      sessionId,
      simulateFailure: false,
    });

    const [s3Url, s3Init] = fetchFn.mock.calls[1] ?? [];
    expect(s3Url).toBe(presigned.url);
    const form = s3Init?.body as FormData;
    expect([...form.keys()]).toEqual(['key', 'Content-Type', 'Policy', 'file']);
  });

  it('asks for a simulated worker failure when requested', async () => {
    const fetchFn = fakeFetch(Response.json(presigned));

    await uploadPhoto(photo(), sessionId, { simulateFailure: true, fetchFn });

    const [, apiInit] = fetchFn.mock.calls[0] ?? [];
    expect(JSON.parse(apiInit?.body as string)).toMatchObject({ simulateFailure: true });
  });

  it('rejects an unsupported file before calling the API', async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const gif = new File(['x'], 'cat.gif', { type: 'image/gif' });

    await expect(uploadPhoto(gif, sessionId, { fetchFn })).rejects.toThrow(/JPEG, PNG or WebP/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('explains API Gateway throttling (429)', async () => {
    const fetchFn = fakeFetch(new Response('{"message":"Too Many Requests"}', { status: 429 }));

    await expect(uploadPhoto(photo(), sessionId, { fetchFn })).rejects.toThrow(/throttling/);
  });

  it('surfaces the S3 error code', async () => {
    const s3Error = new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 });
    const fetchFn = fakeFetch(Response.json(presigned), s3Error);

    const error = await uploadPhoto(photo(), sessionId, { fetchFn }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UploadError);
    expect((error as Error).message).toBe('S3 rejected the upload: AccessDenied.');
  });
});
