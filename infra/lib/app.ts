import { type App, Tags } from 'aws-cdk-lib';
import { PROJECT_TAG, REGION } from './config.ts';
import { StatefulStack } from './stateful-stack.ts';
import { StatelessStack } from './stateless-stack.ts';

/** Adds both stacks to the app. Separate from bin/app.ts so tests can call it. */
export function buildApp(app: App) {
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
  });

  Tags.of(app).add(PROJECT_TAG.key, PROJECT_TAG.value);

  return { stateful, stateless };
}
