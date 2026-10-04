import {
  ApiGatewayManagementApiClient,
  GoneException,
  type PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { DeleteCommand, DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { StepEvent } from '@cloud-relay/shared';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { emit } from './emit.ts';

type Send = MockInstance<(command: unknown) => Promise<unknown>>;

const sessionId = '0b1c2d3e-4f50-4a6b-8c7d-8e9fa0b1c2d3';
const runId = '0199a8f2-6b3a-7c1d-9e2f-3a4b5c6d7e8f';

const event = (step: StepEvent['step'], status: StepEvent['status']): StepEvent => ({
  runId,
  sessionId,
  step,
  service: 'lambda',
  status,
  startedAt: '2026-10-04T15:38:36.242Z',
  durationMs: status === 'started' ? null : 12,
  detail: {},
  logRef: null,
});

let dynamoSend: Send;
let postSend: Send;
let connections: string[];

beforeEach(() => {
  connections = ['conn-a=', 'conn-b='];
  dynamoSend = vi.spyOn(DynamoDBDocumentClient.prototype, 'send') as never;
  dynamoSend.mockImplementation(async (command) =>
    command instanceof QueryCommand
      ? { Items: connections.map((connectionId) => ({ connectionId })) }
      : {},
  );
  postSend = vi.spyOn(ApiGatewayManagementApiClient.prototype, 'send') as never;
  postSend.mockResolvedValue({});
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** [connectionId, step:status] for every post, in the order they were sent. */
const posts = () =>
  postSend.mock.calls.map(([command]) => {
    const { ConnectionId, Data } = (command as PostToConnectionCommand).input;
    const sent = JSON.parse(new TextDecoder().decode(Data as Uint8Array)) as StepEvent;
    return [ConnectionId, `${sent.step}:${sent.status}`];
  });

describe('emit', () => {
  it("looks up the session's open connections with one Query", async () => {
    await emit(event('resize', 'started'));

    const queries = dynamoSend.mock.calls.map(([c]) => c).filter((c) => c instanceof QueryCommand);
    expect(queries).toHaveLength(1);
    expect((queries[0] as QueryCommand).input).toMatchObject({
      TableName: 'test-connections-table',
      KeyConditionExpression: 'sessionId = :sessionId',
      FilterExpression: 'expiresAt > :now',
      ExpressionAttributeValues: { ':sessionId': sessionId },
    });
  });

  it('posts every event to every connection, in order, and counts the connections', async () => {
    const delivered = await emit(event('edge', 'succeeded'), event('api', 'succeeded'));

    expect(delivered).toBe(2);
    expect(posts()).toEqual(
      expect.arrayContaining([
        ['conn-a=', 'edge:succeeded'],
        ['conn-b=', 'edge:succeeded'],
      ]),
    );
    const toA = posts().filter(([id]) => id === 'conn-a=');
    expect(toA.map(([, what]) => what)).toEqual(['edge:succeeded', 'api:succeeded']);
  });

  it('deletes the row of a connection that is gone (410), and still reaches the others', async () => {
    postSend.mockImplementation(async (command) => {
      if ((command as PostToConnectionCommand).input.ConnectionId === 'conn-a=') {
        throw new GoneException({ message: 'Gone', $metadata: { httpStatusCode: 410 } });
      }
      return {};
    });

    await expect(emit(event('resize', 'started'))).resolves.toBe(1);

    const deletes = dynamoSend.mock.calls.map(([c]) => c).filter((c) => c instanceof DeleteCommand);
    expect(deletes.map((d) => (d as DeleteCommand).input)).toEqual([
      { TableName: 'test-connections-table', Key: { sessionId, connectionId: 'conn-a=' } },
    ]);
  });

  it('never throws when DynamoDB or API Gateway fail', async () => {
    postSend.mockRejectedValue(new Error('LimitExceededException'));
    await expect(emit(event('resize', 'started'))).resolves.toBe(0);

    dynamoSend.mockRejectedValue(new Error('AccessDeniedException'));
    await expect(emit(event('resize', 'started'))).resolves.toBe(0);
  });

  it('posts nothing when nobody is watching', async () => {
    connections = [];

    await expect(emit(event('resize', 'started'))).resolves.toBe(0);
    expect(postSend).not.toHaveBeenCalled();
  });

  it('only logs when the function is not wired to a WebSocket API', async () => {
    vi.stubEnv('WEBSOCKET_CALLBACK_URL', '');

    await expect(emit(event('resize', 'started'))).resolves.toBe(0);
    expect(dynamoSend).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"stepEvent"'));
  });

  it('rejects an event that breaks the contract (a bug, not a delivery problem)', async () => {
    await expect(emit({ ...event('resize', 'started'), sessionId: 'abc' })).rejects.toThrow();
  });
});
