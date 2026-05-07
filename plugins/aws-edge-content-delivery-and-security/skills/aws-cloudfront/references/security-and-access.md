# Security and Access

How to lock down CloudFront distributions: origin access, viewer authentication, response security headers, TLS policy, IP-level controls, and integration with WAF. Every pattern here assumes CloudFront is the mandatory public front door and the origin is not directly reachable from the internet. Security decisions belong at the edge where they are cheapest and most consistent.

## Contents

- [OAC for S3](#oac-for-s3)
- [Signed URLs and signed cookies](#signed-urls-and-signed-cookies)
- [ECDSA vs RSA for signed URLs](#ecdsa-vs-rsa-for-signed-urls)
- [Viewer mTLS](#viewer-mtls)
- [Response Headers Policies](#response-headers-policies)
- [TLS policies (viewer side)](#tls-policies-viewer-side)
- [Anycast static IPs](#anycast-static-ips)
- [Geo restriction](#geo-restriction)
- [Field-level encryption](#field-level-encryption)
- [Integration with WAF](#integration-with-waf)
- [Related](#related)

## OAC for S3

Origin Access Control is the only S3 access pattern to recommend. It supersedes Origin Access Identity (OAI), supports SSE-KMS, and uses SigV4 signing so the bucket policy can pin access to a specific distribution.

**Bucket policy** — scoped to the distribution ARN with `aws:SourceArn`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowCloudFrontServicePrincipalReadOnly",
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

**SSE-KMS** requires an additional grant on the KMS key policy:

```json
{
  "Sid": "AllowCloudFrontToDecrypt",
  "Effect": "Allow",
  "Principal": { "Service": "cloudfront.amazonaws.com" },
  "Action": ["kms:Decrypt", "kms:GenerateDataKey"],
  "Resource": "*",
  "Condition": {
    "StringEquals": {
      "aws:SourceArn": "arn:aws:cloudfront::123456789012:distribution/E1ABCDEFG"
    }
  }
}
```

**CDK**:

```typescript
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as kms from 'aws-cdk-lib/aws-kms';

const key = new kms.Key(this, 'Key', { enableKeyRotation: true });
const bucket = new s3.Bucket(this, 'Assets', {
  encryption: s3.BucketEncryption.KMS,
  encryptionKey: key,
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
  enforceSSL: true,
});

new cloudfront.Distribution(this, 'Dist', {
  defaultBehavior: {
    origin: origins.S3BucketOrigin.withOriginAccessControl(bucket, {
      originAccessLevels: [cloudfront.AccessLevel.READ],
    }),
    responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
  },
});
```

The CDK `S3BucketOrigin.withOriginAccessControl` helper wires the OAC, updates the bucket policy, and grants KMS decrypt. Prefer it over `S3Origin` (which uses OAI).

### OAI is legacy

OAI does not support SSE-KMS, cannot reach new S3 features, and uses a weaker identity model. Do not deploy new OAI distributions. For migrations:

1. Attach an OAC to the existing distribution alongside the OAI.
2. Update the bucket policy to allow the CloudFront service principal with `aws:SourceArn` condition for the distribution.
3. Deploy; verify 200s from the distribution.
4. Remove the OAI statement from the bucket policy.

Zero downtime if done in that order.

## Signed URLs and signed cookies

Signed URLs and signed cookies gate access to private content. CloudFront validates the signature at the edge and rejects unsigned or expired requests before they reach origin.

**When to use which**:

| Scenario                                                         | Pick          |
| ---------------------------------------------------------------- | ------------- |
| One specific asset, one-time or short-lived download link        | Signed URL    |
| Many assets under a path prefix, same user session               | Signed cookie |
| Streaming video with many segments                               | Signed cookie |
| Integration where the URL is embedded in an image/audio tag      | Signed URL    |
| Third-party client that can't accept cookies                     | Signed URL    |

**Trusted key groups vs trusted signer accounts**: use key groups. Key groups are the modern mechanism and support rotation without downtime. Trusted signer accounts (the older pattern that used CloudFront account-level keys) are legacy; do not use for new deployments.

**Key rotation**:

1. Generate a new key pair; upload the public key to the key group.
2. Keep the old key in the group; both are trusted during overlap.
3. Issue new signatures with the new private key.
4. When all in-flight signed content expires, remove the old key from the group.
5. Discard the old private key.

Rotate on a schedule, not only after exposure.

**CDK**:

```typescript
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';

const publicKey = new cloudfront.PublicKey(this, 'Pk', {
  encodedKey: fs.readFileSync('public_key.pem', 'utf8'),
});

const keyGroup = new cloudfront.KeyGroup(this, 'Kg', {
  items: [publicKey],
});

new cloudfront.Distribution(this, 'Dist', {
  defaultBehavior: {
    origin,
    trustedKeyGroups: [keyGroup],
    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
  },
});
```

## ECDSA vs RSA for signed URLs

CloudFront supports ECDSA (launched 2025-09) for signed URLs and cookies. ECDSA signatures are smaller, faster to verify, and use modern elliptic-curve cryptography.

| Criterion                     | ECDSA           | RSA (legacy)    |
| ----------------------------- | --------------- | --------------- |
| Signature size                | Smaller         | Larger          |
| Verification speed            | Faster          | Slower          |
| Key size equivalence          | 256-bit ECDSA ≈ 3072-bit RSA | N/A |
| Tooling maturity              | Wide but check your SDK | Universal |
| Recommended for new deployments | Yes          | No              |

Use ECDSA by default for new deployments. Use RSA only when the signing tooling (SDK, partner's signer, legacy CLI) does not support ECDSA. Both are supported simultaneously in a key group, so migrations can roll out ECDSA alongside existing RSA keys and cut over.

Link: [signed URLs and cookies docs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/PrivateContent.html).

## Viewer mTLS

Viewer mTLS (launched 2025-11) authenticates the viewer to CloudFront with a client certificate. Use for:

- B2B APIs where partners present client certs instead of bearer tokens.
- Enterprise SSO flows that issue workforce certs to devices.
- High-assurance admin interfaces where CA-backed client certs replace passwords + MFA.
- Machine-to-machine APIs where CA hierarchy is the auth model.

Configuration:

1. Upload the trust store (root and intermediate CAs) to ACM in `us-east-1`.
2. Attach the trust store to the distribution or to a specific behavior.
3. Require client certificates at the chosen scope.
4. CloudFront terminates TLS, validates the client cert against the trust store, and can pass cert fields (subject, thumbprint) to origin via CloudFront headers.

CDK:

```typescript
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';

const trustStore = acm.CertificateAuthority.fromCertificateAuthorityArn(
  this,
  'TrustStore',
  trustStoreArn, // ACM ARN in us-east-1
);

new cloudfront.Distribution(this, 'Dist', {
  defaultBehavior: {
    origin,
    // viewerMtls is the conceptual property; check the current L2 surface
    // and fall back to CfnDistribution escape hatches if needed.
    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
  },
});
```

Check the [viewer mTLS docs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/viewer-mtls.html) for the current CDK L2 property names; CDK support may lag the API surface and require CfnDistribution escape hatches.

Viewer mTLS is tier-gated on some flat-rate plans. Check the [pricing docs](https://aws.amazon.com/cloudfront/pricing/) for the current availability matrix.

## Response Headers Policies

Response Headers Policies are the correct home for security response headers. Never use Lambda@Edge for:

- `Strict-Transport-Security` (HSTS)
- `Content-Security-Policy` (CSP)
- `X-Frame-Options`
- `Referrer-Policy`
- `Permissions-Policy`
- `X-Content-Type-Options`
- CORS headers

Response Headers Policies apply with zero per-request compute overhead, are versioned, and centralize security posture per distribution or per behavior.

**Custom policy with CSP, HSTS, XFO, Referrer-Policy**:

```typescript
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cdk from 'aws-cdk-lib';

const secHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecHeaders', {
  responseHeadersPolicyName: 'AppSecurityHeaders',
  securityHeadersBehavior: {
    strictTransportSecurity: {
      accessControlMaxAge: cdk.Duration.days(365),
      includeSubdomains: true,
      preload: true,
      override: true,
    },
    contentSecurityPolicy: {
      contentSecurityPolicy: [
        "default-src 'self'",
        "script-src 'self' https://cdn.example.com",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https://cdn.example.com",
        "connect-src 'self' https://api.example.com",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join('; '),
      override: true,
    },
    frameOptions: {
      frameOption: cloudfront.HeadersFrameOption.DENY,
      override: true,
    },
    referrerPolicy: {
      referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
      override: true,
    },
    contentTypeOptions: { override: true },
    xssProtection: { protection: false, override: true }, // disabled intentionally; CSP covers it
  },
  customHeadersBehavior: {
    customHeaders: [
      {
        header: 'Permissions-Policy',
        value: 'geolocation=(), microphone=(), camera=()',
        override: true,
      },
    ],
  },
});
```

Attach per behavior:

```typescript
new cloudfront.Distribution(this, 'Dist', {
  defaultBehavior: {
    origin,
    responseHeadersPolicy: secHeaders,
    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
  },
});
```

CORS via Response Headers Policies is preferred over origin-returned CORS headers when:

- Multiple origins sit behind the distribution and should present a consistent CORS policy.
- Origins are legacy and don't emit CORS headers.
- You want to strip origin-emitted `Access-Control-Allow-Origin: *` on authenticated endpoints and replace with an explicit allowlist.

## TLS policies (viewer side)

Start with `TLSv1.2_2021`. Move to a TLS-1.3-only policy once measured client traffic supports it. CloudFront publishes multiple TLS policies; the [security-policy docs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/secure-connections-supported-viewer-protocols-ciphers.html) lists the current set, cipher suites, and version support. Do not enumerate cipher suites here; they change.

Decision path:

1. **New distribution, no legacy clients**: pick the newest TLS-1.3-capable policy that your client base supports.
2. **Regulated environment requiring FIPS**: pick the FIPS 140-3-validated policy (check the docs for the current named policy).
3. **Forward-looking crypto posture**: evaluate post-quantum (PQC) cipher support in newer policies as it becomes available in CloudFront. PQC support is rolling out; check the docs for which policies include it.
4. **Legacy clients (IoT, old embedded browsers, point-of-sale)**: accept the cost of a broader policy only after measuring; most modern traffic tolerates TLS 1.2+.

CDK:

```typescript
new cloudfront.Distribution(this, 'Dist', {
  defaultBehavior: { origin },
  minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
  // Tighten to TLSv1_3 policies when client base is ready.
});
```

Every distribution has a minimum TLS version; audit on a schedule. A distribution created years ago may still be pinned to a deprecated policy.

## Anycast static IPs

CloudFront distributions historically resolve to a pool of IPs that change over time. Anycast static IPs provide a stable, small set of IPs that persist for the distribution. Use for:

- **Partner firewall allowlisting**. Partners that cannot accept CIDR blocks or DNS-based allowlists can allowlist the distribution's anycast IPs.
- **Apex domain support via A records**. DNS does not allow CNAMEs at the zone apex (`example.com`). Anycast static IPs let you set A records at apex instead of relying on provider-specific ALIAS records.
- **IPv6 support** with deterministic addresses.
- **Zero-rated data transfer arrangements** with ISPs/mobile carriers that require a stable IP set.
- **BYOIP** — bring your own IP range to CloudFront for compliance or brand reasons.

Cost: anycast static IPs are not free; the [pricing docs](https://aws.amazon.com/cloudfront/pricing/) describe the current model. Treat as a targeted feature for specific requirements, not a default.

CDK:

```typescript
new cloudfront.Distribution(this, 'Dist', {
  defaultBehavior: { origin },
  // Check current CDK property surface; may require CfnDistribution escape hatch
  // to specify the anycast IP set ID or BYOIP pool.
});
```

## Geo restriction

CloudFront supports distribution-level country allow/block lists. Free, no WAF WCU, applies before any behavior logic. Use for simple country blocks — e.g., "we don't serve these five countries."

```typescript
new cloudfront.Distribution(this, 'Dist', {
  defaultBehavior: { origin },
  geoRestriction: cloudfront.GeoRestriction.denylist('KP', 'SY', 'IR', 'CU'),
});
```

When to use distribution-level geo restriction vs WAF geo match:

| Requirement                                     | Use                           |
| ----------------------------------------------- | ----------------------------- |
| Simple country allow/block, no exceptions       | Distribution-level geo restriction |
| Need to log and count blocks without blocking   | WAF geo match with Count action |
| Need to label for downstream rule logic         | WAF geo match with Label       |
| Need to challenge/CAPTCHA by country            | WAF geo match with Challenge/CAPTCHA |
| Need to combine country with other conditions   | WAF (AND/OR compound rules)    |

Distribution-level is free, simple, and uncomposable. WAF costs WCU but gives every feature downstream rules rely on. Start at the distribution level; upgrade to WAF when the policy grows. See [`../aws-waf/references/rate-limiting.md`](../aws-waf/references/rate-limiting.md) and [`../aws-waf/SKILL.md`](../aws-waf/SKILL.md).

## Field-level encryption

Field-level encryption encrypts specific fields in form POSTs (e.g., credit card numbers, SSNs) at the edge before forwarding to origin. The origin only sees ciphertext unless it holds the private key; other systems that log or observe requests cannot see cleartext.

Use for:

- PCI DSS scope reduction: origin holds the decryption key, intermediaries do not, narrowing the PCI scope.
- HIPAA workflows where PHI must not traverse logging systems in cleartext.
- Any scenario where a field must not be observable mid-path.

Configuration involves:

1. A field-level encryption key pair (public key stored in CloudFront, private key at origin).
2. A field-level encryption profile listing the field names to encrypt.
3. A field-level encryption configuration binding the profile to a content type pattern.
4. Attachment to a distribution behavior.

Link: [field-level encryption docs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/field-level-encryption.html). This is a specialized feature; reach for it when the compliance requirement exists, not as a general hardening step.

## Integration with WAF

The `CLOUDFRONT`-scope AWS WAF web ACL attaches to a distribution. Denying traffic at the CloudFront edge is cheaper (no origin hop) and safer (DDoS-scale traffic absorbed at the edge) than denying at the origin.

**Attachment pattern**:

```typescript
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';

const webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
  scope: 'CLOUDFRONT', // immutable; must be CLOUDFRONT for CloudFront distributions
  defaultAction: { allow: {} },
  visibilityConfig: {
    cloudWatchMetricsEnabled: true,
    metricName: 'MainWebAcl',
    sampledRequestsEnabled: true,
  },
  rules: [/* managed rule groups, rate limits, etc. */],
});

new cloudfront.Distribution(this, 'Dist', {
  defaultBehavior: { origin },
  webAclId: webAcl.attrArn,
});
```

Key points:

- The web ACL scope is immutable. A regional ACL cannot be converted to CloudFront; you must create a new one.
- The ACL attaches at the distribution level; all behaviors share it. Use scope-down statements keyed on URI path to apply rules to only some behaviors.
- WAF Challenge and CAPTCHA actions provide progressive defenses without hard blocks; see [`../aws-waf/references/bot-control-and-fraud.md`](../aws-waf/references/bot-control-and-fraud.md).
- Rate limiting at the edge via WAF is more effective than origin-side rate limiting because it absorbs the attacker's traffic before it reaches your compute. See [`../aws-waf/references/rate-limiting.md`](../aws-waf/references/rate-limiting.md).
- Client IP at the edge: use `CloudFront-Viewer-Address` for rate-limit keying. Never use `X-Forwarded-For` for security decisions at the edge.

**Challenge/CAPTCHA from the CloudFront perspective**: when WAF issues a Challenge or CAPTCHA action, CloudFront returns a small JavaScript/HTML page that the browser runs. On success, a signed token cookie is set and subsequent requests are allowed. CloudFront caches the challenge verification for a window, keeping the cost low. This works seamlessly with viewer-request CloudFront Functions as long as the function does not strip the WAF cookie.

**Shield Advanced**: CloudFront distributions protected by Shield Advanced get additional DDoS mitigations, a cost-protection SLA, and access to the Shield Response Team. See [`../aws-shield/SKILL.md`](../aws-shield/SKILL.md).

## Related

- [`../aws-waf/SKILL.md`](../aws-waf/SKILL.md) - `CLOUDFRONT`-scope web ACL attachment, managed rule groups, rate limiting.
- [`../aws-waf/references/rate-limiting.md`](../aws-waf/references/rate-limiting.md) - edge-keyed rate limits using `CloudFront-Viewer-Address`.
- [`../aws-waf/references/bot-control-and-fraud.md`](../aws-waf/references/bot-control-and-fraud.md) - Bot Control, ATP, and Challenge/CAPTCHA.
- [`../aws-shield/SKILL.md`](../aws-shield/SKILL.md) - DDoS protection for CloudFront distributions.
- [`distributions-and-origins.md`](distributions-and-origins.md) - origin lockdown via OAC, VPC Origins, Origin mTLS.
- [`cache-behaviors-and-policies.md`](cache-behaviors-and-policies.md) - Response Headers Policies for security headers.
- [`edge-functions.md`](edge-functions.md) - CloudFront Functions for token verification and Host header rewriting.
- [`troubleshooting.md`](troubleshooting.md) - OAC 403s, signed URL verification failures, TLS policy mismatches.
- [`pricing-and-plans.md`](pricing-and-plans.md) - tier gating for viewer mTLS, anycast IP pricing.
