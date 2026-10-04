import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The tests stub every AWS call, so fake credentials are enough.
    env: {
      AWS_REGION: 'us-east-2',
      AWS_ACCESS_KEY_ID: 'test-access-key',
      AWS_SECRET_ACCESS_KEY: 'test-secret',
      CONNECTIONS_TABLE: 'test-connections-table',
      WEBSOCKET_CALLBACK_URL: 'https://abc123.execute-api.us-east-2.amazonaws.com/ws',
    },
  },
});
