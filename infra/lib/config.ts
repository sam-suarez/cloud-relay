/**
 * The only Region this project deploys to. The account's project was assigned
 * us-east-2 by AWS, and the account guardrails (SCPs) deny most regional
 * services anywhere else. Rekognition is also why we avoid ca-central-1.
 */
export const REGION = 'us-east-2';

/** Applied to every resource so cost reports and the console can filter by project. */
export const PROJECT_TAG = { key: 'project', value: 'cloud-relay' } as const;
