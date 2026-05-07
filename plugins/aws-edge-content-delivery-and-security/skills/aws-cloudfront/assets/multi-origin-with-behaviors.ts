import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';

export interface MultiOriginProps extends cdk.StackProps {
  // Internal ALB. CloudFront reaches it via VPC Origin — no internet exposure.
  readonly alb: elbv2.IApplicationLoadBalancer;
  // Pre-existing static asset bucket. Caller owns its lifecycle.
  readonly staticBucket: s3.IBucket;
  // Optional — only needed if we build network resources here. Kept for future use.
  readonly vpc?: ec2.IVpc;
  // Optional second ALB used as an Origin Group failover target.
  readonly apiFailoverAlb?: elbv2.IApplicationLoadBalancer;
  // Optional WAF web ACL ARN (see skills/aws-waf). If present, attach via webAclId.
  readonly webAclArn?: string;
}

export class MultiOriginStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MultiOriginProps) {
    super(scope, id, props);

    // S3 origin with OAC — modern construct, auto-writes bucket policy with SourceArn scoped to this distribution.
    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(props.staticBucket);

    // VPC Origin — no public IP on the ALB, no CloudFront IP allowlist hack.
    // Previously teams used a shared-secret custom header + SG rules on CF prefix-list; VPC Origin removes that entirely.
    // VpcOrigin.withApplicationLoadBalancer is the current L2 path (aws-cdk-lib >= 2.160).
    const primaryApiOrigin = origins.VpcOrigin.withApplicationLoadBalancer(props.alb, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      // CF origin keep-alive must be < ALB idle timeout. Keep ALB idle >= 60s; tune these together.
      keepaliveTimeout: cdk.Duration.seconds(30),
      readTimeout: cdk.Duration.seconds(30),
    });

    // Failover: either a second ALB (cross-AZ/region) or S3 as a static maintenance page.
    const failoverOrigin = props.apiFailoverAlb
      ? origins.VpcOrigin.withApplicationLoadBalancer(props.apiFailoverAlb, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        })
      : s3Origin;

    // OriginGroup fails over only on specific origin status codes — NOT on 4xx from the app.
    const apiOriginGroup = new origins.OriginGroup({
      primaryOrigin: primaryApiOrigin,
      fallbackOrigin: failoverOrigin,
      fallbackStatusCodes: [500, 502, 503, 504],
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: s3Origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        // Response Headers Policy — security headers at the edge, not in the app.
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        compress: true,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: apiOriginGroup,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          // API responses are per-request; caching them is almost always wrong. Opt in per-route in the app instead.
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          // AllViewerExceptHostHeader forwards cookies/headers/query but preserves the origin Host —
          // required when the ALB's target routing depends on its own Host header.
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          // APIs need POST/PUT/DELETE. Default policy is GET/HEAD only.
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          // No response headers policy here — APIs set their own CORS / cache-control / security headers.
          compress: true,
        },
        '/assets/*': {
          origin: s3Origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          // Long-lived immutable assets (hashed filenames). Keep the managed CachingOptimized policy;
          // rely on cache-control: immutable from the origin object metadata to push real TTL.
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
          compress: true,
        },
      },
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL,
      // WAF is attached here — this is where the aws-waf skill's web ACL plugs in.
      // WAF for CloudFront distributions MUST be scope=CLOUDFRONT (us-east-1). See skills/aws-waf.
      webAclId: props.webAclArn,
    });

    new cdk.CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new cdk.CfnOutput(this, 'DistributionDomain', { value: distribution.distributionDomainName });
  }
}
