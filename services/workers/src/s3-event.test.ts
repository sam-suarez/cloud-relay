import { describe, expect, it } from 'vitest';
import { decodeS3Key, parseS3Notification } from './s3-event.ts';

/** Trimmed from a real notification (walkthrough 2), minus the IP and request IDs. */
const notification = {
  Records: [
    {
      eventVersion: '2.6',
      eventSource: 'aws:s3',
      awsRegion: 'us-east-2',
      eventTime: '2026-10-03T17:52:52.441Z',
      eventName: 'ObjectCreated:Post',
      s3: {
        configurationId: 'uploads-to-queue',
        bucket: { name: 'uploads-bucket', arn: 'arn:aws:s3:::uploads-bucket' },
        object: { key: 'uploads/session-1/run+1.jpg', size: 6, eTag: 'b1946ac9' },
      },
    },
  ],
};

describe('parseS3Notification', () => {
  it('returns the bucket, decoded key and size of each created object', () => {
    expect(parseS3Notification(JSON.stringify(notification))).toEqual([
      {
        bucket: 'uploads-bucket',
        key: 'uploads/session-1/run 1.jpg',
        size: 6,
        eventName: 'ObjectCreated:Post',
        eventTime: '2026-10-03T17:52:52.441Z',
      },
    ]);
  });

  it('returns nothing for the test event S3 sends when notifications are configured', () => {
    const testEvent = { Service: 'Amazon S3', Event: 's3:TestEvent', Bucket: 'uploads-bucket' };
    expect(parseS3Notification(JSON.stringify(testEvent))).toEqual([]);
  });

  it.each([
    ['invalid JSON', '{not json'],
    ['a message that is not from S3', JSON.stringify({ hello: 'world' })],
  ])('throws for %s', (_label, body) => {
    expect(() => parseS3Notification(body)).toThrow();
  });
});

describe('decodeS3Key', () => {
  it('turns "+" into spaces and decodes percent escapes', () => {
    expect(decodeS3Key('uploads/a+b%2Bc%C3%A9.jpg')).toBe('uploads/a b+cé.jpg');
  });
});
