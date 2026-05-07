# Rate Limiting with AWS WAF

Rate-based rules throttle per-identity request volume. They are the right tool for targeted abuse — credential stuffing, coupon brute-force, scraping loops, per-tenant API quota enforcement. They are the **wrong** tool for distributed L7 DDoS (use the Anti-DDoS managed rule group — see [`ddos-resilience.md`](./ddos-resilience.md)) and they are the wrong tool for application-logic abuse that isn't purely volume-driven (use Bot Control Targeted plus ATP/ACFP — see [`bot-control-and-fraud.md`](./bot-control-and-fraud.md)).

Default everything in this reference to **CloudFront scope**. Regional WAF (ALB, API Gateway, AppSync, Cognito, App Runner, Verified Access) is the secondary path and is called out where behavior diverges.

This skill does **not** cover Shield Advanced, Firewall Manager, or L3/L4 network-layer DDoS.

## Contents

- [Aggregation Keys at a Glance](#aggregation-keys-at-a-glance)
- [How rate rules work](#how-rate-rules-work)
- [Aggregation keys](#aggregation-keys)
- [JA4-based rate limiting](#ja4-based-rate-limiting)
- [ASN-based rate limiting](#asn-based-rate-limiting)
- [Header-based rate limiting (API keys)](#header-based-rate-limiting-api-keys)
- [Cookie-based rate limiting (sessions)](#cookie-based-rate-limiting-sessions)
- [Label-based rate limiting](#label-based-rate-limiting)
- [Scope-down statements](#scope-down-statements)
- [Choosing the threshold](#choosing-the-threshold)
- [Actions on rate violation](#actions-on-rate-violation)
- [Evaluation window and reset behavior](#evaluation-window-and-reset-behavior)
- [Tuning workflow](#tuning-workflow)
- [When rate rules are NOT the right tool](#when-rate-rules-are-not-the-right-tool)
- [Anti-patterns](#anti-patterns)
- [Related](#related)

## Aggregation Keys at a Glance

Pick the aggregation key that matches WHAT you want to throttle. The table below summarizes the common choices:

| Strategy | Aggregate Key | Use Case |
| --- | --- | --- |
| Per-IP | `IP` | General rate limiting; defeats casual abuse, loses to distributed attackers |
| Per-Forwarded-IP | `ForwardedIP` + header + position | Regional WAF behind a proxy. For CloudFront scope, WAF already sees the viewer IP — use `IP`. |
| Per-API-key | CustomKey `Header: x-api-key` | Tenant-level throttling; fairness across paying customers |
| Per-method + path | CustomKeys `HTTPMethod + UriPath` | Endpoint-specific limits (e.g. POST /api/login separate from GET /api/users) |
| Per-host header | CustomKey `Header: Host` | Multi-tenant sites with tenant-per-hostname |
| Per-JA3 or JA4 fingerprint | CustomKey `JA3Fingerprint` or `JA4Fingerprint` | Defeat distributed bots that rotate IPs but keep the same TLS client library |
| Per-JA4 + IP | CustomKeys `JA4Fingerprint + IP` | Tighter than JA4 alone — catches large botnets while tolerating shared CGNAT IPs |
| Per-cookie | CustomKey `Cookie: session-id` | Authenticated users — rate limit once login establishes a session |
| Per-ASN | CustomKey `ASN` | Throttle whole hosting providers (e.g. cap requests from all AWS/GCP/Azure ASN space) |
| Per-label | CustomKey `LabelNamespace` | Composed with label-emitting rules — rate limit only traffic that earned a specific label earlier in the web ACL |

Pair ANY of these with a `ScopeDownStatement` to narrow the rule to specific paths (`/api/login` only, not the whole site) before the aggregation kicks in.

### Composite key WCU caveat

Combining multiple keys into one `CustomKeys` array increases the rate rule's aggregation space but does not meaningfully change its WCU cost (`RateBasedStatement` base = 2 WCU). The ScopeDownStatement inside is what carries most of the WCU. Use the cheapest scope-down (LabelMatchStatement via a label-based pattern) when the rate rule is in the web ACL alongside multiple managed groups.

### Related

Cross-link to `./waf-priority-slots.md` (rate rules live in priority slots 60-90 for websites and 110-120 for IP rate limits), `./web-acl-and-rules.md#label-based-scope-down-pattern`, and `../aws-cloudfront/references/agentic-patterns.md` (AI-crawler rate limiting via JA4 + ASN).

## How rate rules work

A rate-based rule evaluates an **aggregation key** extracted from each request and maintains a count per unique key over a rolling evaluation window. When a key's count exceeds the configured threshold, the rule's action applies to subsequent requests from that key until the count drops below the threshold.

The three moving parts:

1. **Aggregation key** — what identifies the requester (IP by default, but configurable).
2. **Evaluation window** — rolling time range over which WAF counts. See the [AWS WAF rate-based rule documentation](https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-statement-type-rate-based.html) for the current supported window values.
3. **Threshold** — the request count above which the action fires.

Keep this model in mind: the rule is not a token bucket, not a per-request filter, and not a global request counter. It is a per-key counter with an action that activates above a line and deactivates below it.

## Aggregation keys

### IP (default)

The simplest case. WAF uses the source IP that terminated the TLS connection — for CloudFront scope, this is the real viewer IP because CloudFront is the edge. For regional WAF behind a proxy (ALB fronting nothing, or ALB behind a third-party CDN), the source IP is the proxy IP and every request aggregates to the same key. Use Forwarded IP for that case.

IP aggregation fails against distributed attackers who rotate source addresses. Combine with JA4 or ASN for meaningful coverage.

### Forwarded IP

Use this only for **regional** web ACLs where the request arrives through a proxy and the real client IP lives in a header such as `X-Forwarded-For`. Specify the header name, the IP position in the comma-separated list, and the fallback behavior when the header is missing.

For **CloudFront scope**, do not use Forwarded IP. WAF runs at the CloudFront edge and already sees the viewer IP directly.

### Custom keys

The full flexibility of rate-based rules. Available key components include header value, query string value, cookie value, URI path, HTTP method, label namespace, JA3 fingerprint, JA4 fingerprint, ASN, and country code. See the [custom aggregation keys documentation](https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-statement-type-rate-based.html) for the full list.

### Multiple keys in one rule

When you specify multiple custom key components, WAF concatenates them into a composite aggregation key. A request with `(ASN = 14618, URI = /api/login)` aggregates separately from `(ASN = 16509, URI = /api/login)`. Combining dimensions tightens the scope — useful when a single dimension alone is too coarse.

```typescript
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';

// Per-IP rate limit (the default), scoped to /api/*.
const perIpOnApi: wafv2.CfnWebACL.RuleProperty = {
  name: 'RateLimitPerIpOnApi',
  priority: 50,
  statement: {
    rateBasedStatement: {
      aggregateKeyType: 'IP',
      limit: 2000, // placeholder — tune against your baseline, start high
      evaluationWindowSec: 300, // link to docs for current supported values
      scopeDownStatement: {
        byteMatchStatement: {
          fieldToMatch: { uriPath: {} },
          positionalConstraint: 'STARTS_WITH',
          searchString: '/api/',
          textTransformations: [{ priority: 0, type: 'NONE' }],
        },
      },
    },
  },
  action: { count: {} }, // start in Count mode
  visibilityConfig: {
    cloudWatchMetricsEnabled: true,
    metricName: 'RateLimitPerIpOnApi',
    sampledRequestsEnabled: true,
  },
};
```

## JA4-based rate limiting

JA4 is a TLS client fingerprint. A single bot library produces the same JA4 across every egress IP — so a scraper rotating through a residential proxy pool still rate-limits as one key. This is the single most useful aggregation key against modern distributed scrapers.

Use JA4 when you see:
- Wide IP distribution with suspiciously uniform request timing.
- A thin slice of User-Agent values but many IPs.
- Signs of a coordinated client (same Accept-Language, same Accept-Encoding, same TLS ciphers) across IPs.

```typescript
const ja4Rate: wafv2.CfnWebACL.RuleProperty = {
  name: 'RateLimitByJa4',
  priority: 60,
  statement: {
    rateBasedStatement: {
      aggregateKeyType: 'CUSTOM_KEYS',
      limit: 500, // placeholder
      customKeys: [
        { ja4Fingerprint: { fallbackBehavior: 'NO_MATCH' } },
      ],
      scopeDownStatement: {
        byteMatchStatement: {
          fieldToMatch: { uriPath: {} },
          positionalConstraint: 'STARTS_WITH',
          searchString: '/search',
          textTransformations: [{ priority: 0, type: 'NONE' }],
        },
      },
    },
  },
  action: { challenge: {} },
  visibilityConfig: {
    cloudWatchMetricsEnabled: true,
    metricName: 'RateLimitByJa4',
    sampledRequestsEnabled: true,
  },
};
```

Fallback behavior matters. If JA4 is unavailable (rare), `NO_MATCH` excludes the request from aggregation; `MATCH` would lump all such requests into a single bucket, which can produce a runaway shared-key block.

## ASN-based rate limiting

Autonomous System Number aggregation caps traffic per upstream network. It is the right tool when one hosting provider is a disproportionate share of attack volume — think a datacenter ASN flooding `/api/login`. The entire ASN shares a counter, so a single compromised VM and a legitimate customer on the same cloud provider share a rate bucket. Use ASN with a scope-down to a high-signal path (login, signup, checkout) to avoid blocking legitimate datacenter traffic.

```typescript
const asnRate: wafv2.CfnWebACL.RuleProperty = {
  name: 'RateLimitByAsnOnLogin',
  priority: 70,
  statement: {
    rateBasedStatement: {
      aggregateKeyType: 'CUSTOM_KEYS',
      limit: 100, // placeholder
      customKeys: [
        { asn: {} },
        { uriPath: { textTransformations: [{ priority: 0, type: 'NONE' }] } },
      ],
      scopeDownStatement: {
        byteMatchStatement: {
          fieldToMatch: { uriPath: {} },
          positionalConstraint: 'EXACTLY',
          searchString: '/api/login',
          textTransformations: [{ priority: 0, type: 'NONE' }],
        },
      },
    },
  },
  action: { challenge: {} },
  visibilityConfig: {
    cloudWatchMetricsEnabled: true,
    metricName: 'RateLimitByAsnOnLogin',
    sampledRequestsEnabled: true,
  },
};
```

Combine ASN with URI path in custom keys so each path gets its own per-ASN counter. Without the path component, `/api/login` and `/api/healthcheck` share a bucket.

## Header-based rate limiting (API keys)

Rate-limit per `X-API-Key` (or equivalent tenant identifier) to enforce tenant fairness and contain rogue keys. A customer with a compromised API key cannot exhaust service capacity for others.

```typescript
const apiKeyRate: wafv2.CfnWebACL.RuleProperty = {
  name: 'RateLimitPerApiKey',
  priority: 80,
  statement: {
    rateBasedStatement: {
      aggregateKeyType: 'CUSTOM_KEYS',
      limit: 1000, // placeholder — set per your per-tenant contract
      customKeys: [
        {
          header: {
            name: 'x-api-key',
            textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
          },
        },
      ],
      scopeDownStatement: {
        byteMatchStatement: {
          fieldToMatch: { uriPath: {} },
          positionalConstraint: 'STARTS_WITH',
          searchString: '/api/',
          textTransformations: [{ priority: 0, type: 'NONE' }],
        },
      },
    },
  },
  action: { block: {} },
  visibilityConfig: {
    cloudWatchMetricsEnabled: true,
    metricName: 'RateLimitPerApiKey',
    sampledRequestsEnabled: true,
  },
};
```

Block (not Challenge) is appropriate here: an API client is not going to solve a JS challenge.

## Cookie-based rate limiting (sessions)

Once a user has a session cookie, aggregate rate by session. This is less useful as a first-line control because unauthenticated traffic has no session — pair it with an upstream IP or JA4 rate rule for pre-auth traffic.

```typescript
const sessionRate: wafv2.CfnWebACL.RuleProperty = {
  name: 'RateLimitPerSession',
  priority: 85,
  statement: {
    rateBasedStatement: {
      aggregateKeyType: 'CUSTOM_KEYS',
      limit: 300, // placeholder
      customKeys: [
        {
          cookie: {
            name: 'session_id',
            textTransformations: [{ priority: 0, type: 'NONE' }],
          },
        },
      ],
    },
  },
  action: { challenge: {} },
  visibilityConfig: {
    cloudWatchMetricsEnabled: true,
    metricName: 'RateLimitPerSession',
    sampledRequestsEnabled: true,
  },
};
```

## Label-based rate limiting

Labels are WAF's internal annotation mechanism — an earlier rule emits a label, a later rule matches the label. The pattern for label-based rate limiting is:

1. A low-cost match rule emits a label on requests to a protected endpoint (for example `login-endpoint`).
2. A rate-based rule aggregates on that label namespace.

This lets you keep the expensive rate aggregation scoped narrowly and express intent in the rule name.

```typescript
// Rule 1: emit label on login requests.
const labelLogin: wafv2.CfnWebACL.RuleProperty = {
  name: 'LabelLoginEndpoint',
  priority: 10,
  statement: {
    byteMatchStatement: {
      fieldToMatch: { uriPath: {} },
      positionalConstraint: 'EXACTLY',
      searchString: '/api/login',
      textTransformations: [{ priority: 0, type: 'NONE' }],
    },
  },
  action: { count: {} }, // non-terminating; emits the label
  ruleLabels: [{ name: 'endpoint:login' }],
  visibilityConfig: {
    cloudWatchMetricsEnabled: true,
    metricName: 'LabelLoginEndpoint',
    sampledRequestsEnabled: true,
  },
};

// Rule 2: rate-limit on the label.
const rateOnLoginLabel: wafv2.CfnWebACL.RuleProperty = {
  name: 'RateLimitLoginLabel',
  priority: 20,
  statement: {
    rateBasedStatement: {
      aggregateKeyType: 'CUSTOM_KEYS',
      limit: 50, // placeholder
      customKeys: [
        { labelNamespace: { namespace: 'awswaf:clientside:endpoint:' } },
      ],
      scopeDownStatement: {
        labelMatchStatement: { scope: 'LABEL', key: 'endpoint:login' },
      },
    },
  },
  action: { challenge: {} },
  visibilityConfig: {
    cloudWatchMetricsEnabled: true,
    metricName: 'RateLimitLoginLabel',
    sampledRequestsEnabled: true,
  },
};
```

## Scope-down statements

Every rate rule in production should carry a scope-down. Reasons:

- **False positive reduction.** A rule applied to every request will rate-limit legitimate high-volume paths (static assets, health checks, RSS feeds).
- **WCU reduction.** The rate rule only evaluates requests that pass the scope-down filter.
- **Clarity.** Future-you reads `/api/login` in the rule and knows what it protects.

Rule of thumb: if a rule's name or intent references a specific endpoint or traffic class, its scope-down must enforce that scope.

## Choosing the threshold

1. **Measure baseline.** Use sampled requests or CloudWatch metrics to establish P99 request volume per aggregation key on the target path.
2. **Set threshold above legitimate P99.** Pick a number comfortably above the 99th percentile of well-behaved traffic.
3. **Start high.** A too-low threshold in Block mode is an outage. A too-high threshold in Block mode is a tolerable leak for a day while you tune.
4. **Start in Count.** See [Tuning workflow](#tuning-workflow).
5. **Link to the evaluation window documentation** for the current supported window lengths: [AWS WAF rate-based rule statement](https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-statement-type-rate-based.html).

Do not pick a threshold from intuition. Measure first.

## Actions on rate violation

In priority order of preference for new rules:

1. **Count** — always start here. Measure impact. Free in terms of user experience.
2. **Challenge** — silent JavaScript proof-of-browser. Legitimate browsers pass transparently; scripted clients fail. The right first-line enforcement action once a rule is tuned.
3. **CAPTCHA** — human-interactive challenge. Use when Challenge is not enough (adversary is running headless-browser automation that passes JS challenges). Has a user-experience cost.
4. **Block** — hard 403. Reserve for keys that are unambiguously malicious (known-bad ASNs, JA4 fingerprints with a documented abuse history).

Mixing actions across rate rules in a single web ACL is normal. Per-IP on public paths at Challenge, per-API-key at Block, per-ASN on login at Challenge.

## Evaluation window and reset behavior

WAF counts per key within a rolling window. Refer to the [rate-based rule documentation](https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-statement-type-rate-based.html) for the current supported window values.

Key properties of the counter:

- The action applies **while the key is above threshold** and stops applying **once the key drops below**.
- The counter is not a global quota. A blocked key that stops sending requests will eventually drop back below threshold and be allowed again.
- No persistent ban state in the rate rule. If you need persistent bans, emit a label on rate violation and match that label in a downstream block rule (or use an external IP set updated on rate events).

## Tuning workflow

1. **Deploy in Count.** Attach the new rate rule with `action: { count: {} }`.
2. **Observe for at least one full traffic cycle** — a week if you have weekly seasonality. Watch the `CountedRequests` metric and sampled requests.
3. **Examine the blocked-key distribution.** Pull the top keys from sampled requests. Validate each top key is a plausible attacker (bot user agents, datacenter ASNs, non-human request timing).
4. **Tighten the scope-down** if you see legitimate paths being counted.
5. **Promote to Challenge.** Legitimate browsers pass transparently; the attacker feels the friction.
6. **Promote to Block** only for keys you are certain are malicious. Often this is a narrower, more specific rule layered on top (for example: block the specific JA4 fingerprint in a block rule, keep the generic per-IP rate at Challenge).

## When rate rules are NOT the right tool

- **Distributed L7 DDoS from thousands of IPs, no fingerprint commonality.** Use `AWSManagedRulesAntiDDoSRuleSet` (L7 AMR). See [`ddos-resilience.md`](./ddos-resilience.md).
- **Application-logic abuse that isn't volume-based.** Coupon enumeration, gift-card redemption, inventory scraping at human-plausible rates. Use Bot Control Targeted plus ATP/ACFP. See [`bot-control-and-fraud.md`](./bot-control-and-fraud.md).
- **Legitimate spiky traffic.** Sale events, flash launches. Use scope-down to exclude the path, lean on CloudFront caching (see [`../aws-cloudfront/references/cache-behaviors-and-policies.md`](../aws-cloudfront/references/cache-behaviors-and-policies.md)), or raise thresholds temporarily.
- **Credential-stuffing detection.** Rate rules catch volume; ATP catches the outcome (login success/failure pattern). Deploy both — rate on the login path for coarse volume control, ATP for authentication intelligence.

## Combining rate rules with other controls

Rate-based rules work best when layered with other rule types. The typical production stack on a high-value endpoint:

1. **Geo or ASN coarse filter** (low priority number, runs first) — block or challenge traffic from regions or networks where you have no legitimate audience.
2. **IP reputation managed group** — `AWSManagedRulesAmazonIpReputationList` drops known-bad IPs at low WCU cost.
3. **L7 AMR** — automatic L7 DDoS detection.
4. **Bot Control** — common and targeted inspection, scope-down to the sensitive endpoints.
5. **Rate-based rule** — the topic of this reference. Targeted per-endpoint, per-identity-dimension.
6. **ATP / ACFP** — specific to login and signup flows.
7. **Custom business-logic rules** — application-specific patterns.

The rate rule at layer 5 catches anything that made it past the earlier layers. Attackers that would be matched by IP reputation or L7 AMR don't reach the rate rule; the rate rule absorbs what the earlier layers missed.

## Label-aware rate rule composition

Labels are the primary mechanism for rule-to-rule communication in a web ACL. A rate rule can emit a label on violation, and a downstream rule can act on that label. Patterns:

### Pattern: soft-then-hard

- Rate rule at Count with a label (`rate:login:exceeded`).
- Second rule matches the label and applies Block.

This gives you a clean separation of measurement (rate rule) from enforcement (block rule) and lets you apply different enforcement actions for the same rate condition depending on additional context.

### Pattern: graduated response

- First rate rule with low threshold emits label `rate:tier1`.
- Second rate rule with higher threshold emits label `rate:tier2`.
- Action rule matches `rate:tier1` → Challenge, matches `rate:tier2` → Block.

Attackers who trip the lower threshold get Challenge; persistent attackers who trip the higher threshold get Block. Legitimate users who briefly exceed threshold get the Challenge and pass through.

### Pattern: context-aware rate limiting

- Earlier rule emits label `user:authenticated` if session cookie is present and valid.
- Rate rule has scope-down that requires negation of the label — only applies to unauthenticated traffic.

Authenticated traffic is usually better behaved and doesn't need aggressive rate limiting. Unauthenticated traffic (pre-login, API without key) is the riskier class and gets the rate rule.

## Anti-patterns

- **Global rate rule with no scope-down.** Rate-limiting every path on every visitor is an outage waiting for a marketing campaign.
- **IP-only aggregation against a distributed attacker.** If the attacker has 50,000 IPs and you set a 100 RPS per-IP threshold, the attacker gets 5M RPS legally. Use JA4 + ASN.
- **Setting thresholds by intuition.** Every threshold in production must trace back to a measured baseline.
- **Skipping Count mode.** Blocking traffic you haven't observed is how you ship a production incident.
- **Treating rate rules as a DDoS control.** They are not. L7 AMR is.
- **Stacking many overlapping rate rules at the same scope.** Reason: the first one to match terminates evaluation. The rest are dead code.

## Related

- [`web-acl-and-rules.md`](./web-acl-and-rules.md) — rule priority, WCU, scope-down composition.
- [`custom-rules-and-regex.md`](./custom-rules-and-regex.md) — label-emitting custom rules to pair with label-aggregated rate rules.
- [`bot-control-and-fraud.md`](./bot-control-and-fraud.md) — Bot Control, ATP, ACFP for non-volume abuse.
- [`ddos-resilience.md`](./ddos-resilience.md) — L7 AMR and the distributed-DDoS path.
- [`managed-rules.md`](./managed-rules.md) — managed rule groups, including L7 AMR.
- [`troubleshooting.md`](./troubleshooting.md) — sampled requests, false-positive investigation.
- [`../aws-cloudfront/references/agentic-patterns.md`](../aws-cloudfront/references/agentic-patterns.md) — AI crawler rate-limiting patterns.
- [`../aws-cloudfront/references/cache-behaviors-and-policies.md`](../aws-cloudfront/references/cache-behaviors-and-policies.md) — absorbing traffic at the edge before rate rules even see it.
