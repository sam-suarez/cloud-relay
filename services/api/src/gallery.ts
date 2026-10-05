import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  GALLERY_LIMIT,
  GalleryParamsSchema,
  ImageRecordSchema,
  toGalleryItem,
  type GalleryItem,
  type GalleryResponse,
} from '@cloud-relay/shared';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { json, requiredEnv } from './http.ts';

// Created once per execution environment and reused by warm invocations. The
// document client converts DynamoDB's typed JSON ({ "S": "..." }) to plain values.
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * `GET /api/sessions/{sessionId}/images`: the session's newest images.
 *
 * One Query on the partition key, so it only ever reads this session's items.
 * Knowing the session ID is the permission: it is a random UUID that only the
 * visitor's browser has.
 */
export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const params = GalleryParamsSchema.safeParse(event.pathParameters ?? {});
  if (!params.success) return json(400, { message: 'Invalid session ID' });

  const response = await dynamo.send(
    new QueryCommand({
      TableName: requiredEnv('IMAGES_TABLE'),
      KeyConditionExpression: 'sessionId = :sessionId',
      // TTL deletes lag by up to a few days, so skip what has already expired.
      FilterExpression: 'expiresAt > :now',
      ExpressionAttributeValues: {
        ':sessionId': params.data.sessionId,
        ':now': Math.floor(Date.now() / 1000),
      },
      // Sort key descending. Run IDs are UUIDv7s, so that's newest first.
      ScanIndexForward: false,
      // Counts items read BEFORE the filter. Newest first, the expired items
      // come last, so they can only shorten the page, never hide a newer image.
      Limit: GALLERY_LIMIT,
    }),
  );

  // No session ID in the logs: it is the visitor's only secret.
  const items: GalleryItem[] = [];
  for (const item of response.Items ?? []) {
    const record = ImageRecordSchema.safeParse(item);
    if (record.success) {
      items.push(toGalleryItem(record.data));
    } else {
      const fields = record.error.issues.map((issue) => issue.path.join('.'));
      console.warn(
        JSON.stringify({ message: 'Skipping invalid image record', runId: item.runId, fields }),
      );
    }
  }
  console.log(JSON.stringify({ returned: items.length, scanned: response.ScannedCount }));

  const body: GalleryResponse = { items };
  return json(200, body);
}
