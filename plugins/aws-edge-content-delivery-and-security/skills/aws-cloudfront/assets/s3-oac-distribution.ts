import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import { ICertificate } from 'aws-cdk-lib/aws-certificatemanager';

export interface S3OacDistributionProps extends cdk.StackProps {
  // Optional custom domain. When unset, we use the default *.cloudfront.net domain.
  readonly domainName?: string;
  // ACM cert MUST live in us-east-1 for CloudFront. Caller is responsible.
  readonly certificate?: ICertificate;
}

export class S3OacDistributionStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: S3OacDistributionProps = {}) {
    super(scope, id, props);

    // Dedicated log bucket — never log into the content bucket (circular writes, IAM headaches).
    const logBucket = new s3.Bucket(this, 'CfLogBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // CloudFront standard logs require ACLs on the bucket owner. Using OBJECT_WRITER keeps ACLs
      // effective without forcing BUCKET_OWNER_ENFORCED (which breaks standard logging delivery).
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
      lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Origin bucket: private, versioned, TLS-only. Using SSE-S3 here.
    // If you switch to SSE-KMS: the CloudFront service principal needs kms:Decrypt on the key,
    // and the key policy must allow the distribution's service-role condition. OAC supports KMS.
    const bucket = new s3.Bucket(this, 'ContentBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Using OAC — OAI is legacy; do not use.
    // withOriginAccessControl auto-creates the OAC and auto-writes the bucket policy with the
    // SourceArn condition scoped to this distribution. No manual IAM wiring required.
    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(bucket);

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: s3Origin,
        // HTTP-to-HTTPS redirect at the edge — never serve plaintext for S3 static content.
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        // CachingOptimized: 1d default, gzip+brotli-aware, sensible for immutable assets.
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        // Response Headers Policy (not Lambda@Edge) for security headers.
        // SECURITY_HEADERS managed policy: HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, CSP baseline.
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        compress: true,
      },
      // TLS_V1_2_2021 minimum; move to TLS_V1_3_2024 when clients permit.
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      // HTTP/3 (QUIC) materially improves P99 on lossy mobile networks.
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      // PRICE_CLASS_ALL — pay for all edge PoPs. Scale down only if regulatory or cost forces it.
      priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL,
      enableLogging: true,
      logBucket,
      logFilePrefix: 'cf-access-logs/',
      logIncludesCookies: false,
      // Attach custom domain only if both props are present — avoids half-configured state.
      ...(props.domainName && props.certificate
        ? { domainNames: [props.domainName], certificate: props.certificate }
        : {}),
      defaultRootObject: 'index.html',
    });

    new cdk.CfnOutput(this, 'BucketName', { value: bucket.bucketName });
    new cdk.CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new cdk.CfnOutput(this, 'DistributionDomain', { value: distribution.distributionDomainName });
  }
}
