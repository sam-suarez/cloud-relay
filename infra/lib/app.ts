import { type App, Tags } from 'aws-cdk-lib';
import { PROJECT_TAG, REGION, WEB_BUILD_DIR } from './config.ts';
import { StatefulStack } from './stateful-stack.ts';
import { StatelessStack } from './stateless-stack.ts';

export interface BuildAppOptions {
  /** Built SPA to upload. Tests pass a small fixture so they don't need a web build. */
  webBuildDir?: string;
  /** Where alarms and budget alerts go. Optional so tests and CI synth need none. */
  alertEmail?: string;
}

/** Adds both stacks to the app. Separate from bin/app.ts so tests can call it. */
export function buildApp(
  app: App,
  { webBuildDir = WEB_BUILD_DIR, alertEmail }: BuildAppOptions = {},
) {
  // The account comes from your current credentials (`aws login`), never from code.
  // Without credentials (e.g. CI synth) it stays undefined and the templates are
  // account-agnostic, which is fine for synth.
  const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: REGION };

  const stateful = new StatefulStack(app, 'CloudRelayStateful', {
    env,
    description: 'Cloud Relay: data (buckets, tables, database, user pool)',
  });

  const stateless = new StatelessStack(app, 'CloudRelayStateless', {
    env,
    description: 'Cloud Relay: compute and routing (Lambdas, APIs, CDN, ECS)',
    stateful,
    webBuildDir,
    alertEmail,
  });

  Tags.of(app).add(PROJECT_TAG.key, PROJECT_TAG.value);

  return { stateful, stateless };
}
