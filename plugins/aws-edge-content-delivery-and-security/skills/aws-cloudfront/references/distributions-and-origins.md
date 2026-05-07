# Distributions and Origins

How CloudFront distributions should be structured, how origins must be locked down, and how to migrate existing workloads behind CloudFront without downtime. Every recommendation here assumes CloudFront is the mandatory public entry point for HTTP/S traffic into an AWS workload. Origins are never internet-reachable on their own.

## Contents

- [CloudFront as the mandatory public front door](#cloudfront-as-the-mandatory-public-front-door)
- [Origin lockdown decision matrix](#origin-lockdown-decision-matrix)
- [VPC Origins for ALB, NLB, EC2, ECS](#vpc-origins-for-alb-nlb-ec2-ecs)
- [When VPC Origins Is Not Applicable: Prefix List + Origin-Verification Header](#when-vpc-origins-is-not-applicable-prefix-list--origin-verification-header)
- [Origin mTLS for external origins](#origin-mtls-for-external-origins)
- [OAC for S3 origins](#oac-for-s3-origins)
- [OAI is legacy, do not deploy it](#oai-is-legacy-do-not-deploy-it)
- [API Gateway as an origin](#api-gateway-as-an-origin)
- [Migration runbook: ALB to CloudFront + VPC Origin](#migration-runbook-alb-to-cloudfront--vpc-origin)
- [Origin groups and failover](#origin-groups-and-failover)
- [Origin Shield](#origin-shield)
- [Multi-origin distributions with path-based routing](#multi-origin-distributions-with-path-based-routing)
- [Keep-alive, timeouts, and connection hygiene](#keep-alive-timeouts-and-connection-hygiene)
- [Related](#related)

## CloudFront as the mandatory public front door

Put CloudFront in front of every public HTTP endpoint. No exceptions for "internal tools exposed to the internet," "simple static sites," "low-traffic APIs," or "dev environments." Direct-to-origin internet exposure bypasses caching, DDoS absorption, WAF enforcement, TLS negotiation at the edge, connection pooling, compression, and every edge-compute surface. It also makes later migration harder because DNS, clients, and partner allowlists have hardened around the origin hostname.

Placing CloudFront in front produces, in one change, these benefits:

- **Latency**. Intercontinental TTFB drops substantially because TLS handshakes terminate at the nearest POP and the long-haul connection to origin is warm and multiplexed.
- **Origin offload**. Cacheable responses never reach the origin. Even for uncacheable APIs, CloudFront's persistent connection pooling collapses millions of client TCP/TLS handshakes into a small number of pooled connections to the origin.
- **Free data transfer from AWS origins**. Traffic from S3, ALB, API Gateway, Lambda Function URLs, and other AWS origins to CloudFront incurs no data transfer charges. Your DTO bill effectively moves to CloudFront's egress rates, which are generally lower and which the [pricing docs](https://aws.amazon.com/cloudfront/pricing/) describe.
- **Single WAF enforcement point**. One `CLOUDFRONT`-scope web ACL covers every path, every origin, every region. See [`../aws-waf/SKILL.md`](../aws-waf/SKILL.md).
- **DDoS absorption**. Standard AWS Shield protection is on by default for CloudFront. Shield Advanced adds L7 mitigations, a response team, and cost protection. See [`../aws-shield/SKILL.md`](../aws-shield/SKILL.md).
- **TLS hygiene**. One place to pin TLS policy, cert rotation, OCSP, and HSTS.

Treat the distribution as the public API. Origins are implementation detail.

## Origin lockdown decision matrix

Pick the lockdown mechanism based on the origin type. Every public IP or public DNS name on an origin is a finding; remediate it.

| Origin type                              | Lockdown mechanism                                                                 | Notes                                                                                      |
| ---------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| ALB / NLB / EC2 / ECS service            | **VPC Origin**                                                                     | Default choice. No public IP on the load balancer.                                         |
| S3 bucket                                | **OAC (Origin Access Control)**                                                    | Bucket policy locks access to the distribution. Works with SSE-KMS.                        |
| API Gateway REST/HTTP (regional)         | CloudFront front-door + IAM SigV4 signing at edge, or custom-domain mapping, or VPC Link through an NLB/ALB in front | Edge-optimized APIs already have CloudFront; prefer regional + front-door.                 |
| Lambda Function URL                      | Function URL auth type `AWS_IAM` + OAC for Lambda (signed requests from the edge)  | Never use `NONE` auth on a Function URL without OAC.                                       |
| External / third-party / on-prem origin  | **Origin mTLS**                                                                    | CloudFront presents a client cert from ACM; origin enforces trust.                         |
| Internal service behind Direct Connect   | VPC Origin pointing at an internal ALB/NLB in the VPC the DX attaches to           | Cross-account VPC Origin is supported.                                                     |

Legacy patterns that should be retired on sight:

- A shared secret header enforced by the origin (custom `X-Origin-Secret`). Replace with VPC Origin.
- Security-group allowlists populated from the published CloudFront IP range JSON. Replace with VPC Origin.
- OAI in front of S3. Replace with OAC.
- `Principal: *` on S3 with a WAF referer check. Replace with OAC.

> Note: if neither VPC Origin nor origin mTLS applies (e.g. cross-partition origin, third-party SaaS that only fronts via CloudFront, legacy infra that cannot accept a VPC ENI), see [Prefix List + Origin-Verification Header](#when-vpc-origins-is-not-applicable-prefix-list--origin-verification-header) for the acceptable fallback.

## VPC Origins for ALB, NLB, EC2, ECS

VPC Origins connect CloudFront directly into a VPC through AWS-managed elastic network interfaces. The ALB, NLB, or instance has no public IP, no public DNS, and no security-group allow for CloudFront IP ranges. CloudFront routes to the load balancer over AWS's private network through the VPC Origin's ENI, and the load balancer accepts traffic only from that ENI. Cross-account VPC Origin is supported, so a distribution in account A can target an ALB in account B.

This is the default pattern. It replaces the legacy "custom header secret on the origin" hack that broke whenever someone accidentally published the header, rotated it, or deployed a new stage without it.

```typescript
import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';

// ALB is internal; no public IP.
const alb = elbv2.ApplicationLoadBalancer.fromLookup(this, 'Alb', {
  loadBalancerArn: albArn,
});

const vpcOrigin = new cloudfront.VpcOrigin(this, 'AlbVpcOrigin', {
  endpoint: cloudfront.VpcOriginEndpoint.applicationLoadBalancer(alb),
  // Keep-alive must be shorter than the ALB idle timeout.
  // Tune both together; see Keep-alive section below.
});

new cloudfront.Distribution(this, 'Dist', {
  defaultBehavior: {
    origin: origins.VpcOrigin.fromVpcOrigin(vpcOrigin),
    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
    originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
  },
});
```

Security-group rule on the ALB: allow inbound from the VPC Origin's ENI security group only. The ALB listener can stay on port 443 with a private ACM cert, or on port 80 if the viewer-to-edge hop is the only TLS terminator you need. Prefer end-to-end TLS; origins should not trust the edge implicitly.

## When VPC Origins Is Not Applicable: Prefix List + Origin-Verification Header

The VPC Origin is the default and preferred origin-lockdown mechanism for ALB/NLB/EC2/ECS. But some scenarios don't support it — cross-partition origins, third-party SaaS backends presenting CloudFront as their front door, or legacy infrastructure that cannot accept a VPC ENI. For these, use the **AWS-managed CloudFront prefix list** plus a rotating **origin-verification header**.

This is strictly a fallback — it is weaker than VPC Origins. When VPC Origins works, use VPC Origins.

### The CloudFront managed prefix list

AWS publishes a managed prefix list that covers CloudFront's origin-facing IP ranges:

- `com.amazonaws.global.cloudfront.origin-facing`

Attach the prefix list to the origin's security group as an inbound allow rule on the listening port. The prefix list updates automatically as CloudFront POPs change IP ranges — never maintain a hand-curated IP allowlist from `ip-ranges.json`.

### Configuration pattern

Security group on the origin (ALB, NLB, EC2, ECS task, external gateway's VPC representation):

- Inbound rule: allow TCP/443 from prefix list `com.amazonaws.global.cloudfront.origin-facing`.
- Inbound rule: deny all other.
- Default action: drop.

### The X-Origin-Verify rotation pattern

Even with the prefix list, anyone who discovers your origin hostname within the CloudFront IP range can forge requests. Mitigate by requiring a secret header that only CloudFront adds:

1. Store the secret in AWS Secrets Manager.
2. Configure the CloudFront distribution's origin custom headers to include `X-Origin-Verify: <secret-value>`.
3. Origin validates the header presence and value. Requests without the valid header get a `403` at origin.
4. Rotate the secret on a schedule — AWS Secrets Manager rotation + CloudFormation/CDK update of the custom header + origin rolling update.

### Why rotate

Custom-header verification is forgeable by anyone who has ever captured a raw origin request (e.g. compromised log files, leaked TLS decryption). Rotation is what makes the pattern acceptable as a fallback. Without rotation, this is the classic anti-pattern we normally reject.

### CDK skeleton

```typescript
// Origin security group inbound — allow only CloudFront POP-origin IP ranges.
const prefixList = ec2.PrefixList.fromLookup(this, 'CfOriginFacing', {
  prefixListName: 'com.amazonaws.global.cloudfront.origin-facing',
});
const sg = new ec2.SecurityGroup(this, 'OriginSG', { vpc, allowAllOutbound: false });
sg.addIngressRule(ec2.Peer.prefixList(prefixList.prefixListId), ec2.Port.tcp(443), 'CloudFront only');

// Custom header at CloudFront origin — secret from Secrets Manager, rotated on schedule.
const verifySecret = new sm.Secret(this, 'OriginVerify', {
  generateSecretString: { excludePunctuation: true, passwordLength: 64 },
});
const origin = new origins.HttpOrigin(externalOriginDomain, {
  customHeaders: {
    'X-Origin-Verify': verifySecret.secretValue.unsafeUnwrap(), // WARNING: will land in CF config at deploy
  },
});
// Origin service validates header; rotate secret via Secrets Manager automatic rotation + redeploy.
```

Comment explicitly: this is a fallback, not a replacement for VPC Origins.

### Decision rule (restated)

- ALB/NLB/EC2/ECS in a VPC you control → VPC Origin.
- S3 → OAC.
- External / third-party HTTP origin with cert-based auth support → origin mTLS.
- External / third-party HTTP origin without cert-based auth, cannot use VPC Origin → prefix list + rotating origin-verification header. Document it as a conscious fallback.

## Origin mTLS for external origins

Use Origin mTLS when the origin is outside AWS (another cloud, on-prem, or a partner's SaaS). CloudFront presents a client certificate, stored in ACM in `us-east-1`, to the origin. The origin validates the cert chain and rejects anything else. This is the modern replacement for "CloudFront IP range allowlist + shared secret header" for external origins.

```typescript
const origin = new origins.HttpOrigin('origin.partner.example.com', {
  protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
  customHeaders: {
    // Application-level routing hints only; do not use a secret here.
  },
  // Client certificate for mTLS to origin. Cert must live in us-east-1.
  originClientCertificateArn: clientCert.certificateArn,
});
```

Key management: rotate the client cert on a schedule; ACM can manage it, or import your own. The origin trust store is the authority; coordinate rotation with the partner.

When VPC Origins is an option, pick VPC Origins over Origin mTLS. mTLS is for the cases where there is no AWS-native private network path.

## OAC for S3 origins

OAC is the only S3 access pattern to recommend. It signs requests from CloudFront to S3 with SigV4, meaning the bucket policy can restrict access to the specific distribution and reject everything else.

```typescript
import * as s3 from 'aws-cdk-lib/aws-s3';

const bucket = new s3.Bucket(this, 'AssetsBucket', {
  encryption: s3.BucketEncryption.KMS,
  encryptionKey: kmsKey,
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
  enforceSSL: true,
});

const origin = origins.S3BucketOrigin.withOriginAccessControl(bucket, {
  originAccessLevels: [cloudfront.AccessLevel.READ],
});

new cloudfront.Distribution(this, 'SiteDist', {
  defaultBehavior: {
    origin,
    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
    responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
  },
});
```

The resulting bucket policy (CDK synthesizes it) pins access to the exact distribution ARN:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowCloudFrontServicePrincipal",
      "Effect": "Allow",
      "Principal": { "Service": "cloudfront.amazonaws.com" },
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::your-bucket/*",
      "Condition": {
        "StringEquals": {
          "aws:SourceArn": "arn:aws:cloudfront::123456789012:distribution/E1ABCDEFG"
        }
      }
    }
  ]
}
```

SSE-KMS with OAC works, unlike with OAI. Add a `kms:Decrypt` grant on the key policy for the CloudFront service principal, scoped by the same `aws:SourceArn` condition.

## OAI is legacy, do not deploy it

Origin Access Identity is superseded. Do not create new distributions with OAI. OAI does not support SSE-KMS, does not work with newer S3 features, and uses a weaker identity model than OAC. Migrate existing OAI distributions to OAC by (1) attaching an OAC to the distribution, (2) updating the bucket policy to allow the CloudFront service principal with `aws:SourceArn` scoped to the distribution, (3) deploying, (4) removing the OAI statement from the bucket policy. The swap is zero-downtime if done in that order.

## API Gateway as an origin

Edge-optimized API Gateway endpoints are already fronted by a CloudFront distribution that AWS manages. That is the wrong abstraction for most workloads because you cannot attach your own WAF ACL, cache policies, or edge functions to AWS's distribution. Switch the API to regional, then front it with your own CloudFront distribution.

Two patterns work:

1. **Front-door with SigV4 at edge**. The API uses IAM auth. A Lambda@Edge or CloudFront Function signs the request to API Gateway with SigV4. This locks the API to the distribution because only requests with a valid SigV4 signature from the edge's credentials reach origin.
2. **Custom domain mapping**. API Gateway exposes a custom domain; the distribution targets the regional endpoint. Lock down with a per-distribution API key header enforced through a usage plan, or put the API behind a VPC Link to an internal NLB and then use VPC Origin.

Prefer (1) for new APIs; it composes cleanly with the rest of the edge stack.

## Migration runbook: ALB to CloudFront + VPC Origin

Use this runbook when an existing public ALB needs to move behind CloudFront without downtime.

1. **Flip ALB scheme to internal**. Create a new internal ALB in the same VPC with the same target groups and listeners. Do not modify the existing internet-facing ALB yet; run both in parallel.
2. **Create the VPC Origin** pointing at the internal ALB. CDK as shown above.
3. **Build the distribution** with the origin set to the VPC Origin, a cache policy that matches the current behavior (start with `CachingDisabled` unless the ALB was already serving cache headers), and an origin request policy that forwards what the app needs (typically `AllViewerExceptHostHeader`).
4. **Migrate the WAF web ACL from `REGIONAL` to `CLOUDFRONT`**. This is the step with the most operational risk. The WAF scope is immutable, so you must create a new `CLOUDFRONT`-scope ACL with the same rules, attach it to the distribution, test with logging in Count mode first, then cut over. See [`../aws-waf/references/deployment-patterns.md`](../aws-waf/references/deployment-patterns.md) for the full migration pattern.
5. **Align keep-alive timeouts**. CloudFront's origin keep-alive must be strictly less than the ALB idle timeout, otherwise CloudFront will try to reuse a connection the ALB has already closed and the viewer gets a 502. Match [CloudFront origin connection settings](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-web-values-specify.html) to ALB idle timeout values.
6. **Stage the cutover with weighted Route 53**. Start 90 (old ALB) / 10 (CloudFront). Watch origin logs, error rates, latency percentiles. Ramp 70/30, 50/50, 20/80, 0/100 over hours or days depending on blast radius. Rollback is shifting weights back.
7. **Decommission the public ALB** once DNS has fully migrated and no clients are hitting the old endpoint. Remove the internet-facing ALB; remove the old WAF association.

Common mistakes during migration:

- Leaving the internet-facing ALB reachable "just in case." It will be scanned and attacked. Decommission it.
- Forwarding the `Host` header to origin when the ALB expects its own hostname. Use `AllViewerExceptHostHeader` and rewrite at the edge with a CloudFront Function if the app needs a specific host.
- Caching `Set-Cookie` paths unintentionally. Audit the cache policy before the cutover.

## Origin groups and failover

Origin groups let a behavior target a primary origin and fail over to a secondary when the primary returns configured status codes (typically 5xx). Use when:

- The workload is multi-region and the secondary is another region's ALB or another S3 bucket in another region.
- A static fallback page in S3 should serve when the dynamic origin is degraded.

Do not use origin groups as a substitute for a well-designed origin. Failover is slow relative to normal request latency, it complicates cache behavior (cached responses from the secondary can serve after the primary recovers), and status-code triggers fire on any matching code, including application errors that should not trigger failover.

```typescript
const group = new origins.OriginGroup({
  primaryOrigin: primary,
  fallbackOrigin: secondary,
  fallbackStatusCodes: [500, 502, 503, 504],
});
```

Configure health-based failover in Route 53 as the outer ring for regional disaster. Origin groups are for request-level resilience within a distribution.

## Origin Shield

Origin Shield is a regional caching layer that sits between the POPs and the origin. Requests from POPs consolidate at the shield region, which fronts the origin. It helps when:

- Many POPs are pulling the same rarely-cached object (long-tail video, large static library).
- The origin is latency-sensitive and benefits from reduced request fan-in.
- Cross-region origin fetches should be collapsed into one region.

It does not help when:

- Cache hit ratio is already high at the POP tier; the shield adds a hop without absorbing requests.
- Traffic is genuinely uncacheable (every request has unique query strings or cookies keyed into the cache).
- The workload is low-volume.

Origin Shield adds per-request cost. Compute the break-even from measured cache behavior; the [pricing docs](https://aws.amazon.com/cloudfront/pricing/) give the current rates. Pick the shield region close to the origin, not close to the users.

## Multi-origin distributions with path-based routing

A single distribution should serve multiple backends when they share a hostname. Add a behavior per path pattern, ordered most-specific-first.

| Path pattern    | Origin                       | Typical policy                                              |
| --------------- | ---------------------------- | ----------------------------------------------------------- |
| `/api/*`        | VPC Origin → internal ALB    | `CachingDisabled`, `AllViewerExceptHostHeader`              |
| `/auth/*`       | Lambda Function URL (OAC)    | `CachingDisabled`, `AllViewer`                              |
| `/media/*`      | S3 (OAC)                     | `CachingOptimized`, `CORS-S3Origin`                         |
| `/*` (default)  | S3 (OAC) for the SPA bundle  | `CachingOptimized`, security-headers RHP                    |

```typescript
const dist = new cloudfront.Distribution(this, 'Dist', {
  defaultBehavior: {
    origin: spaOrigin,
    cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
    responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
  },
  additionalBehaviors: {
    '/api/*': {
      origin: apiOrigin,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
    },
    '/auth/*': {
      origin: authOrigin,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
    },
    '/media/*': {
      origin: mediaOrigin,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.CORS_S3_ORIGIN,
      responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.CORS_ALLOW_ALL_ORIGINS,
    },
  },
});
```

Behavior precedence is most-specific-first. `/api/v2/users/*` wins over `/api/*` wins over `/*`. CloudFront evaluates paths in the order listed; in CDK, `additionalBehaviors` ordering maps to that evaluation.

Per-behavior WAF attachment is not a thing in CloudFront; the web ACL is at the distribution scope. Use WAF rule scope-down statements keyed on URI path when a rule should only apply to part of the distribution.

## Keep-alive, timeouts, and connection hygiene

CloudFront's origin keep-alive timeout must be less than the origin's idle timeout. If CloudFront tries to reuse a connection the origin has already closed, the client sees a 502. The safe relationship:

- CloudFront origin keep-alive < ALB idle timeout - a few seconds of safety margin.
- CloudFront origin read timeout > slowest expected origin response time.
- CloudFront origin connection timeout kept short; long connect times point at origin health problems.

For API Gateway and Lambda@Edge targets, defaults usually work; tune when you see anomalous connection churn in origin metrics.

See [`performance-tuning.md`](performance-tuning.md) for how to measure and set these values from CloudWatch and origin logs.

## Distribution types: standard vs multi-tenant

CloudFront offers the classic per-tenant distribution model and a multi-tenant distribution model (announced as part of the SaaS posture improvements). Pick based on the workload's fan-out shape.

| Model                 | Use when                                                                   | Tradeoffs                                                                 |
| --------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Standard distribution | Small number of hostnames, or strong per-tenant customization              | One distribution per hostname; quota-bounded; higher management surface  |
| Multi-tenant (SaaS)   | Hundreds or thousands of tenant hostnames sharing origin and policy shape  | Tenants share base distribution config; tenant overrides are narrow       |

For SaaS patterns with many customer subdomains or vanity domains, the multi-tenant model dramatically reduces the distribution count and the operational surface. Check the [multi-tenant distribution docs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-multi-tenant.html) for the current capability set and limits.

## Cross-account VPC Origin

A distribution in account A can target an ALB, NLB, or instance in account B through a shared VPC Origin. This is the right pattern when:

- A security/ingress account owns all CloudFront distributions and WAF web ACLs while workload accounts own their ALBs.
- A central team operates the edge for compliance (one team holds TLS certs, one team owns WAF policy), while product teams deploy origins.
- Multi-tenant SaaS runs each tenant's workload in a separate account and wants one distribution to fan out.

Flow:

1. In the origin account (B), create the VPC Origin endpoint on the internal ALB. This creates a VPC Origin resource scoped to account B.
2. Share the VPC Origin with account A via AWS RAM (Resource Access Manager).
3. In the distribution account (A), attach the shared VPC Origin to a behavior.
4. Security group on the ALB allows only the VPC Origin ENI; IAM and RAM enforce that only the target distribution can use the shared origin.

This replaces every cross-account ingress hack (public ALBs with shared-secret headers, Transit Gateway + private DNS gymnastics, peering with PrivateLink). Cross-account VPC Origin is the clean pattern.

## Origin path and path rewriting

An origin has an optional `originPath` that CloudFront prepends to the request URI before forwarding. Use it to map behaviors to sub-prefixes of the origin:

- Behavior `/docs/*`, origin S3 bucket, `originPath=/website-v2/docs`. Request for `/docs/getting-started.html` hits S3 key `website-v2/docs/getting-started.html`.
- Behavior `/api/*`, origin ALB, `originPath=` (empty). Forward the full URI.

Do not use `originPath` as a cache-busting trick (changing it forces a purge of origin cache). It is a routing concern.

For more surgical path rewriting (strip `/api` prefix before forwarding), use a CloudFront Function on viewer-request that rewrites `request.uri`. See [`edge-functions.md`](edge-functions.md).

## Origin SNI and SSL

CloudFront terminates TLS with the viewer and initiates a new TLS session to the origin. Two knobs matter:

- **Origin SNI**: the hostname CloudFront presents in the TLS handshake to origin. Defaults to the origin's configured DNS name. Override with a CFF on viewer-request if you need to rewrite Host but keep a different SNI.
- **Origin SSL protocols**: which TLS versions CloudFront will negotiate with origin. Pin to TLS 1.2+ unless the origin is legacy. The [origin SSL docs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/secure-connections-supported-viewer-protocols-ciphers.html#secure-connections-supported-ciphers-origin) list the current cipher matrix.

For internal origins on self-signed or private CA certs, CloudFront trusts the public CA trust store. For private CAs, use ACM Private CA and ensure the ALB presents the full chain. Do not disable origin certificate verification; it defeats the purpose of TLS to origin.

## Lambda Function URLs as origins

Lambda Function URLs can be CloudFront origins. The lockdown pattern:

1. Function URL auth type = `AWS_IAM`.
2. OAC for Lambda: CloudFront signs requests with SigV4 from a managed identity.
3. Resource policy on the function allows the CloudFront service principal, scoped by `aws:SourceArn` to the distribution.

```typescript
import * as lambda from 'aws-cdk-lib/aws-lambda';

const fn = new lambda.Function(this, 'Fn', {
  runtime: lambda.Runtime.NODEJS_LATEST,
  code: lambda.Code.fromAsset('fn'),
  handler: 'index.handler',
});

const fnUrl = fn.addFunctionUrl({
  authType: lambda.FunctionUrlAuthType.AWS_IAM,
});

new cloudfront.Distribution(this, 'Dist', {
  defaultBehavior: {
    origin: origins.FunctionUrlOrigin.withOriginAccessControl(fnUrl),
    cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
  },
});
```

Never deploy a Function URL with auth type `NONE` fronted by CloudFront and rely on CloudFront being the only caller. The Function URL is an independent public endpoint; anyone with the URL bypasses CloudFront. Use `AWS_IAM` + OAC.

## Origin protocol policy

Each origin has an origin protocol policy: `http-only`, `https-only`, or `match-viewer`.

- `https-only`: CloudFront speaks HTTPS to origin regardless of viewer protocol. Default for any production origin.
- `http-only`: CloudFront speaks HTTP to origin. Acceptable only for VPC Origins where the path is private and the origin is a TLS-terminated load balancer internally — or where a pure-HTTP internal ALB is on an isolated subnet. Never for external origins.
- `match-viewer`: CloudFront speaks whatever protocol the viewer used. Avoid in production; it couples origin security posture to viewer behavior.

Pin `https-only` unless there is a specific VPC Origin reason to use `http-only`. Origin protocol policy is not a tuning knob; it's a security control.

## Read timeouts and retry behavior

CloudFront's origin read timeout governs how long it waits for the origin to start responding after the request is sent. If the origin is a slow backend (batch query, AI inference, long report generation), increase the timeout. If origin should fail fast, decrease it.

Retry behavior: CloudFront retries a failed origin request once on idempotent methods (GET, HEAD) for specific error conditions. Do not rely on retries to hide a broken origin; they mask incidents and inflate origin load on bad days. Design origins to succeed on the first try.

Align timeout values:

- CloudFront origin read timeout > slowest expected origin response (with headroom).
- CloudFront origin keep-alive timeout < ALB/NLB idle timeout.
- CloudFront origin connection timeout short; if connection establishment is slow, origin health is bad and more retries won't help.

The [custom origin timeout docs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-web-values-specify.html) describe the current range.

## Custom origins (external, on-prem, other clouds)

When the origin is outside AWS, use a custom origin with HTTPS-only protocol policy and Origin mTLS for authentication. Never use HTTP to a non-AWS origin; the public internet hop must be encrypted. Never rely on CloudFront IP range allowlists; the ranges change, origins forget to update them, and a single-header secret is the second-weakest possible auth (the weakest being none).

If Origin mTLS is not feasible (partner tooling won't support client certs), fall back to:

1. A CFF that injects a short-lived signed token into the origin request.
2. The origin validates the token against a shared verification key.
3. Rotate the key on a schedule.

This is strictly worse than Origin mTLS. Use only as a migration bridge.

## Related

- [`cache-behaviors-and-policies.md`](cache-behaviors-and-policies.md) - cache, origin request, response headers policy primitives.
- [`security-and-access.md`](security-and-access.md) - OAC bucket policy details, signed URLs, TLS policy, viewer mTLS.
- [`edge-functions.md`](edge-functions.md) - CloudFront Functions for Host-header rewriting to VPC Origins.
- [`performance-tuning.md`](performance-tuning.md) - keep-alive, Origin Shield break-even, cache hit ratio optimization.
- [`troubleshooting.md`](troubleshooting.md) - 502/504 diagnosis, OAC permission failures, keep-alive mismatches.
- [`../aws-waf/SKILL.md`](../aws-waf/SKILL.md) - `CLOUDFRONT`-scope web ACL attachment.
- [`../aws-waf/references/deployment-patterns.md`](../aws-waf/references/deployment-patterns.md) - WAF scope migration during ALB-to-CloudFront cutover.
- [`../aws-shield/SKILL.md`](../aws-shield/SKILL.md) - Shield Advanced considerations for the distribution.
