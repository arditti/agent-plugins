# WAF Priority Slots

This is the single source of truth for rule ordering in a WAF web ACL. Use this slot map instead of picking priorities ad-hoc.

Two distinct structures exist depending on what you protect:

- **Websites** — default action Allow. Rules exist to block known threats (negative security).
- **APIs** — default action Block. Rules exist to validate and explicitly allow requests (positive security).

Rules in a web ACL evaluate in ascending priority order. Terminating actions (Block, Allow, CAPTCHA, Challenge when solved/failed) stop evaluation. Non-terminating actions (Count) continue evaluation and emit labels that later rules can match on. Reserve gaps between ranges so you can insert rules without renumbering.

## Websites (default Allow, block known threats)

| Priority | Rule Type | Action | Purpose |
|---|---|---|---|
| 0-10 | Anti-DDoS AMR | Block / Challenge | L7 DDoS auto-mitigation. Exclude API endpoints from Challenge using regex scope-down. |
| 10-20 | IP Allowlist | Allow | Trusted IPs bypass all rules (optional). |
| 30-40 | Blocklists | Block | Known-malicious IPs, headers, user-agents, JA3/JA4 fingerprints. |
| 50-60 | Geo-Blocking | Block | High-risk countries (optional). |
| 60-90 | Rate Limiting | Count | Global, per-method. |
| 90-100 | Body Size Restriction | Count | Tune to application. Default body inspection limit applies; larger limit available at additional cost — see [AWS WAF pricing](https://aws.amazon.com/waf/pricing/) and the [body inspection size docs](https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-statement-fields-list.html#waf-rule-statement-request-component-body). |
| 100-110 | IP Reputation AMR | Count / Challenge | Known-bad IPs, reconnaissance. |
| 110-120 | IP Rate Limit | Challenge | Rate limit for labeled DDoS IPs. |
| 120-130 | Anonymous IP AMR | Block / Challenge | VPNs, proxies, Tor (if required). |
| 130-140 | Core Rule Set AMR | Count | Body size, common exploits. |
| 140-150 | Known Bad Inputs AMR | Count | Malicious patterns, directory traversal. |
| 150-160 | Language/OS-specific AMRs | Count | PHP, Linux, POSIX, Windows — pick based on stack. |
| 160-170 | SQL Injection AMR | Count | Add only if a SQL backend exists. |
| 170-180 | Admin Protection AMR | Count | Protect admin paths. |
| 180-190 | Login Rate Limit | Count | Per-IP, per-URI login attempts. |
| 190-200 | Session Rate Limit | Count | Cookie/token rate limit on session creation. |
| 200-210 | Bot Control AMR (Common or Targeted) | Count | |
| 300-310 | Account Takeover Prevention (ATP) | Count | Credential stuffing detection. |
| 310-320 | Account Creation Fraud Prevention (ACFP) | Count | Fake signup detection. |

Rationale: basic filtering (IP, geo, rate) runs first to reduce load on the more expensive managed rules that inspect request bodies. Core protections (CRS, SQLi) evaluate before specialized rules (admin, bot). Authentication-specific controls (ATP, ACFP) sit last because they only need to run on traffic that has already passed the earlier gates.

### Stack-specific AMR selection

Pick AMRs based on the origin stack, not based on what sounds comprehensive. Adding every AMR inflates WCU and false positives.

| Managed Rule Group | When to add |
|---|---|
| `AWSManagedRulesLinuxRuleSet` | Linux-based servers (use together with UnixRuleSet). |
| `AWSManagedRulesUnixRuleSet` | POSIX-based servers (use together with LinuxRuleSet). |
| `AWSManagedRulesWindowsRuleSet` | Windows-based servers. |
| `AWSManagedRulesPHPRuleSet` | PHP applications. |
| `AWSManagedRulesWordPressRuleSet` | WordPress sites. |
| `AWSManagedRulesSQLiRuleSet` | Applications with SQL databases. |
| `AWSManagedRulesAdminProtectionRuleSet` | Applications exposing admin panels. |

## APIs (positive security, default Block)

Validation rules run in Count action and emit labels. A single terminating Allow rule at priority 9999 matches the AndStatement of all required labels. Everything else falls through to the default Block action.

| Priority | Rule Type | Action | Purpose |
|---|---|---|---|
| 0-10 | Anti-DDoS AMR | Block / Challenge | Same as website. Challenge scoped-down to exclude API paths. |
| 10-20 | IP Allowlist | Allow | |
| 30-40 | Blocklists | Block | |
| 50-60 | Geo-Blocking | Block | |
| 60-90 | Rate Limiting | Count | Per-IP, per-API-key, per-method, per-host+path, per-JA4+IP. |
| 90-100 | Body Size Restriction | Count | |
| 100-110 | IP Reputation AMR | Count / Challenge | |
| 110-120 | IP Rate Limit | Challenge | |
| 120-130 | Anonymous IP AMR | Block / Challenge | |
| 130-140 | **Path Validation** | Count + Label `api:valid-path` | Request path matches an allowed endpoint. |
| 140-150 | **Method Validation** | Count + Label `api:valid-method` | HTTP method allowed for that endpoint. |
| 150-160 | **Header Validation** | Count + Label `api:valid-headers` | Required headers present and valid. |
| 160-170 | **Query Parameter Validation** | Count + Label `api:valid-params` | Optional. |
| 170-180 | **Body Validation** (JSON schema, payload) | Count + Label `api:valid-body` | Optional. |
| 180-190 | Core Rule Set AMR | Count | |
| 190-200 | Known Bad Inputs AMR | Count | |
| 200-210 | SQL Injection AMR | Count | |
| 210-220 | Language/OS-specific AMRs | Count | |
| 220-230 | Bot Control AMR | Count | |
| 300-310 | ATP | Count | |
| 310-320 | ACFP | Count | |
| 9999 | Terminating Allow | Allow | `AndStatement(LabelMatchStatement...)` covering all required labels. |

Default action: **Block**.

## Single CloudFront distribution serving website + API

When one distribution fronts both a website and an API, scope-down validation rules by URI path (`/api/*` → API stack; everything else → website stack). At the bottom of the web ACL:

- Priority 9998 — Allow if URI does NOT start with `/api/` (website pass-through).
- Priority 9999 — Allow if URI starts with `/api/` AND all required API labels are present.
- Default action — **Block**.

This keeps negative-security rules protecting the website and positive-security rules protecting the API, in the same web ACL, with a single default-Block posture.

## Label naming convention

Format: `{service}:{aspect}`. Keep the service prefix consistent across a web ACL so AndStatement composition stays readable.

| Surface | Labels |
|---|---|
| REST API | `api:valid-path`, `api:valid-method`, `api:valid-headers`, `api:valid-params`, `api:valid-body` |
| GraphQL | `graphql:valid-operation`, `graphql:valid-depth`, `graphql:valid-complexity` |
| Multi-tenant | `tenant:valid-path`, `tenant:valid-method`, `tenant:valid-headers` |
| Versioned API | `version:valid-path`, `version:valid-method`, `version:valid-headers` |

## Statement type reference

| Statement | Use for |
|---|---|
| `ByteMatchStatement` | Exact/prefix/suffix/contains string match on a request component. |
| `RegexMatchStatement` | Single regex match against a request component. |
| `RegexPatternSetReferenceStatement` | Match any regex in a managed pattern set. |
| `SizeConstraintStatement` | Compare the size of a request component against a number. |
| `GeoMatchStatement` | Match source country code. |
| `IPSetReferenceStatement` | Match source IP against a managed `CfnIPSet`. |
| `RateBasedStatement` | Rate limit per aggregation key (IP, header, custom). |
| `LabelMatchStatement` | Match labels emitted by earlier rules in the web ACL. |
| `ManagedRuleGroupStatement` | Reference an AWS or vendor managed rule group. |
| `AndStatement` | All nested statements must match. |
| `OrStatement` | Any nested statement must match. |
| `NotStatement` | Invert a single nested statement. |

Small CDK examples:

```typescript
// ByteMatch: URI path starts with /api/v1/
const pathStatement: wafv2.CfnWebACL.StatementProperty = {
  byteMatchStatement: {
    fieldToMatch: { uriPath: {} },
    positionalConstraint: 'STARTS_WITH',
    searchString: '/api/v1/',
    textTransformations: [{ priority: 0, type: 'NONE' }],
  },
};

// LabelMatch: terminating Allow requires all validation labels
const allowValidated: wafv2.CfnWebACL.StatementProperty = {
  andStatement: {
    statements: [
      { labelMatchStatement: { scope: 'LABEL', key: 'api:valid-path' } },
      { labelMatchStatement: { scope: 'LABEL', key: 'api:valid-method' } },
      { labelMatchStatement: { scope: 'LABEL', key: 'api:valid-headers' } },
    ],
  },
};
```

## CfnWebACL skeleton with slot numbers

```typescript
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';

const webAcl = new wafv2.CfnWebACL(this, 'ApiWebAcl', {
  scope: 'CLOUDFRONT',
  defaultAction: { block: {} },
  visibilityConfig: {
    sampledRequestsEnabled: true,
    cloudWatchMetricsEnabled: true,
    metricName: 'ApiWebAcl',
  },
  rules: [
    // 0-10  Anti-DDoS AMR
    // 30-40 Blocklists
    // 60-90 Rate limiting
    // 130-140 Path validation (Count + label)
    // 140-150 Method validation (Count + label)
    // 150-160 Header validation (Count + label)
    // 180-230 Managed rule groups (Count)
    {
      name: 'AllowValidated',
      priority: 9999,
      action: { allow: {} },
      statement: allowValidated,
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: 'AllowValidated',
      },
    },
  ],
});
```

## Related

- [./web-acl-and-rules.md](./web-acl-and-rules.md) — web ACL structure and WCU budget
- [./positive-security-for-apis.md](./positive-security-for-apis.md) — deny-by-default API pattern
- [./managed-rules.md](./managed-rules.md) — AMR selection and tuning
- [./ddos-resilience.md](./ddos-resilience.md) — Anti-DDoS AMR, Shield integration
- [./rate-limiting.md](./rate-limiting.md) — rate-based statement patterns
- [../aws-cloudfront/SKILL.md](../aws-cloudfront/SKILL.md) — distribution-level controls
