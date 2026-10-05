import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

/** A JSON response for the HTTP API (payload format 2.0). */
export function json(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    // no-store: every response is for one visitor at one moment (a single-use
    // presigned POST, a gallery that changes with each upload), so no cache may keep it.
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(body),
  };
}

/** Reads configuration the CDK stack sets on the function. */
export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}
