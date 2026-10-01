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
buildApp(app);
