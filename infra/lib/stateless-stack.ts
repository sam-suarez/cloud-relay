import { Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { StatefulStack } from './stateful-stack.ts';
import { StaticSite } from './static-site.ts';

export interface StatelessStackProps extends StackProps {
  /** Buckets, tables, etc. that this stack's compute reads and writes. */
  stateful: StatefulStack;
  /** Folder with the built SPA to upload. */
  webBuildDir: string;
}

/**
 * Compute and routing: Lambdas, API Gateway, CloudFront, ECS task definitions.
 * Nothing in here stores data, so it is always safe to replace or tear down.
 */
export class StatelessStack extends Stack {
  constructor(scope: Construct, id: string, props: StatelessStackProps) {
    super(scope, id, props);

    // Deploy order: stateful first. CDK also infers this from cross-stack
    // references once we start passing buckets and tables in.
    this.addStackDependency(props.stateful);

    new StaticSite(this, 'Site', {
      bucket: props.stateful.siteBucket,
      buildDir: props.webBuildDir,
    });
  }
}
