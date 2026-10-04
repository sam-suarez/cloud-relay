import { S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { emit } from '@cloud-relay/realtime';
import {
  CreateUploadRequestSchema,
  MAX_UPLOAD_BYTES,
  SIMULATE_FAILURE_METADATA,
  STEP_SERVICE,
  UPLOAD_URL_TTL_SECONDS,
  uploadKey,
  uuidv7,
  type CreateUploadResponse,
  type StepEvent,
} from '@cloud-relay/shared';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';

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
  const { contentType, sessionId, simulateFailure } = request.data;

  // Time-ordered, so the Images table's sort key lists a session's uploads in order.
  const runId = uuidv7();
  const key = uploadKey(sessionId, runId, contentType);
  // x-amz-meta-* form fields become S3 user metadata on the object. Every field
  // is part of the signed policy, so a visitor can't add or flip this flag.
  const failureField = `x-amz-meta-${SIMULATE_FAILURE_METADATA}`;

  const { url, fields } = await createPresignedPost(s3, {
    Bucket: requiredEnv('UPLOADS_BUCKET'),
    Key: key, // also becomes an exact-match condition in the policy
    Conditions: [
      // S3 rejects the upload (EntityTooLarge / EntityTooSmall) outside this range,
      // whatever size the browser claimed above.
      ['content-length-range', 1, MAX_UPLOAD_BYTES],
      ['eq', '$Content-Type', contentType],
      ['eq', `$${failureField}`, String(simulateFailure)],
    ],
    Fields: { 'Content-Type': contentType, [failureField]: String(simulateFailure) },
    Expires: UPLOAD_URL_TTL_SECONDS,
  });
  const expiresAt = new Date(started + UPLOAD_URL_TTL_SECONDS * 1000).toISOString();

  const run = { runId, sessionId };
  await emit(...edgeAndApiSteps(event, run, started), {
    ...run,
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
      simulateFailure,
    },
    logRef: { logGroup: context.logGroupName, requestId: context.awsRequestId },
  });

  const body: CreateUploadResponse = { url, fields, key, runId, expiresAt };
  return json(200, body);
}

/**
 * CloudFront and API Gateway run none of our code, so this Lambda reports their
 * steps from the evidence they attach to the request:
 * - `edge`: CloudFront adds an `X-Amz-Cf-Id` header to every request it forwards.
 *   It reports no timing, so the step has none (requests sent straight to the
 *   execute-api URL skip CloudFront and have no edge step at all).
 * - `api`: API Gateway stamps the time it received the request (`timeEpoch`).
 *   From then until this handler started is routing plus invoking the Lambda,
 *   including any cold start.
 */
function edgeAndApiSteps(
  event: APIGatewayProxyEventV2,
  run: { runId: string; sessionId: string },
  handlerStarted: number,
): StepEvent[] {
  const { timeEpoch, routeKey, requestId } = event.requestContext;
  const cloudFrontId = event.headers?.['x-amz-cf-id'];
  const receivedAt = new Date(timeEpoch).toISOString();
  const steps: StepEvent[] = [];

  if (cloudFrontId) {
    steps.push({
      ...run,
      step: 'edge',
      service: STEP_SERVICE.edge,
      status: 'succeeded',
      startedAt: receivedAt,
      durationMs: null,
      detail: { cloudFrontRequestId: cloudFrontId },
      logRef: null,
    });
  }
  steps.push({
    ...run,
    step: 'api',
    service: STEP_SERVICE.api,
    status: 'succeeded',
    startedAt: receivedAt,
    // Two different clocks (API Gateway's and the Lambda's), so never below 0.
    durationMs: Math.max(0, handlerStarted - timeEpoch),
    detail: { route: routeKey, apiRequestId: requestId },
    logRef: null,
  });
  return steps;
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
