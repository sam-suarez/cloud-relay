import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The tests stub every S3 and SQS call, so fake credentials are enough.
    env: {
      AWS_REGION: 'us-east-2',
      AWS_ACCESS_KEY_ID: 'test-access-key',
      AWS_SECRET_ACCESS_KEY: 'test-secret',
      PROCESSED_BUCKET: 'test-processed-bucket',
      QUEUE_URL: 'https://sqs.us-east-2.amazonaws.com/123456789012/test-uploads-queue',
    },
  },
});
