# Positive Security for APIs

For APIs, prefer a **deny-by-default** positive security model over negative-security denylists. Negative security (blocking known bad) leaks on day-zero patterns and every new attack vector needs a new rule. Positive security denies everything not explicitly validated — the default posture rejects the unknown.

Apply it layer by layer. Each network and application layer should default to deny and explicitly allow only what is validated.

## Principle: deny unless explicitly allowed

| Layer | Default Posture | Explicitly Allow |
|---|---|---|
| CloudFront | Restrict viewer access | Known domains, signed requests, geo-allowed countries |
| WAF | BLOCK (API) / ALLOW with rules (website) | Validated paths, methods, headers, bodies |
| ALB | Deny all inbound | CloudFront VPC origin prefix list, known VPC CIDRs |
| NLB | Deny all inbound to targets | Global Accelerator IPs, known VPC CIDRs |
| API Gateway | Deny all | Resource policy: allow from VPC endpoint only |
| Security Groups | Deny all inbound | Specific ports from specific sources only |
| NACLs | Deny all | Known inbound/outbound port ranges |

The WAF layer is the focus of this document. The other layers matter — an open security group defeats a perfectly tuned web ACL — but the positive security *pattern* inside WAF is specific enough to warrant its own reference.

## How the WAF-layer positive security model works

Three-part architecture:

1. **Validation rules (priority 130-180)** — non-terminating, `Count` action, each emits a label when the request satisfies that layer's check.
2. **Terminating Allow rule (priority 9999)** — `AndStatement` over all required `LabelMatchStatement`s. Fires only when every validation layer has passed.
3. **Default action: BLOCK** — catches everything else. If a request missed any validation layer, no label was emitted, the AndStatement fails, and the default action rejects it.

Think of it as a series of conveyor-belt checkpoints. Each checkpoint stamps the package with a label. The gate at the end only opens if all stamps are present. Every other package falls off the belt.

## Label gotcha (critical)

Labels look simple but have sharp edges:

- **Labels are added at the END of a rule evaluation, not during.** A rule cannot match on its own label.
- **Labels are only available to rules that run AFTER the labeling rule.** Priority order determines what can and cannot match a label.
- **The rule action on the labeling rule MUST be `Count`, `CAPTCHA`, or `Challenge`.** `Block` and `Allow` are terminating — the label never flows to downstream rules.
- **Labels do NOT persist after web ACL evaluation ends.** They do not become response headers, request headers forwarded to the origin, or CloudWatch dimensions beyond the WAF metric. They live and die inside one web ACL evaluation.

Get any of these wrong and the terminating Allow rule never matches, the default Block fires, and every API request is rejected.

## Minimum required labels

The terminating Allow rule must require at least these three labels:

1. `api:valid-path` — request path matches an allowed endpoint.
2. `api:valid-method` — HTTP method allowed for that endpoint.
3. `api:valid-headers` — required headers present and valid.

## Optional additional labels

Add these when the endpoint has the corresponding surface:

- `api:valid-params` — query parameters match the endpoint contract.
- `api:valid-body` — body validates against the endpoint's JSON schema or payload constraints.

Include whichever optional labels apply in the terminating rule's AndStatement.

## Anti-DDoS interaction

API clients (SDKs, mobile apps, service-to-service callers) cannot solve CAPTCHA or complete a browser-based Challenge. If Anti-DDoS AMR applies `Challenge` action to API traffic, legitimate clients will fail.

Scope-down the Anti-DDoS AMR with a regex on `UriPath` so the Challenge action excludes API paths, or switch the action to Block for API paths and Challenge for the website paths. See [./ddos-resilience.md](./ddos-resilience.md) for the regex patterns and scope-down structure.

## CDK skeleton

Minimal L1 `CfnWebACL` showing path → method → headers → terminating Allow. The `RuleAction: Count` and label-first pattern is load-bearing — comments flag where it must not be changed.

```typescript
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';

const api = new wafv2.CfnWebACL(this, 'ApiPositiveSecurity', {
  scope: 'CLOUDFRONT',
  defaultAction: { block: {} }, // deny-by-default
  visibilityConfig: {
    sampledRequestsEnabled: true,
    cloudWatchMetricsEnabled: true,
    metricName: 'ApiPositiveSecurity',
  },
  rules: [
    // Count + label — rule must not terminate, or label never emits.
    {
      name: 'ValidatePath',
      priority: 130,
      action: { count: {} },
      ruleLabels: [{ name: 'api:valid-path' }],
      statement: {
        byteMatchStatement: {
          fieldToMatch: { uriPath: {} },
          positionalConstraint: 'STARTS_WITH',
          searchString: '/api/v1/users',
          textTransformations: [{ priority: 0, type: 'NONE' }],
        },
      },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: 'ValidatePath',
      },
    },

    // Count + label — scoped down to requests that already passed path validation.
    {
      name: 'ValidateMethod',
      priority: 140,
      action: { count: {} },
      ruleLabels: [{ name: 'api:valid-method' }],
      statement: {
        andStatement: {
          statements: [
            {
              labelMatchStatement: { scope: 'LABEL', key: 'api:valid-path' },
            },
            {
              byteMatchStatement: {
                fieldToMatch: { singleHeader: { name: ':method' } },
                positionalConstraint: 'EXACTLY',
                searchString: 'GET',
                textTransformations: [{ priority: 0, type: 'NONE' }],
              },
            },
          ],
        },
      },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: 'ValidateMethod',
      },
    },

    // Count + label — Authorization header present and Bearer-formatted.
    {
      name: 'ValidateHeaders',
      priority: 150,
      action: { count: {} },
      ruleLabels: [{ name: 'api:valid-headers' }],
      statement: {
        andStatement: {
          statements: [
            { labelMatchStatement: { scope: 'LABEL', key: 'api:valid-path' } },
            { labelMatchStatement: { scope: 'LABEL', key: 'api:valid-method' } },
            {
              regexMatchStatement: {
                fieldToMatch: { singleHeader: { name: 'authorization' } },
                regexString: '^Bearer [A-Za-z0-9._~+/-]+=*$',
                textTransformations: [{ priority: 0, type: 'NONE' }],
              },
            },
          ],
        },
      },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: 'ValidateHeaders',
      },
    },

    // Terminating Allow — only fires when every validation label is present.
    {
      name: 'AllowValidated',
      priority: 9999,
      action: { allow: {} },
      statement: {
        andStatement: {
          statements: [
            { labelMatchStatement: { scope: 'LABEL', key: 'api:valid-path' } },
            { labelMatchStatement: { scope: 'LABEL', key: 'api:valid-method' } },
            { labelMatchStatement: { scope: 'LABEL', key: 'api:valid-headers' } },
          ],
        },
      },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: 'AllowValidated',
      },
    },
  ],
});
```

## Composition with single CloudFront serving website + API

When one distribution serves both, scope-down validation rules so they only evaluate `/api/*`. At the bottom:

- Priority 9998 — Allow if URI does NOT start with `/api/` (website fall-through to negative-security evaluation earlier in the ACL).
- Priority 9999 — Allow if URI starts with `/api/` AND all API validation labels are present.
- Default action — **Block**.

The website gets negative security (AMRs in Count, specific blocks earlier). The API gets positive security (validate-and-Allow). Both share one web ACL.

## Variants

| API Style | Labels |
|---|---|
| REST API | `api:valid-path`, `api:valid-method`, `api:valid-headers`, `api:valid-params`, `api:valid-body` |
| GraphQL | `graphql:valid-operation`, `graphql:valid-depth`, `graphql:valid-complexity` |
| Multi-tenant | `tenant:valid-path`, `tenant:valid-method`, `tenant:valid-headers` |
| Versioned API | `version:valid-path`, `version:valid-method`, `version:valid-headers` |

Keep the service prefix consistent inside a web ACL. Do not mix `api:*` and `graphql:*` as synonyms — pick one per surface and stick to it.

## Anti-patterns

- **Using `Block` action on the labeling rule.** Block terminates evaluation before the label is emitted. The label never reaches downstream rules. Use `Count` on every labeling rule.
- **Skipping Count-first testing.** Flipping default action to `Block` in production without first confirming label emission in `SampledRequests` locks out real traffic. Deploy all validation rules in Count, confirm labels appear in CloudWatch and sampled requests for legitimate traffic, then change default action to Block.
- **Forgetting that managed rule groups don't emit these custom labels.** AMRs emit labels under the `awswaf:managed:*` namespace. Your terminating rule must match on `api:*` labels that *your* custom rules emit. Do not expect AMRs to validate paths or methods for you.
- **Using positive security on a website.** Dynamic content — user-generated URLs, marketing paths, A/B experiments, third-party tracking — makes the allowlist brittle and the maintenance burden unbounded. Use negative security for sites. Reserve positive security for APIs with a known, versioned contract.

## Related

- [./waf-priority-slots.md](./waf-priority-slots.md) — canonical priority map
- [./web-acl-and-rules.md](./web-acl-and-rules.md) — web ACL structure, WCU budget
- [./ddos-resilience.md](./ddos-resilience.md) — Anti-DDoS AMR scope-down for APIs
- [./troubleshooting.md](./troubleshooting.md) — debugging label flow, sampled requests
- [../aws-cloudfront/SKILL.md](../aws-cloudfront/SKILL.md) — distribution-level controls
