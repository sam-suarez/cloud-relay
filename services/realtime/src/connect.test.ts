import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ConnectionRecordSchema } from '@cloud-relay/shared';
import type { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { handler } from './connect.ts';

const sessionId = '0b1c2d3e-4f50-4a6b-8c7d-8e9fa0b1c2d3';
const connectedAt = Date.UTC(2026, 9, 4, 15, 38, 36, 242);

let dynamoSend: MockInstance<(command: unknown) => Promise<unknown>>;

/** The parts of a $connect event the handler reads. */
function connectEvent(query?: Record<string, string>) {
  return {
    queryStringParameters: query,
    requestContext: { routeKey: '$connect', connectionId: 'gcfoe05NyEw4KEhy5A==', connectedAt },
  } as unknown as APIGatewayProxyWebsocketEventV2;
}

beforeEach(() => {
  dynamoSend = vi.spyOn(DynamoDBDocumentClient.prototype, 'send') as never;
  dynamoSend.mockResolvedValue({});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('$connect handler', () => {
  it('stores the connection under its session, expiring when API Gateway would close it', async () => {
    await expect(handler(connectEvent({ sessionId }))).resolves.toEqual({ statusCode: 200 });

    const put = dynamoSend.mock.calls[0]?.[0] as PutCommand;
    expect(put).toBeInstanceOf(PutCommand);
    expect(put.input.TableName).toBe('test-connections-table');
    expect(ConnectionRecordSchema.parse(put.input.Item)).toEqual({
      sessionId,
      connectionId: 'gcfoe05NyEw4KEhy5A==',
      connectedAt: '2026-10-04T15:38:36.242Z',
      expiresAt: Math.floor(connectedAt / 1000) + 2 * 60 * 60,
    });
  });

  it.each([
    ['no query string', undefined],
    ['no session ID', { other: 'x' }],
    ['a session ID that is not a UUID', { sessionId: 'abc' }],
  ])('refuses the connection (400) with %s, without writing', async (_label, query) => {
    await expect(handler(connectEvent(query))).resolves.toEqual({ statusCode: 400 });
    expect(dynamoSend).not.toHaveBeenCalled();
  });

  it('fails (API Gateway answers 500) if the write fails', async () => {
    dynamoSend.mockRejectedValue(new Error('ProvisionedThroughputExceededException'));

    await expect(handler(connectEvent({ sessionId }))).rejects.toThrow();
  });
});
