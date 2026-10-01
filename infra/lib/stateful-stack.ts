import { Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

/**
 * Resources that hold data: S3 buckets, DynamoDB tables, the Aurora cluster,
 * the Cognito user pool.
 *
 * Kept separate so the stateless stack can be destroyed and redeployed freely
 * without any risk of replacing (and emptying) a bucket or table. Changes here
 * are rarer and deserve a careful `cdk diff` first.
 */
export class StatefulStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
  }
}
