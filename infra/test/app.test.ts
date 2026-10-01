import { App } from 'aws-cdk-lib';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../lib/app.ts';

describe('CDK app', () => {
  it('creates the stateful and stateless stacks in us-east-2', () => {
    const { stateful, stateless } = buildApp(new App());

    expect(stateful.region).toBe('us-east-2');
    expect(stateless.region).toBe('us-east-2');
  });

  it('deploys the stateful stack before the stateless one', () => {
    const { stateful, stateless } = buildApp(new App());

    expect(stateless.dependencies).toContain(stateful);
  });

  it('tags every stack with the project name', () => {
    const app = new App();
    buildApp(app);
    const assembly = app.synth();

    for (const stack of assembly.stacks) {
      expect(stack.tags).toMatchObject({ project: 'cloud-relay' });
    }
  });
});
