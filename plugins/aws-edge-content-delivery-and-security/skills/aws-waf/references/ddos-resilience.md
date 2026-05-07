# L7 DDoS Resilience with CloudFront and AWS WAF

**Edge-first.** L7 DDoS mitigation starts with CloudFront caching, not WAF rules. Cached responses serve from the POP at no origin cost and absorb volumetric traffic automatically. The layered defense is:

1. Maximize cache hit ratio at CloudFront so attack traffic never reaches origin compute.
2. Enable `AWSManagedRulesAntiDDoSRuleSet` (L7 AMR) for automated per-key mitigation during attacks.
3. Add targeted manual rate-based rules for known attack patterns you want faster-than-L7AMR coverage on.
4. Configure CloudFront origin-group failover to a static error page for catastrophic fallback.

This reference covers the WAF-native L7 DDoS path. It does **not** cover Shield Advanced (paid add-on, DRT engagement, cost protection), Firewall Manager (multi-account WAF/Shield policy management), or L3/L4 network DDoS (handled transparently by AWS infrastructure via Shield Standard, zero customer configuration required).

Default scope: **CloudFront**. Regional WAF is secondary.

## Contents

- [Caching as first-line DDoS defense](#caching-as-first-line-ddos-defense)
- [L7 AMR (AWSManagedRulesAntiDDoSRuleSet)](#l7-amr-awsmanagedrulesantiddosruleset)
- [Anti-DDoS AMR Deep Dive: Challengeable Requests and Label Composition](#anti-ddos-amr-deep-dive-challengeable-requests-and-label-composition)
- [L7 AMR vs manual rate rules](#l7-amr-vs-manual-rate-rules)
- [L7AM to L7 AMR migration](#l7am-to-l7-amr-migration)
- [CloudWatch alarming on DDoS events](#cloudwatch-alarming-on-ddos-events)
- [DDoS-resilient architecture patterns](#ddos-resilient-architecture-patterns)
- [Out of scope for this skill](#out-of-scope-for-this-skill)
- [Runbook: under active L7 DDoS](#runbook-under-active-l7-ddos)
- [Related](#related)

## Caching as first-line DDoS defense

The cheapest, fastest, most reliable L7 DDoS defense is a high cache hit ratio at CloudFront. A request served from a POP cache consumes zero origin compute and zero WAF request-evaluation cost beyond the initial inspection.

Design rules:

- **Cache static assets aggressively.** Images, CSS, JS, fonts — long TTLs, versioned URLs, `Cache-Control: public, max-age=…, immutable`.
- **Cache dynamic content for short TTLs where possible.** A 10-second TTL on a homepage means an attack delivering millions of RPS reaches origin at roughly one request per POP per window. That is a survivable load for almost any origin.
- **Use stale-while-revalidate.** When origin is briefly unreachable or slow, CloudFront continues serving stale content while attempting revalidation. Attack traffic that hits origin while origin is struggling does not take down the service.
- **Normalize cache keys.** A cache-busting query string or a hostile `Vary` header fragments the cache and reduces hit ratio. Use cache policies that strip cache-irrelevant query parameters.

A site with a high hit ratio is multiple orders of magnitude more attack-resilient than one with a low hit ratio, at zero WAF cost. The math: every percentage point of cache hit ratio you recover is a percentage point of attack volume that never touches compute and never pays per-request WAF inspection fees beyond the cached edge response.

### The caching-vs-rules trade-off

Do not reach for a WAF rule where a cache policy will do. Ordering the layers:

1. Is the response identical for many users? Cache it. This absorbs both legitimate traffic and attack traffic.
2. Is the response per-user but the query pattern enumerable? Personalize via CloudFront Functions or Lambda@Edge with shared cached fragments.
3. Is the request a write, an authenticated fetch, or actually per-user? Inspect at WAF.

Writing a WAF rate rule to limit a path that could have been cached is wasted engineering. Cache first; then WAF.

Cross-link: [`../aws-cloudfront/references/cache-behaviors-and-policies.md`](../aws-cloudfront/references/cache-behaviors-and-policies.md).

## L7 AMR (AWSManagedRulesAntiDDoSRuleSet)

The WAF-native L7 DDoS managed rule group. Launched 2025-06. Runs on both CloudFront and regional scope web ACLs.

### What it does

L7 AMR maintains per-distribution or per-web-ACL traffic baselines. When it detects anomalous spikes or known attack signature patterns, it dynamically creates short-lived per-key rate rules that apply Challenge or Block to the attacking keys. As the attack subsides and the keys drop below thresholds, it removes the temporary rules.

Two properties make this different from a manual rate rule:

- **No threshold tuning.** L7 AMR computes its own thresholds from the observed baseline.
- **Dynamic per-key expansion.** It identifies attacker keys across multiple dimensions — source IP, ASN, TLS fingerprint — without you pre-specifying which dimension the attacker will use.

### When to enable

Always, on every production CloudFront distribution and every production regional web ACL that fronts internet-facing traffic. The decision is "at what action level" not "whether."

### WCU and pricing

Refer to the [managed rule group capacity documentation](https://docs.aws.amazon.com/waf/latest/developerguide/aws-managed-rule-groups-list.html) for the current WCU cost and to the [WAF pricing page](https://aws.amazon.com/waf/pricing/) for the cost per request. L7 AMR is bundled in the CloudFront flat-rate tiers that include advanced DDoS coverage — see [`pricing-and-plans.md`](./pricing-and-plans.md).

### Action configuration

The default action is Challenge for detected attacker keys. Challenge is the right default because legitimate browsers pass transparently and scripted attack clients fail. Override to Block only for high-confidence scenarios where you have evidence the Challenge action is being bypassed.

### Scope-down

Apply L7 AMR with a scope-down statement if certain paths are latency-critical and you don't want the managed rule to touch them. A common pattern: scope L7 AMR to `/api/*` and the main site paths; exclude `/health` and other provider-to-provider machine paths where a Challenge response is wrong.

### CDK example

```typescript
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';

const l7AmrRule: wafv2.CfnWebACL.RuleProperty = {
  name: 'AWSManagedRulesAntiDDoSRuleSet',
  priority: 5, // very early in the rule chain
  statement: {
    managedRuleGroupStatement: {
      vendorName: 'AWS',
      name: 'AWSManagedRulesAntiDDoSRuleSet',
      // No explicit rule-level overrides at launch — accept defaults.
      // Scope-down keeps L7 AMR off low-value or latency-critical paths.
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
  overrideAction: { none: {} }, // apply the managed group's own actions
  visibilityConfig: {
    cloudWatchMetricsEnabled: true,
    metricName: 'AWSManagedRulesAntiDDoSRuleSet',
    sampledRequestsEnabled: true,
  },
};
```

Place L7 AMR early in the rule order (low priority number). The intent is to challenge-or-block attacker keys before any downstream rule evaluates them — both to save WCU on other rules and to ensure the Anti-DDoS action wins on contested requests.

### Deployment sequence for L7 AMR

1. Attach `AWSManagedRulesAntiDDoSRuleSet` to the web ACL in Count mode (override the group action to Count for the first observation window).
2. Watch the `awswaf:managed:aws:anti-ddos:*` label namespace in sampled requests and CloudWatch metrics. L7 AMR emits labels regardless of action, so Count mode gives you a full picture of what it would have challenged.
3. Confirm no legitimate-traffic patterns are being labeled. If synthetic monitoring or partner integrations trip the rule, add a scope-down to exclude their paths.
4. Switch to enforcement (remove the Count override). Keep monitoring the labels.
5. After a few weeks, evaluate whether the scope-down needs widening. The most common adjustment: paths you initially excluded from L7 AMR turn out to be attack targets you want protected.

### Labels emitted by L7 AMR

Refer to the [AWS Managed Rules reference](https://docs.aws.amazon.com/waf/latest/developerguide/aws-managed-rule-groups-list.html) for the authoritative label namespace. Labels identify:

- Which attack signature pattern matched (if any).
- Which aggregation dimension the detection used (IP-based, TLS-fingerprint-based, etc.).
- Whether the action taken was Challenge or Block.

Match on these labels in downstream rules if you want to apply additional policy — for example, a block rule that matches an L7 AMR label plus a geo condition, for cases where you want a harder response to L7 AMR detections from specific regions.

## Anti-DDoS AMR Deep Dive: Challengeable Requests and Label Composition

### Challengeable vs non-challengeable requests

The Anti-DDoS AMR distinguishes:

- **Challengeable** — GET requests whose URI does NOT match the Exempt URI regex. These can receive a silent JavaScript challenge. AMR emits the label `awswaf:managed:aws:anti-ddos:challengeable-request`.
- **Non-challengeable** — non-GET methods (POST, PUT, DELETE, PATCH) and GET requests whose URI matches the Exempt URI regex (default pattern excludes `/api` paths and static asset extensions). These cannot receive the JavaScript challenge and are only blocked when they reach the high-suspicion threshold.

Why it matters: clients that cannot run JavaScript (mobile apps, server-to-server, legacy integrations) would fail a silent browser challenge. The Exempt URI regex is a safety net — it defaults to letting API traffic through without the challenge. If you have a browser-only SPA and want every GET to be challengeable, override the Exempt regex.

### Configuration knobs

| Setting | Default | Effect |
| --- | --- | --- |
| `ChallengeAllDuringEvent` | Challenge | Challenge all non-suspicious challengeable requests during an active event (vs only suspicious) |
| Challenge sensitivity | Low | Low-suspicion challengeable requests get challenged; set to Medium to only challenge medium-and-above |
| DDoS block sensitivity | High | Only high-suspicion requests blocked; set to Medium or Low to block more aggressively |
| Exempt URI regex | Default pattern excludes `/api` and static asset extensions | URIs that cannot handle JS challenge are only eligible for Block, never Challenge |

### Client-type tuning

**Scenario: browser SPA or mobile app with the AWS WAF SDK**

Deploy the JavaScript or Mobile SDK. The SDK proactively acquires a challenge token at page load / app start, caches it, and attaches it to subsequent requests via the `x-aws-waf-token` header. Then override the Exempt URI regex to `\x00` (matches nothing) so every GET becomes challengeable. Requires the Targeted Bot Control AMR to be present in the web ACL. See [`./positive-security-for-apis.md`](./positive-security-for-apis.md) for the broader SDK-protected API pattern.

**Scenario: clients that cannot use the SDK (M2M, legacy)**

Relax the challenge progressively, in order of most-to-least protective:

1. Set `ChallengeAllDuringEvent` to Count — non-suspicious requests pass without challenge during events.
2. Raise Challenge sensitivity to Medium — only medium+ suspicion gets challenged.
3. Expand the Exempt URI regex to add endpoints that cannot handle the challenge.

**Scenario: non-challengeable requests overwhelm origin**

If your POST endpoints are sensitive, add block-sensitivity tuning and per-user rate-limiting:

1. Lower DDoS block sensitivity to Medium or Low — blocks more suspicious requests before origin reaches.
2. Add a rate-based rule scoped to the Anti-DDoS `ddos-request` label that aggregates per-user key (e.g. Authorization header) to limit suspicious traffic per identity.

### AMR-emitted labels (compose custom rules on these)

| Label | Meaning |
| --- | --- |
| `awswaf:managed:aws:anti-ddos:event-detected` | Web ACL is currently in an active DDoS event |
| `awswaf:managed:aws:anti-ddos:challengeable-request` | Request is eligible for JavaScript challenge |
| `awswaf:managed:aws:anti-ddos:ddos-request` | AMR classified this specific request as DDoS |

Custom rules compose ON these labels. See [label-based scope-down pattern](./web-acl-and-rules.md#label-based-scope-down-pattern) — same mechanics.

### Custom composition rules

Place AFTER the Anti-DDoS AMR in priority order (e.g. priorities 100–130).

**Challenge non-GET requests during DDoS events (when SDK is deployed)**

```json
{
  "Name": "ChallengeNonGetDuringDDoSEvent",
  "Priority": 100,
  "Action": { "Challenge": {} },
  "Statement": {
    "AndStatement": {
      "Statements": [
        { "NotStatement": { "Statement": { "ByteMatchStatement": {
          "FieldToMatch": { "Method": {} },
          "PositionalConstraint": "EXACTLY",
          "SearchString": "GET",
          "TextTransformations": [{ "Type": "NONE", "Priority": 0 }]
        } } } },
        { "LabelMatchStatement": {
          "Scope": "LABEL",
          "Key": "awswaf:managed:aws:anti-ddos:event-detected"
        } }
      ]
    }
  },
  "VisibilityConfig": {
    "SampledRequestsEnabled": true,
    "CloudWatchMetricsEnabled": true,
    "MetricName": "ChallengeNonGetDuringDDoSEvent"
  }
}
```

**Rate-limit suspicious non-challengeable requests per user (when SDK not available)**

```json
{
  "Name": "RateLimitSuspiciousUserRequests",
  "Priority": 110,
  "Action": { "Block": {} },
  "Statement": {
    "RateBasedStatement": {
      "Limit": 10,
      "AggregateKeyType": "CUSTOM_KEYS",
      "EvaluationWindowSec": 60,
      "CustomKeys": [
        { "Header": { "Name": "Authorization",
          "TextTransformations": [{ "Type": "NONE", "Priority": 0 }]
        } }
      ],
      "ScopeDownStatement": {
        "AndStatement": {
          "Statements": [
            { "LabelMatchStatement": {
              "Scope": "LABEL",
              "Key": "awswaf:managed:aws:anti-ddos:ddos-request"
            } },
            { "NotStatement": { "Statement": { "LabelMatchStatement": {
              "Scope": "LABEL",
              "Key": "awswaf:managed:aws:anti-ddos:challengeable-request"
            } } } }
          ]
        }
      }
    }
  },
  "VisibilityConfig": {
    "SampledRequestsEnabled": true,
    "CloudWatchMetricsEnabled": true,
    "MetricName": "RateLimitSuspiciousUserRequests"
  }
}
```

**Block DDoS requests to sensitive endpoints**

```json
{
  "Name": "BlockSensitiveEndpointsDDoS",
  "Priority": 120,
  "Action": { "Block": {} },
  "Statement": {
    "AndStatement": {
      "Statements": [
        { "ByteMatchStatement": {
          "FieldToMatch": { "UriPath": {} },
          "PositionalConstraint": "STARTS_WITH",
          "SearchString": "/api/expensive-query",
          "TextTransformations": [{ "Type": "NONE", "Priority": 0 }]
        } },
        { "LabelMatchStatement": {
          "Scope": "LABEL",
          "Key": "awswaf:managed:aws:anti-ddos:ddos-request"
        } }
      ]
    }
  },
  "VisibilityConfig": {
    "SampledRequestsEnabled": true,
    "CloudWatchMetricsEnabled": true,
    "MetricName": "BlockSensitiveEndpointsDDoS"
  }
}
```

**Defaults note:** priority slots 100-130 are reserved for these custom label-scoped rules — see [./waf-priority-slots.md](./waf-priority-slots.md).

### CDK wiring for an Anti-DDoS AMR with tuned configuration

```typescript
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';

const antiDdosAmr: wafv2.CfnWebACL.RuleProperty = {
  name: 'AWSManagedRulesAntiDDoSRuleSet',
  priority: 5,
  statement: {
    managedRuleGroupStatement: {
      vendorName: 'AWS',
      name: 'AWSManagedRulesAntiDDoSRuleSet',
      managedRuleGroupConfigs: [
        {
          ddosConfig: { lowUrgency: 'CHALLENGE' },
        },
      ],
      // Override the Exempt URI regex so every GET becomes challengeable
      // when the SDK is deployed across all clients.
      ruleActionOverrides: [
        {
          name: 'ChallengeAllDuringEvent',
          actionToUse: { challenge: {} },
        },
      ],
    },
  },
  overrideAction: { none: {} },
  visibilityConfig: {
    cloudWatchMetricsEnabled: true,
    metricName: 'AWSManagedRulesAntiDDoSRuleSet',
    sampledRequestsEnabled: true,
  },
};
```

For the agentic edge-delivery integration pattern (SDK token acquisition at page load, token propagation through CloudFront), see [`../aws-cloudfront/references/agentic-patterns.md`](../aws-cloudfront/references/agentic-patterns.md).

### Shield Advanced interaction

Out of scope for this skill in depth, but as a pointer: with Shield Advanced, the AMR complements its automatic L7 mitigation. AMR provides baseline-aware detection + challenge mitigation; Shield Advanced creates additional WAF rules during active attacks and can have DRT deploy custom mitigations. Route 53 health checks associated with Shield Advanced improve attack-detection accuracy.

## L7 AMR vs manual rate rules

Use both in layers. They do different jobs.

| Dimension | L7 AMR | Manual rate-based rule |
| --- | --- | --- |
| Attack patterns | Unknown, novel, bursty, volumetric | Known signatures, specific endpoints |
| Threshold tuning | Auto, none required | Manual, requires baseline measurement |
| Aggregation keys | Multiple dimensions dynamically | Pre-specified (IP, JA4, ASN, header, cookie, label) |
| Response time | Detects and acts on the attack window | Always-on; acts immediately on threshold breach |
| Best for | "Something is attacking, I don't know what" | "This specific endpoint has this specific abuse pattern" |
| WCU | See [managed rule documentation](https://docs.aws.amazon.com/waf/latest/developerguide/aws-managed-rule-groups-list.html) | See [rate-based rule WCU](https://docs.aws.amazon.com/waf/latest/developerguide/aws-waf-capacity-units.html) |

Layered deployment: L7 AMR at priority 5 for whole-site auto-mitigation, manual rate-based rules at priorities 50-90 for per-endpoint business-logic protection (see [`rate-limiting.md`](./rate-limiting.md)).

## L7AM to L7 AMR migration

Two similarly named capabilities exist. They are not the same thing.

- **L7AM** — Shield Advanced's L7 Automatic Mitigation. Legacy. Bundled in the Shield Advanced subscription. Requires Shield Advanced enrollment and comes with DRT (DDoS Response Team) engagement, cost protection, and proactive engagement at additional cost.
- **L7 AMR** — WAF-native managed rule group (`AWSManagedRulesAntiDDoSRuleSet`). Launched 2025-06. Included in WAF PAYG pricing per request, and bundled in CloudFront flat-rate tiers that include advanced DDoS coverage. No Shield Advanced subscription required.

### Migration path

1. Enable L7 AMR (`AWSManagedRulesAntiDDoSRuleSet`) on the same web ACLs that Shield Advanced's L7AM protects. Start in Count if you want a dry-run against an attack before enforcement.
2. Validate attack response during the next event (or force a load test).
3. Disable Shield Advanced's L7AM.
4. If Shield Advanced was purchased solely for L7AM, unsubscribe from Shield Advanced entirely. If it was purchased for cost protection or DRT engagement, keep the subscription.

### Why migrate

- Same L7 auto-mitigation capability without the Shield Advanced monthly subscription.
- Integrated directly in the WAF rule chain — same labels, same CloudWatch metrics, same logging destination as the rest of your rules.
- Configurable via CDK as a standard managed rule group; no separate Shield Advanced resource model.

Refer to the [Anti-DDoS rule group documentation](https://docs.aws.amazon.com/waf/latest/developerguide/aws-managed-rule-groups-list.html) for the authoritative reference, and check the AWS Shield migration guidance for the current recommended path.

## CloudWatch alarming on DDoS events

WAF emits per-web-ACL and per-rule metrics to CloudWatch:

- `AllowedRequests`
- `BlockedRequests`
- `CountedRequests`
- `CaptchaRequests`
- `ChallengeRequests`
- `PassedRequests`

### Alarms to configure

- **Sudden spike in `BlockedRequests`.** Attack in progress. Threshold: dynamic anomaly detection, or a fixed multiplier over rolling baseline.
- **Sudden spike in `AllowedRequests`.** Possible under-blocking — attack traffic reaching origin. Pair with origin-side latency / error alarms.
- **L7 AMR namespace label hits.** The Anti-DDoS rule group emits labels under the `awswaf:managed:aws:anti-ddos:*` namespace (see the [managed rule group reference](https://docs.aws.amazon.com/waf/latest/developerguide/aws-managed-rule-groups-list.html) for the authoritative namespace). A sudden rise in these labels signals the auto-mitigation is active.
- **`ChallengeRequests` + `CaptchaRequests` ratio shift.** If a previously quiet site is suddenly serving many Challenge responses, an attack is being absorbed.

Wire alarms to SNS → PagerDuty / OpsGenie / Slack. For on-call routing, separate "attack in progress" alarms from "possible under-blocking" alarms — they require different responses. An attack-in-progress alarm informs the on-call; an under-blocking alarm pages engineering to tune rules.

### Metric math for attack detection

Raw counters miss slow-building attacks that creep into the baseline. Use CloudWatch metric math to construct ratios:

- `BlockedRequests / (BlockedRequests + AllowedRequests)` — block ratio. A sudden change in block ratio indicates either a new attack or a freshly-over-tuned rule.
- `ChallengeRequests / AllowedRequests` — challenge ratio. A sudden spike means L7 AMR or another challenge-emitting rule has detected something.
- Delta-over-period on `BlockedRequests` — attack onset signal when the absolute count moves rapidly.

Use CloudWatch anomaly detection on the ratios where seasonality is strong; use fixed thresholds on the absolute counts where you know the baseline's steady-state.

### Example CloudWatch alarm (CDK)

```typescript
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';

declare const incidentTopic: sns.Topic;

const blockSpike = new cw.Alarm(this, 'WafBlockSpike', {
  metric: new cw.Metric({
    namespace: 'AWS/WAFV2',
    metricName: 'BlockedRequests',
    dimensionsMap: {
      WebACL: 'prod-edge-acl',
      Rule: 'ALL',
      Region: 'CloudFront',
    },
    statistic: 'Sum',
    period: cw.Duration.minutes(1),
  }),
  threshold: 10_000, // placeholder; tune against baseline
  evaluationPeriods: 2,
  comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
  treatMissingData: cw.TreatMissingData.NOT_BREACHING,
});
blockSpike.addAlarmAction(new cwActions.SnsAction(incidentTopic));
```

Use CloudWatch anomaly detection where seasonality is strong (weekly business cycles) rather than a fixed threshold.

## DDoS-resilient architecture patterns

### The default front door

CloudFront → WAF (with L7 AMR + targeted rate rules + managed rule groups) → origin. This is the baseline. No exceptions for internet-facing web traffic.

### Origin capacity headroom

Size origin compute to handle the **cache-miss traffic at expected cache hit ratio's P99**. If peak attack traffic combined with a momentary cache-hit-ratio dip multiplies origin load by 10x, your origin must survive that multiple or fail gracefully.

### Origin group failover to static S3 error page

Configure a CloudFront origin group with the primary application origin and a secondary S3 bucket serving a static "service temporarily unavailable" page. When the primary origin returns 5xx or times out, CloudFront fails over to S3. Under catastrophic L7 DDoS, this preserves brand presence instead of displaying a blank error.

### Price class

Use `PriceClass_All` for DDoS-prone properties. More POPs means more geographic absorption surface, larger total edge cache footprint, and a harder target to saturate.

### Multi-region origin failover

Configure origin groups across two regions (primary + DR). If the primary region's attack surface is overwhelmed at the origin layer, CloudFront fails over to the DR region. This does not help against an attack sized to overwhelm CloudFront itself — that is the job of CloudFront + Shield Standard + L7 AMR — but it does handle origin-specific attacks and regional infrastructure issues.

Cross-link: [`../aws-cloudfront/references/distributions-and-origins.md`](../aws-cloudfront/references/distributions-and-origins.md) for origin group configuration.

### Static fallback pattern

Host a minimal static "service unavailable" page in S3. Configure it as the secondary origin in a CloudFront origin group, with the primary origin being the live application. Configure failover criteria to include 5xx response codes, connection errors, and timeouts.

```typescript
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';

declare const primaryAlb: origins.LoadBalancerV2Origin;
declare const fallbackBucket: s3.Bucket;

const originGroup = new origins.OriginGroup({
  primaryOrigin: primaryAlb,
  fallbackOrigin: new origins.S3Origin(fallbackBucket),
  fallbackStatusCodes: [500, 502, 503, 504],
});

new cloudfront.Distribution(this, 'EdgeDistribution', {
  defaultBehavior: {
    origin: originGroup,
    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
  },
  webAclId: webAcl.attrArn,
});
```

Under catastrophic L7 DDoS, users see "service temporarily unavailable — please retry" instead of a blank error. The attacker has still won in the sense that the service is degraded, but brand and user trust are preserved relative to a full outage.

### Autoscaling policies for origin

Autoscaling cannot outrun a well-sized L7 DDoS. Do not rely on autoscaling as the primary DDoS defense. Autoscaling is the right mitigation for legitimate traffic spikes, not attack spikes. Under attack, the correct response is to absorb at CloudFront and block at WAF — not to spin up more origin capacity to receive more attack traffic. Size autoscaling for legitimate load; size WAF + CloudFront for attack load.

## Tuning L7 AMR

L7 AMR is designed to require minimal tuning, but it has configuration surface worth exercising once you understand your traffic.

### Action overrides

The managed rule group's default action per sub-rule varies. Override to Count for observability or to Block for stricter enforcement on well-understood signals. Avoid wholesale overrides before the rule has been in production long enough to establish a baseline — you're better off trusting AWS's defaults initially and tuning against observed evidence.

### Scope-down recipes

- **Exclude health checks and machine paths.** Synthetic monitoring, partner-to-partner API endpoints, and internal health paths should not be subject to L7 AMR. They are low-volume, predictable, and a Challenge response to them breaks monitoring.
- **Exclude static asset paths if cached aggressively.** If `/assets/*` has a 99.99% cache hit ratio, the requests that reach L7 AMR are cache-miss outliers — not representative attack surface. Excluding the path reduces noise.
- **Include all authenticated API paths and the homepage.** These are the high-value attack surface.

### Interaction with rate rules

L7 AMR and manual rate-based rules can fire on the same request. The first matching rule in priority order terminates evaluation; if L7 AMR is at priority 5 and your rate rule at priority 60, and both would match, L7 AMR wins. Order accordingly — if you want your targeted rate rule to override the L7 AMR managed group's action on specific paths, place the rate rule at a lower priority number than the managed group. But usually L7 AMR should go first.

### False positives

Rare for L7 AMR because it learns from your baseline. When they happen, the pattern is usually:

- A new marketing campaign drives an unusual traffic spike.
- A new partner integration sends a burst of requests from a single IP range.
- A load test runs against production and trips the rule.

Fix: scope-down excludes the partner path or IP range; for load tests, temporarily override to Count during the test window; for marketing campaigns, the baseline learns and L7 AMR self-corrects within the learning window.

## Out of scope for this skill

- **Shield Advanced.** The paid AWS add-on. Includes DRT engagement, cost protection against scaling spend during an attack, proactive engagement, and the global threat dashboard. If the user needs Shield Advanced, refer to the [AWS Shield Advanced documentation](https://docs.aws.amazon.com/waf/latest/developerguide/ddos-advanced-summary.html) and engage the AWS Shield team or AWS Support. Do not attempt to reproduce Shield Advanced capabilities with WAF rules alone.
- **L3/L4 network-layer DDoS.** Handled automatically by AWS infrastructure globally via Shield Standard. No customer configuration required. No WAF involvement. If the user reports "our network link is saturated" or "we're seeing SYN floods," route them to AWS Support and the Shield team.
- **Firewall Manager DDoS policies.** FMS is the multi-account policy orchestration layer for WAF, Shield, and VPC security groups. Out of scope for this skill; route to Firewall Manager documentation.
- **Route 53 / Global Accelerator DDoS.** Not in this skill.

## Runbook: under active L7 DDoS

1. **Verify the attack.** Check CloudWatch `BlockedRequests` spike, origin 5xx rate, origin latency. Confirm via sampled requests that blocked traffic has attack characteristics (suspicious user agents, single JA4 across many IPs, specific path concentration).
2. **Confirm L7 AMR is enabled and at enforcement.** If it was in Count mode, promote to enforcement immediately. Verify the rule is attached to the correct web ACL and the web ACL is associated with the CloudFront distribution.
3. **Absorb at the edge.** If the attack targets dynamic paths, temporarily raise cache TTLs on the affected paths via CloudFront cache policies. Invalidate after the incident.
4. **Add targeted rate rules.** If sampled requests reveal a consistent fingerprint — specific ASN, specific JA4, specific URI pattern — deploy a manual rate-based rule with that aggregation key. See [`rate-limiting.md`](./rate-limiting.md).
5. **Origin group failover.** If the origin is saturated despite caching and WAF mitigation, flip the origin group to the static fallback. Accept the degraded user experience as a better outcome than full outage.
6. **Escalate.** For Shield Advanced customers, engage DRT via the [AWS Shield engagement playbook](https://docs.aws.amazon.com/waf/latest/developerguide/ddos-response-team.html). For all others, open an AWS Support case with attack details and sampled request artifacts.
7. **Post-incident.**
   - Review which L7 AMR labels fired and whether the mitigation was fast enough.
   - Adjust scope-downs to widen L7 AMR coverage if the attack hit a path L7 AMR wasn't evaluating.
   - Document the attack signature and tune manual rate rules for faster future response.
   - Evaluate whether the attack justifies a pricing tier or Shield Advanced re-evaluation.
   - Capture sampled request artifacts before the sample window expires; they are the ground truth for the post-mortem.
   - Review the CloudFront cache hit ratio during the attack. If hit ratio dropped significantly, harden cache policies on the paths that were cache-miss-heavy during the incident.

### Pre-drill checklist

Run a tabletop exercise quarterly. The exercise:

1. Simulate sampled-request evidence of a specific attack signature (JA4 fingerprint, specific URI, datacenter ASN).
2. Walk the runbook step by step. Identify the owner of each step — who confirms L7 AMR is enabled, who deploys the targeted rate rule, who flips origin group.
3. Identify time-to-mitigate gaps. If deploying a rule takes longer than it should, automate.
4. Confirm alarm routing. A page that arrives in the wrong channel is a useless page.

Do this before you need it. The runbook executed cold for the first time during a real attack is slower by an order of magnitude than one rehearsed ahead of time.

## Application-layer vs network-layer: what WAF does and does not do

WAF inspects HTTP(S) requests. It operates at Layer 7. It does not see:

- Raw TCP SYN floods targeting CloudFront's network layer — handled by Shield Standard.
- UDP reflection attacks — not applicable to HTTPS traffic.
- Volumetric attacks against the AWS network infrastructure itself — handled by Shield Standard at global scale.

What WAF does see:

- HTTP request rate per aggregation key.
- HTTP request patterns — URI, headers, body, method.
- TLS client fingerprints (JA3, JA4).
- Source geography, ASN.
- Response-side signals (ATP, ACFP).

When a customer describes a "DDoS attack," clarify the layer. A network-level attack reaches AWS support and Shield; a L7 application attack is what this reference and L7 AMR address. Mis-diagnosing the layer wastes time.

## Testing L7 AMR behavior

You cannot deliberately DDoS your own production site to validate L7 AMR, and there's no button to say "AWS, pretend an attack is happening." Validation options:

1. **Wait for a real attack.** Not a plan, but eventually happens. Have alarming and runbooks ready.
2. **Synthetic controlled load test against a staging web ACL.** Run a load generator from a controlled IP range or ASN, observe L7 AMR labels fire, then stop. Useful for confirming the rule is wired correctly and alarms route. Scale down to avoid unintended cost.
3. **Review CloudWatch metrics and labels from past events.** If your property has had prior attacks, review how L7 AMR responded. The sampled requests and labels are the evidence.

The most valuable pre-event validation is confirming the configuration: L7 AMR is attached, the web ACL is associated, alarms are wired to the right on-call rotation, and the runbook is documented. You can't pre-test the attack response, but you can pre-test the plumbing.

## Integration with incident management

L7 DDoS incidents are a class of operational incident. Integrate WAF signals into your standard incident management workflow:

- **PagerDuty / OpsGenie / Slack alerts** on the high-severity metrics documented above.
- **Incident channel** dedicated to edge security events — separate from general application incidents, because the response team is different.
- **Post-incident review** template that includes: attack signature, time to detect, time to mitigate, whether L7 AMR fired on its own, what manual actions were taken, what went well, what to change.
- **Evidence retention** — sampled requests have a limited retention window. If an incident spans more than that window, export sampled requests to S3 or to your SIEM for post-mortem analysis.

## Do-not list for L7 DDoS

- Do not rely on origin autoscaling as your primary defense.
- Do not build custom rate rules as a substitute for L7 AMR — use both.
- Do not disable WAF or loosen rules during an attack to "see what's happening." You already have sampled requests for that, and disabling WAF removes your only active defense.
- Do not engage Shield Advanced mid-incident expecting a fast onboarding — Shield Advanced is a pre-planned subscription, not an emergency add-on.
- Do not publicly disclose which L7 AMR rules caught which attack patterns — attackers can tune against your disclosures.

## Related

- [`../aws-cloudfront/references/cache-behaviors-and-policies.md`](../aws-cloudfront/references/cache-behaviors-and-policies.md) — caching as the first-line DDoS defense.
- [`../aws-cloudfront/references/distributions-and-origins.md`](../aws-cloudfront/references/distributions-and-origins.md) — origin groups and failover.
- [`rate-limiting.md`](./rate-limiting.md) — manual rate-based rules with JA4 and ASN aggregation for targeted mitigation.
- [`managed-rules.md`](./managed-rules.md) — full managed rule group catalog including L7 AMR.
- [`web-acl-and-rules.md`](./web-acl-and-rules.md) — rule ordering and WCU considerations.
- [`pricing-and-plans.md`](./pricing-and-plans.md) — L7 AMR pricing and CloudFront flat-rate bundling.
- [`troubleshooting.md`](./troubleshooting.md) — sampled requests, CloudWatch metrics, and incident triage.
