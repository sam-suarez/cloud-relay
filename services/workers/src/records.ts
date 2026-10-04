import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DAILY_ANALYSIS_LIMIT, type ImageRecord } from '@cloud-relay/shared';
import { requiredEnv } from './env.ts';

// The document client converts plain JS values to DynamoDB's typed JSON
// ({ "S": "..." }, { "N": "..." }) and back, so we never write that by hand.
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/** Writes (or, on a retry, overwrites) an image record. Returns the write units used. */
export async function putImageRecord(record: ImageRecord): Promise<number> {
  const response = await dynamo.send(
    new PutCommand({
      TableName: requiredEnv('IMAGES_TABLE'),
      Item: record,
      ReturnConsumedCapacity: 'TOTAL',
    }),
  );
  return response.ConsumedCapacity?.CapacityUnits ?? 0;
}

export type AnalysisReservation = { allowed: true; used: number } | { allowed: false };

/**
 * Counts one Rekognition analysis against today's DAILY_ANALYSIS_LIMIT.
 *
 * One conditional update does the check and the increment atomically, so two
 * workers can't both take the last slot. Retries count again: the counter
 * tracks Rekognition calls (what costs money), not distinct images.
 */
export async function reserveAnalysis(now = new Date()): Promise<AnalysisReservation> {
  const day = now.toISOString().slice(0, 10); // UTC, e.g. 2026-10-04
  try {
    const response = await dynamo.send(
      new UpdateCommand({
        TableName: requiredEnv('USAGE_TABLE'),
        Key: { day },
        // ADD creates the attribute at 0 if it doesn't exist yet.
        UpdateExpression: 'ADD #count :one SET expiresAt = :expiresAt',
        ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
        // "count" is a DynamoDB reserved word, so expressions refer to it as #count.
        ExpressionAttributeNames: { '#count': 'count' },
        ExpressionAttributeValues: {
          ':one': 1,
          ':limit': DAILY_ANALYSIS_LIMIT,
          // TTL removes old days' counters.
          ':expiresAt': Math.floor(now.getTime() / 1000) + 2 * 24 * 60 * 60,
        },
        ReturnValues: 'UPDATED_NEW',
      }),
    );
    return { allowed: true, used: Number(response.Attributes?.count ?? 0) };
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) return { allowed: false };
    throw error;
  }
}
