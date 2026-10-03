import { randomUUID } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import {
  CreateUploadRequestSchema,
  MAX_UPLOAD_BYTES,
  STEP_SERVICE,
  UPLOAD_URL_TTL_SECONDS,
  uploadKey,
  type CreateUploadResponse,
} from '@cloud-relay/shared';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import { emit } from './emit.ts';

// Created once per execution environment, outside the handler, so warm
// invocations reuse it. Region and credentials come from the Lambda runtime
// (AWS_REGION and the function's execution role).
const s3 = new S3Client({});

/**
 * `POST /api/uploads`: returns a presigned POST for one image.
 *
 * Signing happens locally with the execution role's credentials: no call to S3.
 * The signature is only as powerful as the role, so S3 accepts the upload only
 * because the role may `s3:PutObject` under uploads/.
 */
export async function handler(
  event: APIGatewayProxyEventV2,
  context: Context,
): Promise<APIGatewayProxyStructuredResultV2> {
  const started = Date.now();

  const request = CreateUploadRequestSchema.safeParse(parseJson(event));
  if (!request.success) {
    return json(400, { message: 'Invalid upload request', issues: request.error.issues });
  }
  const { contentType, sessionId } = request.data;

  const runId = randomUUID();
  const key = uploadKey(sessionId, runId, contentType);

  const { url, fields } = await createPresignedPost(s3, {
    Bucket: requiredEnv('UPLOADS_BUCKET'),
    Key: key, // also becomes an exact-match condition in the policy
    Conditions: [
      // S3 rejects the upload (EntityTooLarge / EntityTooSmall) outside this range,
      // whatever size the browser claimed above.
      ['content-length-range', 1, MAX_UPLOAD_BYTES],
      ['eq', '$Content-Type', contentType],
    ],
    Fields: { 'Content-Type': contentType },
    Expires: UPLOAD_URL_TTL_SECONDS,
  });
  const expiresAt = new Date(started + UPLOAD_URL_TTL_SECONDS * 1000).toISOString();

  await emit({
    runId,
    sessionId,
    step: 'presign',
    service: STEP_SERVICE.presign,
    status: 'succeeded',
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    detail: {
      key,
      contentType,
      maxBytes: MAX_UPLOAD_BYTES,
      expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
    },
    logRef: { logGroup: context.logGroupName, requestId: context.awsRequestId },
  });

  const body: CreateUploadResponse = { url, fields, key, runId, expiresAt };
  return json(200, body);
}

/** HTTP API (payload v2) passes the body as a string, base64-encoded for some content types. */
function parseJson(event: APIGatewayProxyEventV2): unknown {
  if (!event.body) return undefined;
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function json(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    // no-store: a presigned POST is single-use and must never be cached.
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(body),
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}
