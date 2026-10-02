import { RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
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
  /** Private bucket for the built web app. Only CloudFront can read it. */
  readonly siteBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // No bucketName: CDK generates a unique one, so no name (or account ID) lives in the repo.
    this.siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED, // "ACLs disabled"
      encryption: s3.BucketEncryption.S3_MANAGED, // SSE-S3
      // The bucket policy (OAC read access + HTTPS only) lives in the stateless
      // stack next to the distribution. See StaticSite for why.
      //
      // Kept on `cdk destroy`; empty and delete it by hand during teardown.
      removalPolicy: RemovalPolicy.RETAIN,
    });
  }
}
