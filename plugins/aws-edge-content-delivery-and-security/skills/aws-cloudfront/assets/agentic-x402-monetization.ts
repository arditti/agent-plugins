import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';

export interface X402Props extends cdk.StackProps {
  // One of these two MUST be supplied. If `originBucket` is set, we use OAC; otherwise CustomOrigin on `domainName`.
  readonly originBucket?: s3.IBucket;
  readonly domainName?: string;
  // Wallet / payment address the client pays to (see x402 spec for format).
  readonly paymentAddress: string;
  // Price per paid request (see x402 spec for format — e.g. "0.001 USDC").
  readonly pricePerRequest: string;
}

export class AgenticX402Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: X402Props) {
    // NOTE: CloudFront-scope WAF MUST be created in us-east-1. Deploy this stack to us-east-1.
    super(scope, id, props);

    if (!props.originBucket && !props.domainName) {
      throw new Error('X402Props: provide either originBucket or domainName.');
    }

    // x402 pattern: HTTP 402 Payment Required as a first-class response to unauthenticated AI agents.
    // The 402 body carries pay-to address + price so the agent can sign a payment and retry.
    const paymentRequiredBody = JSON.stringify({
      pay_to: props.paymentAddress,
      price: props.pricePerRequest,
      // Scheme hint lets the client library pick the right signing flow without a separate discovery call.
      scheme: 'x402-v1',
    });

    // WAF rule generates the 402; CloudFront Function pre-filters clearly-invalid tokens before they reach the rule.
    const webAcl = new wafv2.CfnWebACL(this, 'X402WebAcl', {
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        sampledRequestsEnabled: true,
        metricName: 'X402WebAcl',
      },
      customResponseBodies: {
        paymentRequired: {
          contentType: 'APPLICATION_JSON',
          content: paymentRequiredBody,
        },
      },
      rules: [
        {
          name: 'RequirePaymentHeaderOnPaidPaths',
          priority: 10,
          action: {
            block: {
              customResponse: {
                responseCode: 402,
                customResponseBodyKey: 'paymentRequired',
                responseHeaders: [
                  // Advertise the accepted scheme so compliant clients auto-retry.
                  { name: 'x-accept-payment', value: 'x402-v1' },
                ],
              },
            },
          },
          statement: {
            andStatement: {
              statements: [
                {
                  byteMatchStatement: {
                    searchString: '/paid/',
                    fieldToMatch: { uriPath: {} },
                    positionalConstraint: 'STARTS_WITH',
                    textTransformations: [{ priority: 0, type: 'NONE' }],
                  },
                },
                {
                  // Request is missing X-402-Payment header entirely -> 402.
                  notStatement: {
                    statement: {
                      sizeConstraintStatement: {
                        fieldToMatch: { singleHeader: { name: 'x-402-payment' } },
                        comparisonOperator: 'GT',
                        size: 0,
                        textTransformations: [{ priority: 0, type: 'NONE' }],
                      },
                    },
                  },
                },
              ],
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            sampledRequestsEnabled: true,
            metricName: 'RequirePaymentHeaderOnPaidPaths',
          },
        },
      ],
    });

    // Cheap pre-filter — full signature verification happens in WAF / at origin; this is a fast pre-filter
    // for malformed tokens so we don't waste a rule evaluation on obvious garbage.
    const preFilterCode = `
function handler(event) {
  var req = event.request;
  if (req.uri.indexOf('/paid/') !== 0) return req;
  var hdr = req.headers['x-402-payment'];
  if (!hdr || !hdr.value) return req; // let WAF produce the 402
  var v = hdr.value;
  // Very cheap shape check: base64url-ish, dot-separated (header.payload.sig). Reject obvious junk.
  var parts = v.split('.');
  if (parts.length !== 3 || v.length < 32 || /[^A-Za-z0-9_\\-\\.]/.test(v)) {
    return {
      statusCode: 402,
      statusDescription: 'Payment Required',
      headers: { 'content-type': { value: 'application/json' }, 'x-accept-payment': { value: 'x402-v1' } },
      body: '{"error":"malformed_payment_token"}',
    };
  }
  return req;
}
`;
    const preFilter = new cloudfront.Function(this, 'X402PreFilter', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(preFilterCode),
      comment: 'x402 pre-filter: reject malformed payment tokens before WAF eval.',
    });

    const origin = props.originBucket
      ? origins.S3BucketOrigin.withOriginAccessControl(props.originBucket)
      : new origins.HttpOrigin(props.domainName as string, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
      },
      additionalBehaviors: {
        '/paid/*': {
          origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          // Per-agent response uniqueness — caching would leak paid content across agents.
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          compress: true,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          functionAssociations: [
            { function: preFilter, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
          ],
        },
        '/free/*': {
          origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          compress: true,
        },
      },
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      // Cross-ref: see skills/aws-waf/SKILL.md for the rate-limiting layer combined with x402.
      webAclId: webAcl.attrArn,
    });

    new cdk.CfnOutput(this, 'DistributionDomain', { value: distribution.distributionDomainName });
    new cdk.CfnOutput(this, 'WebAclArn', { value: webAcl.attrArn });
  }
}
