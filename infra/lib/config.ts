import { fileURLToPath } from 'node:url';
import { Duration } from 'aws-cdk-lib';

/**
 * The only Region this project deploys to. The account's project was assigned
 * us-east-2 by AWS, and the account guardrails (SCPs) deny most regional
 * services anywhere else. Rekognition is also why we avoid ca-central-1.
 */
export const REGION = 'us-east-2';

/** Applied to every resource so cost reports and the console can filter by project. */
export const PROJECT_TAG = { key: 'project', value: 'cloud-relay' } as const;

/**
 * The image worker's timeout. The uploads queue's visibility timeout is 6× this,
 * as AWS recommends for Lambda consumers: the headroom lets Lambda retry a
 * throttled invocation before the message reappears in the queue.
 */
export const WORKER_TIMEOUT = Duration.seconds(10);

/** The built SPA (`npm run build -w @cloud-relay/web`) that gets uploaded to the site bucket. */
export const WEB_BUILD_DIR = fileURLToPath(new URL('../../apps/web/build/client', import.meta.url));
