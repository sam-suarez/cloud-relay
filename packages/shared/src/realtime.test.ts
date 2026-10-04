import { describe, expect, it } from 'vitest';
import { ConnectQuerySchema, websocketUrl } from './realtime.ts';

const sessionId = '0b1c2d3e-4f50-4a6b-8c7d-8e9fa0b1c2d3';

describe('websocketUrl', () => {
  it('uses wss on an HTTPS page and the same host, under /ws', () => {
    expect(websocketUrl({ protocol: 'https:', host: 'd123.cloudfront.net' }, sessionId)).toBe(
      `wss://d123.cloudfront.net/ws?sessionId=${sessionId}`,
    );
  });

  it('uses plain ws on an HTTP page (local development)', () => {
    expect(websocketUrl({ protocol: 'http:', host: 'localhost:5173' }, sessionId)).toMatch(
      /^ws:\/\/localhost:5173\/ws\?/,
    );
  });
});

describe('ConnectQuerySchema', () => {
  it('accepts a UUID session ID', () => {
    expect(ConnectQuerySchema.safeParse({ sessionId }).success).toBe(true);
  });

  it.each([{}, { sessionId: 'abc' }, { sessionId: '' }])('rejects %j', (query) => {
    expect(ConnectQuerySchema.safeParse(query).success).toBe(false);
  });
});
