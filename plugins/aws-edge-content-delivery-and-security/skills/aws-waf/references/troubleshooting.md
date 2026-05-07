# AWS WAF Troubleshooting

WAF troubleshooting follows a consistent workflow. Start with the cheapest diagnostic and escalate only as needed. Sampled requests are always the first step — they are free, already enabled by default, and usually reveal the root cause without any code change or log-pipeline investigation.

The order:

1. **Sampled requests** — free, always on, web console or API.
2. **Labels and CloudWatch metrics** — free signal on which rules are matching and at what volume.
3. **Top Insights dashboard** — zero-config aggregate view (launched 2025-01).
4. **Full logging** — enable only when sampled requests don't tell the full story. Costs request-volume-proportional money.

Default scope: **CloudFront**. Regional WAF is secondary. This reference does **not** cover Shield Advanced, Firewall Manager, or L3/L4 DDoS.

## Contents

- [False-positive investigation workflow](#false-positive-investigation-workflow)
- [WAF logging destinations](#waf-logging-destinations)
- [Log filtering](#log-filtering)
- [Sampled requests](#sampled-requests)
- [Count mode testing](#count-mode-testing)
- [Data protection in logs](#data-protection-in-logs)
- [Top Insights](#top-insights)
- [Common issues](#common-issues)
- [Verifying a web ACL association](#verifying-a-web-acl-association)
- [Sampled request anatomy](#sampled-request-anatomy)
- [WAF CloudWatch metrics](#waf-cloudwatch-metrics)
- [Related](#related)

## False-positive investigation workflow

Six steps. Execute in order.

### 1. Enable Count mode on the suspect rule

If a custom rule is the suspect, change its action to Count. If a managed rule group is the suspect, use a per-rule override to set the specific sub-rule to Count, or (temporarily, for broad investigation) override the entire group to Count.

```typescript
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';

// Managed rule group with a per-rule override to Count.
const coreRuleSet: wafv2.CfnWebACL.RuleProperty = {
  name: 'AWSManagedRulesCommonRuleSet',
  priority: 20,
  statement: {
    managedRuleGroupStatement: {
      vendorName: 'AWS',
      name: 'AWSManagedRulesCommonRuleSet',
      ruleActionOverrides: [
        // Investigate this specific sub-rule; set it to Count while we tune.
        { name: 'SizeRestrictions_BODY', actionToUse: { count: {} } },
      ],
    },
  },
  overrideAction: { none: {} },
  visibilityConfig: {
    cloudWatchMetricsEnabled: true,
    metricName: 'AWSManagedRulesCommonRuleSet',
    sampledRequestsEnabled: true,
  },
};
```

Count mode keeps the rule evaluating and recording matches, but does not block. Users continue to reach the origin. You get diagnostic data without an outage.

### 2. Pull sampled requests

In the console: web ACL → Sampled requests → last 3 hours (or relevant window). Filter by rule name or action. The sample includes the request headers, URI, method, source IP, matched rule, and labels. This is free and on by default.

### 3. Identify the matching rule

The sampled request's `RuleWithinRuleGroup` field identifies the specific managed rule sub-rule, or the custom rule name for a custom rule. If the match is in a managed rule group, you now have the exact sub-rule to override.

### 4. Apply the fix

Four levers:

- **Scope-down.** Add a scope-down statement to the rule so it only applies to the paths where it matters. Often the right fix — the rule logic is correct but its scope is too broad.
- **Per-rule override.** For managed rule groups, override the specific sub-rule to Count (diagnostic) or set per-rule overrides that change its action.
- **Exception via label.** Emit a pre-inspection label on the legitimate-request pattern with an earlier rule, then match-out (negate) that label in the expensive rule's statement.
- **Tune the custom rule.** If it's your own regex or byte match, narrow the match criteria.

### 5. Test in Count

Deploy the fix. Keep Count mode on the suspect rule. Watch sampled requests and CloudWatch `CountedRequests` for the same rule. The legitimate traffic should no longer match. If it still matches, the fix didn't work — iterate.

### 6. Promote to Block

Remove the Count override. The rule now enforces. Watch for a day or two; sampled requests and the `BlockedRequests` metric should show only attack-pattern matches.

## WAF logging destinations

Three options, each with different trade-offs.

### CloudWatch Logs (vended, launched 2025-09)

The recommended default for most deployments. Native integration with CloudWatch Log Insights queries. Priced differently from routing through Kinesis Firehose to CloudWatch — typically cheaper. Supports the same log filtering primitives as other destinations.

```typescript
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as logs from 'aws-cdk-lib/aws-logs';

declare const webAcl: wafv2.CfnWebACL;

const logGroup = new logs.LogGroup(this, 'WafLogGroup', {
  logGroupName: 'aws-waf-logs-prod-edge',
  retention: logs.RetentionDays.THREE_MONTHS,
});

const logConfig = new wafv2.CfnLoggingConfiguration(this, 'WafLogging', {
  resourceArn: webAcl.attrArn,
  logDestinationConfigs: [logGroup.logGroupArn],
  loggingFilter: {
    DefaultBehavior: 'DROP',
    Filters: [
      {
        Behavior: 'KEEP',
        Conditions: [
          { ActionCondition: { Action: 'BLOCK' } },
          { ActionCondition: { Action: 'COUNT' } },
          { ActionCondition: { Action: 'CAPTCHA' } },
          { ActionCondition: { Action: 'CHALLENGE' } },
        ],
        Requirement: 'MEETS_ANY',
      },
    ],
  },
});
```

Log group names for WAF must start with `aws-waf-logs-`.

### Amazon S3

Long-term retention and ad-hoc Athena queries. Cost-efficient for archival and compliance scenarios where most logs are never read but must be retained. Use S3 lifecycle policies to tier to Glacier for older logs.

### Kinesis Data Firehose

For real-time pipelines into SIEMs (Splunk, Datadog, third-party) or custom downstream processing. More expensive than the vended CloudWatch Logs destination for the same delivery outcome. Use only when the SIEM integration requires it or when stream processing is needed.

See [WAF logging destinations documentation](https://docs.aws.amazon.com/waf/latest/developerguide/logging.html) for the current destination catalog and delivery guarantees.

## Log filtering

Reduce log volume — and log cost — at the source. The two primary filters:

### By action

Drop `Allow` actions. On a healthy production site, `Allow` is typically 99%+ of request volume. The log value per Allow action is minimal relative to the cost. Keep `Block`, `Count`, `CAPTCHA`, `Challenge`.

### By rule label

Keep only requests that hit specific rules of interest. Useful during targeted investigations.

```typescript
const tunedLogging = new wafv2.CfnLoggingConfiguration(this, 'WafLoggingTuned', {
  resourceArn: webAcl.attrArn,
  logDestinationConfigs: [logGroup.logGroupArn],
  loggingFilter: {
    DefaultBehavior: 'DROP',
    Filters: [
      // Keep anything that was blocked.
      {
        Behavior: 'KEEP',
        Conditions: [{ ActionCondition: { Action: 'BLOCK' } }],
        Requirement: 'MEETS_ANY',
      },
      // Keep anything with the ATP label for forensic review.
      {
        Behavior: 'KEEP',
        Conditions: [
          { LabelNameCondition: { LabelName: 'awswaf:managed:aws:atp:signal:credential_compromised' } },
        ],
        Requirement: 'MEETS_ANY',
      },
    ],
  },
});
```

See [`pricing-and-plans.md`](./pricing-and-plans.md) for log cost optimization in broader context.

## Sampled requests

Free and on by default when `visibilityConfig.sampledRequestsEnabled = true` on each rule and the web ACL's default action. WAF retains a time-bounded sample of inspected requests (not every request — a sample). Useful for spot-checking, first-line debugging, and tuning.

Access:

- **Console.** Web ACL → Sampled requests tab.
- **API.** `wafv2 get-sampled-requests` — specify web ACL ARN, rule metric name, time window, and sample size.

Sampled requests should always be the first diagnostic before enabling full logging. If the question is "why did this specific request get blocked" and the request happened recently, sampled requests almost always answer it without touching logs.

### When sampled requests aren't enough

- Question needs aggregation across many requests → use CloudWatch metrics.
- Question needs retrospective analysis beyond the sample window → use full logs.
- Question needs request-body contents (sampled requests don't store body) → use full logs with the right field configuration.

## Count mode testing

Every new rule deploys in Count mode. Every managed rule group override for an unfamiliar sub-rule starts in Count. This is non-negotiable.

The workflow:

1. Add the rule with `action: { count: {} }` (for custom) or a per-rule override set to Count (for managed groups).
2. Watch `CountedRequests` for this specific rule in CloudWatch. Period of observation: one full traffic cycle. For weekly seasonality, a week. For daily seasonality, at least three days.
3. Cross-check with sampled requests — verify the matched requests are actually bad (attack-pattern, non-human, known-bad fingerprint).
4. If false positives appear, fix via scope-down or label exception. Stay in Count.
5. Only once the false-positive rate is zero (or acceptably low and explicitly justified) promote to Block.

Blocking traffic you haven't observed is how production incidents happen. Count mode is free in user-experience cost and costs the same per-request inspection fee as Block — no reason to rush.

### Count-mode promotion checklist

Before promoting a rule from Count to Block:

1. The rule has been in Count for at least one full traffic cycle (weekly seasonality: one week).
2. Sampled requests for matches show only attack patterns — no known partner IPs, no internal synthetic monitoring, no legitimate user agents on legitimate paths.
3. CloudWatch `CountedRequests` is within the expected order of magnitude. If it's far higher than expected, the rule is over-matching.
4. The rule has a scope-down if it targets specific paths.
5. A rollback plan exists. In CDK, the rollback is "revert the PR"; confirm deployment permissions work both directions.

Only after all five are true, promote.

## Data protection in logs

Launched 2025-02. Configure field-level PII redaction in logs: which headers, query parameters, cookies, and body fields get hashed or dropped before logs emit.

Use cases:

- **Compliance.** GDPR, PCI, HIPAA — prevent raw PII in WAF logs.
- **Cost.** Large headers (cookies, auth tokens) contribute non-trivial log volume. Redacting them reduces log size.
- **Security hygiene.** Don't log raw `Authorization` headers, session cookies, or credit card numbers. Data protection is the right tool.

See the [data protection documentation](https://docs.aws.amazon.com/waf/latest/developerguide/data-protection-general.html) for the CDK/CloudFormation configuration surface. Configure fields to hash (reversible with a hash-key-holder) or drop (irreversible).

```typescript
// Reference: data protection is configured as part of the CfnWebACL.dataProtectionConfig
// per the current WAF data protection documentation. Apply to sensitive fields:
// Authorization header, session cookies, any body/query fields containing PII.
```

## Top Insights

Launched 2025-01. Console-level dashboard showing aggregate WAF activity:

- Top attacking source IPs.
- Top rules triggering.
- Top attacked URIs.
- Top matched labels.

Zero configuration. On by default. Available in an expanding set of regions — see the [Top Insights documentation](https://docs.aws.amazon.com/waf/latest/developerguide/web-acl-insights.html) for the current region list.

This is the first stop for "what is happening right now?" triage. Use it before digging into sampled requests or CloudWatch queries.

### Top Insights workflow

When an alarm fires or a user reports an issue:

1. Open Top Insights for the web ACL.
2. Identify the top triggering rule. If it's a managed rule group, drill into the top sub-rule.
3. Identify the top attacked URI. If it's an unexpected path, cross-reference with sampled requests to understand why.
4. Identify the top attacker IP, ASN, or fingerprint. This guides whether to add a targeted rate rule, a geo/ASN block, or a specific JA4 fingerprint block.
5. From here, the fix path is either "tune the rule that's over-matching" (false-positive investigation) or "add a more targeted block rule for the actual attack pattern" (under-blocking on a new threat).

## Common issues

| Issue | Likely cause | Fix |
| --- | --- | --- |
| Legitimate user hits CAPTCHA loop | Token domain list missing or wrong; token too short-lived; mobile SDK not integrated; cookie blocked by third-party cookie rules | Verify token domain list covers all hostnames; confirm CAPTCHA/Challenge SDK integration; confirm `x-aws-waf-token` cookie is being set and sent |
| Managed rule group update introduces false positives | Auto-update added or broadened a sub-rule that matches legitimate traffic | Per-rule override to Count on the offending sub-rule; file AWS Support ticket if the sub-rule is overly broad for your traffic |
| Rate rule blocking legit traffic spike | Threshold too low; aggregation key too broad; no scope-down | Add scope-down to the rate rule; raise threshold; switch to a label-aggregated pattern; see [`rate-limiting.md`](./rate-limiting.md) |
| Rules matching in wrong order | Rule priority numbers out of intended order | Reorder; priorities are unique integers — swap via update |
| WAF not inspecting any requests | Web ACL not associated with the resource; wrong scope (regional web ACL attached to a CloudFront-scope resource or vice versa) | Verify `list-resources-for-web-acl`; verify the web ACL's scope matches the resource type; recreate the association if needed |
| Bot Control Challenge failing for mobile app | Mobile SDK not integrated; native client doesn't execute the JS challenge | Integrate the WAF mobile SDK; confirm token domain list includes the mobile app's API hostname |
| ATP not detecting credential stuffing | Response inspection config missing or misconfigured | Configure response inspection — status code signal or body-string signal matching the application's actual login-failure response |
| ACFP not detecting signup abuse | Form field identifiers wrong; response inspection missing | Verify the JSON/form field paths in the ACFP config; verify response inspection matches the signup-failure response |
| CloudFront-scope web ACL changes not taking effect | CloudFront distribution cache for WAF association | Allow the CloudFront deployment to complete — WAF-association changes at CloudFront scope propagate through CloudFront edge locations |
| WAF block but user sees 502 not 403 | Origin failure masking; browser caching an old response | Check origin health; clear browser cache; verify the custom response/block page config |

## Verifying a web ACL association

### Regional scope

```
aws wafv2 list-resources-for-web-acl \
  --web-acl-arn arn:aws:wafv2:us-east-1:123456789012:regional/webacl/prod-regional/... \
  --resource-type APPLICATION_LOAD_BALANCER
```

Also supports `API_GATEWAY`, `APPSYNC`, `COGNITO_USER_POOL`, `APP_RUNNER_SERVICE`, `VERIFIED_ACCESS_INSTANCE`.

### CloudFront scope

Check the CloudFront distribution's `WebACLId` (use the WAFv2 ARN, not the classic WAF ID):

```
aws cloudfront get-distribution --id EXXXXXXXXXXXXX \
  --query 'Distribution.DistributionConfig.WebACLId'
```

### CDK association

```typescript
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';

// Regional association (e.g., ALB).
new wafv2.CfnWebACLAssociation(this, 'AlbWafAssoc', {
  resourceArn: alb.loadBalancerArn,
  webAclArn: regionalWebAcl.attrArn,
});

// CloudFront association is set on the distribution itself via `webAclId`.
```

If `list-resources-for-web-acl` returns an empty list for a resource that should be associated, the association is missing or the scope is wrong.

## Sampled request anatomy

A sampled request record contains:

- **Timestamp** — when WAF inspected the request.
- **Source IP** — viewer IP (CloudFront scope) or client-facing IP (regional scope; the forwarded IP if configured).
- **Country, ASN** — derived from the source IP.
- **HTTP method, URI, query string** — the request line.
- **Headers** — a subset; large values may be truncated.
- **Matched rule** — `RuleWithinRuleGroup` for managed groups, or the custom rule name.
- **Action** — `BLOCK`, `COUNT`, `CAPTCHA`, `CHALLENGE`, or `ALLOW` (if sampled from an allow outcome).
- **Labels** — every label emitted by rules that matched this request.
- **Request fingerprint hints** — JA3/JA4 fingerprint if the request terminated TLS at WAF.

Walk a single example: a user reports 403 on `/checkout`. Pull sampled requests, filter by URI = `/checkout` and action = BLOCK. The sample shows the matched rule is `AWSManagedRulesCommonRuleSet → SizeRestrictions_BODY`. Now you have the fix path: scope-down this sub-rule or per-rule override to Count while tuning.

## WAF CloudWatch metrics

Emitted per web ACL and per rule.

- `AllowedRequests`
- `BlockedRequests`
- `CountedRequests`
- `CaptchaRequests`
- `ChallengeRequests`
- `PassedRequests` — requests that didn't match any rule in an evaluated group (non-terminating).

### Alarm patterns

- **Sudden drop in `AllowedRequests` on a production web ACL.** Possible over-blocking. An unexpected fix-forward rule deployment often surfaces here.
- **Sudden spike in `BlockedRequests`.** Attack in progress, or a new rule is over-matching.
- **Sudden spike in `CountedRequests` on a specific Count-mode rule.** That rule is firing at higher volume than expected — either attack traffic is shifting toward its pattern, or the rule has a false-positive issue. Investigate via sampled requests before promoting to Block.
- **`ChallengeRequests` and `CaptchaRequests` baseline.** Useful to alarm on absolute low values too — if Challenge suddenly drops to zero on a path that normally has Challenge volume, the rule may have been inadvertently removed.

### Example alarm

```typescript
import * as cw from 'aws-cdk-lib/aws-cloudwatch';

const overBlockingAlarm = new cw.Alarm(this, 'WafOverBlocking', {
  metric: new cw.Metric({
    namespace: 'AWS/WAFV2',
    metricName: 'AllowedRequests',
    dimensionsMap: {
      WebACL: 'prod-edge-acl',
      Rule: 'ALL',
      Region: 'CloudFront',
    },
    statistic: 'Sum',
    period: cw.Duration.minutes(5),
  }),
  threshold: 1000, // placeholder; set well below your normal traffic floor
  evaluationPeriods: 3,
  comparisonOperator: cw.ComparisonOperator.LESS_THAN_THRESHOLD,
  treatMissingData: cw.TreatMissingData.BREACHING,
});
```

Set alarms on both directions — "too few Allows" (possible outage via over-blocking) and "too many Blocks" (attack or miscalibration). The asymmetric case where Allow and Block both drop at once usually means the web ACL was detached; verify the association first.

### Log Insights queries

For CloudWatch Logs destination, use Log Insights. A few queries worth saving:

```
fields @timestamp, action, terminatingRuleId, httpRequest.uri, httpRequest.clientIp
| filter action = "BLOCK"
| stats count() by terminatingRuleId
| sort count desc
| limit 20
```

Top blocking rules over the query window. First stop for "is this a new attack or an over-tuned rule?"

```
fields @timestamp, action, httpRequest.uri, httpRequest.clientIp
| filter action = "BLOCK" and httpRequest.uri like /\/api\/login/
| stats count() by httpRequest.clientIp
| sort count desc
| limit 20
```

Top IPs blocked on the login endpoint. Credential-stuffing attack investigation.

```
fields @timestamp, labels.name
| filter isPresent(labels.0.name)
| stats count() by labels.0.name
| sort count desc
```

Top labels emitted. Gives you visibility into which managed rule sub-rules and which custom labels are most active.

### Debugging Challenge and CAPTCHA flows

The Challenge and CAPTCHA actions rely on a token cookie named `aws-waf-token` (verify current name in the [CAPTCHA documentation](https://docs.aws.amazon.com/waf/latest/developerguide/waf-captcha-and-challenge.html)). Typical failure modes:

- **Token domain list missing a hostname.** The token is issued against a specific domain list. If a user is on `app.example.com` but the token was issued for `example.com` without `app.example.com` included, the subsequent request doesn't carry a valid token. Fix: add all hostnames to the token domain list.
- **Third-party cookie blocking.** Modern browsers restrict third-party cookies. If WAF is on a domain different from the first-party domain the user is on, the token cookie is third-party and may be blocked. Fix: terminate WAF on the same domain as the site.
- **Mobile app without SDK.** Mobile clients don't execute JavaScript. The Challenge action fails unless the mobile SDK is integrated. Fix: integrate the AWS WAF mobile SDK.
- **Token expired.** Tokens have a TTL. Long-running single-page apps may hold a request past the TTL and then fail. Fix: have the app refresh the token by making a silent request periodically.

Debug via browser developer tools: inspect the Network tab for the request WAF challenged, check for the `aws-waf-token` cookie in subsequent requests, and confirm the token's domain attribute matches the request hostname.

## Related

- [`web-acl-and-rules.md`](./web-acl-and-rules.md) — rule priority, scope-down composition, override mechanics.
- [`managed-rules.md`](./managed-rules.md) — managed rule group catalog and per-rule override patterns.
- [`bot-control-and-fraud.md`](./bot-control-and-fraud.md) — Bot Control, ATP, ACFP configuration and their typical false-positive modes.
- [`rate-limiting.md`](./rate-limiting.md) — tuning rate rules and diagnosing rate-rule false positives.
- [`ddos-resilience.md`](./ddos-resilience.md) — L7 AMR-specific monitoring and incident triage.
- [`pricing-and-plans.md`](./pricing-and-plans.md) — log cost optimization, sampled requests vs full logging.
- [`../aws-cloudfront/references/troubleshooting.md`](../aws-cloudfront/references/troubleshooting.md) — CloudFront-side troubleshooting for requests that don't reach WAF as expected.
