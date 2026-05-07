import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';

export interface CffExampleProps extends cdk.StackProps {
  // Optional content bucket; we create one if not supplied.
  readonly contentBucket?: s3.IBucket;
}

export class CloudFrontFunctionsExampleStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: CffExampleProps = {}) {
    super(scope, id, props);

    const bucket =
      props.contentBucket ??
      new s3.Bucket(this, 'ContentBucket', {
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        encryption: s3.BucketEncryption.S3_MANAGED,
        enforceSSL: true,
        versioned: true,
      });

    // KeyValueStore — read from CFF at runtime, no cold start, eventually-consistent global propagation.
    // Use this for feature flags, A/B buckets, redirect maps. Do NOT stuff secrets here (public-readable by design).
    const kvs = new cloudfront.KeyValueStore(this, 'EdgeKvs', {
      comment: 'A/B flags + tiny redirect map. Populate with aws cloudfront-keyvaluestore put-key.',
    });

    // CloudFront Functions, not Lambda@Edge — sub-ms, no cold start, no outbound calls needed.
    // CFF runtime is cloudfront-js-2.0; associate the KVS for kvsHandle usage.
    // Do NOT implement security headers here — use Response Headers Policy.
    // Do NOT port this to Lambda@Edge — CFF handles viewer-request rewrites natively.
    const viewerRequestCode = `
import cf from 'cloudfront';
const kvs = cf.kvs('${kvs.keyValueStoreId}');
const TRACKING = ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','gclid','fbclid'];
async function handler(event) {
  var req = event.request;
  // 1. Strip tracking params — improves cache hit rate (fewer unique cache keys).
  if (req.querystring) {
    for (var i = 0; i < TRACKING.length; i++) { delete req.querystring[TRACKING[i]]; }
  }
  // 2. Clean-URL rewrite for /docs/* — avoid relying on S3 static website hosting (we use OAC + REST API).
  var uri = req.uri;
  if (uri.indexOf('/docs/') === 0 && uri.slice(-1) !== '/' && uri.indexOf('.') === -1) {
    req.uri = uri + '/index.html';
  } else if (uri.slice(-1) === '/') {
    req.uri = uri + 'index.html';
  }
  // 3. A/B bucket from KVS — fails open if the key is missing.
  try {
    var bucket = await kvs.get('ab-bucket-default', { format: 'string' });
    req.headers['x-ab-bucket'] = { value: bucket };
  } catch (e) {
    req.headers['x-ab-bucket'] = { value: 'control' };
  }
  return req;
}
`;

    const viewerResponseCode = `
function handler(event) {
  var res = event.response;
  // Propagate the CF request id so origin-side logs can be correlated with edge logs.
  res.headers['x-request-id'] = { value: event.context.requestId };
  return res;
}
`;

    const rewriteFn = new cloudfront.Function(this, 'RewriteFn', {
      // JS_2_0 required to use the cloudfront module + KVS.
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      keyValueStore: kvs,
      code: cloudfront.FunctionCode.fromInline(viewerRequestCode),
      comment: 'Strip tracking params, clean-URL rewrite, A/B bucket from KVS',
    });

    const headerFn = new cloudfront.Function(this, 'ResponseHeaderFn', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(viewerResponseCode),
      comment: 'Inject x-request-id on viewer-response',
    });

    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(bucket);

    new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: s3Origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        compress: true,
        functionAssociations: [
          { function: rewriteFn, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
          { function: headerFn, eventType: cloudfront.FunctionEventType.VIEWER_RESPONSE },
        ],
      },
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
    });

    new cdk.CfnOutput(this, 'KvsArn', { value: kvs.keyValueStoreArn });
  }
}
