import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import {
  CONNECTION_TTL_SECONDS,
  ConnectQuerySchema,
  type ConnectionRecord,
} from '@cloud-relay/shared';
import type { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * The WebSocket API's `$connect` route: runs once when a browser opens
 * `wss://<site>/ws?sessionId=<uuid>`, before the connection is established.
 *
 * Returning 200 accepts the connection; anything else makes API Gateway refuse
 * the handshake, and the browser never gets a socket. There is no `$disconnect`
 * route: rows expire by TTL, and the emitter deletes the ones API Gateway
 * reports as gone.
 */
export async function handler(
  event: APIGatewayProxyWebsocketEventV2,
): Promise<{ statusCode: number }> {
  const query = ConnectQuerySchema.safeParse(event.queryStringParameters ?? {});
  if (!query.success) return { statusCode: 400 };

  const { connectionId, connectedAt } = event.requestContext;
  const record: ConnectionRecord = {
    sessionId: query.data.sessionId,
    connectionId,
    connectedAt: new Date(connectedAt).toISOString(),
    expiresAt: Math.floor(connectedAt / 1000) + CONNECTION_TTL_SECONDS,
  };
  await dynamo.send(new PutCommand({ TableName: requiredEnv('CONNECTIONS_TABLE'), Item: record }));

  console.log(JSON.stringify({ message: 'Connected', ...record }));
  return { statusCode: 200 };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}
