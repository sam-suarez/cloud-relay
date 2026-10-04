import {
  ApiGatewayManagementApiClient,
  GoneException,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { StepEventSchema, type ConnectionRecord, type StepEvent } from '@cloud-relay/shared';

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// The @connections endpoint is the stage's callback URL, which only exists once
// the stack is deployed, so the client is created on first use.
let management: ApiGatewayManagementApiClient | undefined;

/**
 * Sends step events to every browser watching their session, in order, over the
 * WebSocket API. All events in one call must belong to the same session.
 * Returns how many connections received them.
 *
 * Every event is also logged, so CloudWatch shows exactly what the browser got.
 *
 * Never throws for delivery problems: a closed tab or a slow API Gateway must
 * not fail (and retry) the upload pipeline that is reporting its progress.
 */
export async function emit(...events: StepEvent[]): Promise<number> {
  const valid = events.map((event) => StepEventSchema.parse(event));
  for (const stepEvent of valid) console.log(JSON.stringify({ stepEvent }));

  const sessionId = valid[0]?.sessionId;
  const table = process.env.CONNECTIONS_TABLE;
  const endpoint = process.env.WEBSOCKET_CALLBACK_URL;
  // Not wired to a WebSocket API (e.g. a local run): logging is all we can do.
  if (!sessionId || !table || !endpoint) return 0;

  try {
    const connectionIds = await openConnections(table, sessionId);
    management ??= new ApiGatewayManagementApiClient({ endpoint });
    const client = management;
    const delivered = await Promise.all(
      connectionIds.map((connectionId) => post(client, table, sessionId, connectionId, valid)),
    );
    return delivered.filter(Boolean).length;
  } catch (error) {
    console.warn(JSON.stringify({ message: 'Could not emit step events', error: String(error) }));
    return 0;
  }
}

/** The session's connections. One Query on the partition key: no scan, no index. */
async function openConnections(table: string, sessionId: string): Promise<string[]> {
  const response = await dynamo.send(
    new QueryCommand({
      TableName: table,
      KeyConditionExpression: 'sessionId = :sessionId',
      // TTL deletes lag, so skip rows that have already expired.
      FilterExpression: 'expiresAt > :now',
      ExpressionAttributeValues: {
        ':sessionId': sessionId,
        ':now': Math.floor(Date.now() / 1000),
      },
      ProjectionExpression: 'connectionId',
    }),
  );
  return (response.Items ?? []).map(
    (item) => (item as Pick<ConnectionRecord, 'connectionId'>).connectionId,
  );
}

/**
 * POST @connections/{connectionId} once per event. Returns false if the
 * connection is gone (its row is deleted) or the post failed.
 */
async function post(
  client: ApiGatewayManagementApiClient,
  table: string,
  sessionId: string,
  connectionId: string,
  events: StepEvent[],
): Promise<boolean> {
  try {
    for (const event of events) {
      await client.send(
        new PostToConnectionCommand({
          ConnectionId: connectionId,
          Data: new TextEncoder().encode(JSON.stringify(event)),
        }),
      );
    }
    return true;
  } catch (error) {
    if (error instanceof GoneException) {
      // 410: the tab closed. There is no $disconnect route, so clean up here.
      await dynamo
        .send(new DeleteCommand({ TableName: table, Key: { sessionId, connectionId } }))
        .catch(() => undefined); // TTL removes it anyway
    } else {
      console.warn(
        JSON.stringify({ message: 'PostToConnection failed', connectionId, error: String(error) }),
      );
    }
    return false;
  }
}
