import { App } from 'aws-cdk-lib';
import { buildApp } from '../lib/app.ts';
import { REGION } from '../lib/config.ts';

// CDK_DEFAULT_ACCOUNT/REGION come from your CLI credentials and profile. The
// stacks always target REGION, but a mismatch usually means the wrong profile
// is active. Only checked when credentials exist (no account = plain synth, e.g. CI).
const profileRegion = process.env.CDK_DEFAULT_REGION;
if (process.env.CDK_DEFAULT_ACCOUNT && profileRegion !== REGION) {
  throw new Error(
    `Your AWS profile region is ${profileRegion}, but this project only deploys to ${REGION}. ` +
      `Check AWS_PROFILE (expected: cloud-relay).`,
  );
}

const app = new App();

// Where alarms and budget alerts go: `-c alertEmail=…` or ALERT_EMAIL, never
// committed. Required for diff/deploy, so a deploy without it can't silently
// remove the email subscription and the budget.
const alertEmail: string | undefined =
  app.node.tryGetContext('alertEmail') ?? process.env.ALERT_EMAIL ?? undefined;
if (process.env.CDK_DEFAULT_ACCOUNT && !alertEmail) {
  throw new Error(
    'Set the alert email for alarms and the budget: ALERT_EMAIL=you@example.com npm run deploy ' +
      '(or -c alertEmail=…).',
  );
}

buildApp(app, { alertEmail });
