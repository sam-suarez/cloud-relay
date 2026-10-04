import { z } from 'zod';

/**
 * The WebSocket API's stage name. Its URL is `wss://{api-id}.execute-api.../ws`,
 * so CloudFront can forward the site's own `/ws` path to it unchanged.
 */
export const WEBSOCKET_STAGE = 'ws';

/** The path the browser connects to: `wss://<site>/ws?sessionId=<uuid>`. */
export const WEBSOCKET_PATH = `/${WEBSOCKET_STAGE}`;

/**
 * API Gateway closes every WebSocket after at most 2 hours, so a connection
 * row is useless after that. TTL deletes it; readers skip it even sooner.
 */
export const CONNECTION_TTL_SECONDS = 2 * 60 * 60;

/** The query string of the WebSocket URL, checked by the $connect Lambda. */
export const ConnectQuerySchema = z.object({ sessionId: z.uuid() });

/**
 * One item in the Connections table: partition key `sessionId`, sort key
 * `connectionId`. A session has one row per open tab.
 */
export const ConnectionRecordSchema = z.object({
  sessionId: z.uuid(),
  /** API Gateway's ID for the socket, e.g. "gcfoe05NyEw4KEhy5A==". */
  connectionId: z.string().min(1),
  connectedAt: z.iso.datetime(),
  /** The TTL attribute: Unix time in seconds. */
  expiresAt: z.number().int().positive(),
});
export type ConnectionRecord = z.infer<typeof ConnectionRecordSchema>;

/** The browser's WebSocket URL for this page, e.g. `wss://d123.cloudfront.net/ws?sessionId=…`. */
export function websocketUrl(page: { protocol: string; host: string }, sessionId: string): string {
  const scheme = page.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${page.host}${WEBSOCKET_PATH}?sessionId=${encodeURIComponent(sessionId)}`;
}
