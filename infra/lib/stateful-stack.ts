import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { UPLOADS_PREFIX } from '@cloud-relay/shared';
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
  /** Private bucket that browsers upload originals to with a presigned POST. */
  readonly uploadsBucket: s3.Bucket;

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

    // Same defaults you checked on the create form: general purpose, global
    // namespace (generated name), ACLs disabled, all public access blocked,
    // versioning off (the default when `versioned` is omitted), SSE-S3.
    this.uploadsBucket = new s3.Bucket(this, 'UploadsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      encryption: s3.BucketEncryption.S3_MANAGED,
      // Adds a bucket policy that denies plain-HTTP requests. Nothing in the
      // stateless stack edits this bucket's policy, so it can live here.
      enforceSSL: true,
      // Permissions → CORS. Lets the page's JavaScript read S3's response to the
      // form POST. Any origin is fine: the signed policy is the real control.
      cors: [{ allowedMethods: [s3.HttpMethods.POST], allowedOrigins: ['*'], maxAge: 3000 }],
      // Management → lifecycle rule. Originals are temporary: S3 deletes them a
      // day after upload (at the next midnight UTC), and cleans up any multipart
      // upload left unfinished.
      lifecycleRules: [
        {
          id: 'expire-uploads',
          prefix: UPLOADS_PREFIX,
          expiration: Duration.days(1),
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
      ],
      removalPolicy: RemovalPolicy.RETAIN,
    });
  }
}
