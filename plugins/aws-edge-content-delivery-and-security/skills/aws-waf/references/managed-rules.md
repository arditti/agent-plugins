# Managed Rule Groups

Managed rule groups are the default security baseline. Start from them. They are maintained by AWS (or by Marketplace vendors), updated continuously as new CVEs and attack patterns emerge, and tuned by teams that see traffic across a huge surface. Custom rules patch gaps that are unique to your application — they do not replace managed groups. Every web ACL should reference at least the AWS-managed baseline groups described here before a single custom rule is written.

## Contents

- [Recommended baseline](#recommended-baseline)
- [App-type to rule group mapping](#app-type-to-rule-group-mapping)
- [Bot Control managed rule groups](#bot-control-managed-rule-groups)
- [ATP and ACFP managed rule groups](#atp-and-acfp-managed-rule-groups)
- [Anti-DDoS managed rule group](#anti-ddos-managed-rule-group)
- [Version management](#version-management)
- [Override actions](#override-actions)
- [Scope-down statements](#scope-down-statements)
- [Tuning workflow](#tuning-workflow)
- [Excluded rules vs per-rule override](#excluded-rules-vs-per-rule-override)
- [Managed rule group pricing](#managed-rule-group-pricing)
- [Vendor-managed rule groups](#vendor-managed-rule-groups)
- [Layering custom rules on top of managed groups](#layering-custom-rules-on-top-of-managed-groups)
- [Observability hooks for managed groups](#observability-hooks-for-managed-groups)
- [Deployment patterns for multi-environment setups](#deployment-patterns-for-multi-environment-setups)
- [When to deviate from the managed baseline](#when-to-deviate-from-the-managed-baseline)
- [Common failure modes](#common-failure-modes)
- [Related](#related)

## Recommended baseline

Deploy these in this priority order. Priority numbers are suggestions — what matters is the ordering and leaving gaps between them.

| Priority | Rule group | Protects against |
|----------|------------|------------------|
| 10 | `AWSManagedRulesAmazonIpReputationList` | Known-bad source IPs — botnets, scanners, reputation-flagged addresses. Cheapest early drop. |
| 20 | `AWSManagedRulesAnonymousIpList` | TOR exit nodes, VPNs, and anonymizing proxies. Deploy in Count first — legitimate users on corporate VPNs will trigger. |
| 30 | `AWSManagedRulesKnownBadInputsRuleSet` | Generic exploit payload fragments (log4shell, path traversal, known exploit strings). |
| 40 | `AWSManagedRulesCommonRuleSet` | OWASP-flavored generic rules (Core Rule Set). Highest false-positive surface — Count first. |
| 50 | `AWSManagedRulesSQLiRuleSet` | SQL injection payloads. Add only if a SQL backend exists. |

The ordering reflects cost and breadth. IP reputation is a near-free early filter, so it goes first and kills obvious bad actors before any expensive inspection runs. Anonymous IP is cheap but has real false-positive potential. Known-bad inputs is narrow and targeted — low false-positive, high value. Core Rule Set is broad and needs tuning. SQLi goes last in the baseline because it is expensive and only matters for SQL-backed apps.

Do not deploy all of these on day one in Block mode. Every one of them goes in with `OverrideAction: COUNT` first, watches traffic, gets tuned, and then gets promoted. See [Tuning workflow](#tuning-workflow).

```typescript
import { CfnWebACL } from 'aws-cdk-lib/aws-wafv2';

const baseline: CfnWebACL.RuleProperty[] = [
  {
    name: 'AmazonIpReputationList',
    priority: 10,
    overrideAction: { count: {} },
    statement: {
      managedRuleGroupStatement: {
        vendorName: 'AWS',
        name: 'AWSManagedRulesAmazonIpReputationList',
      },
    },
    visibilityConfig: {
      cloudWatchMetricsEnabled: true,
      metricName: 'AmazonIpReputationList',
      sampledRequestsEnabled: true,
    },
  },
  {
    name: 'AnonymousIpList',
    priority: 20,
    overrideAction: { count: {} },
    statement: {
      managedRuleGroupStatement: {
        vendorName: 'AWS',
        name: 'AWSManagedRulesAnonymousIpList',
      },
    },
    visibilityConfig: {
      cloudWatchMetricsEnabled: true,
      metricName: 'AnonymousIpList',
      sampledRequestsEnabled: true,
    },
  },
  {
    name: 'KnownBadInputs',
    priority: 30,
    overrideAction: { count: {} },
    statement: {
      managedRuleGroupStatement: {
        vendorName: 'AWS',
        name: 'AWSManagedRulesKnownBadInputsRuleSet',
      },
    },
    visibilityConfig: {
      cloudWatchMetricsEnabled: true,
      metricName: 'KnownBadInputs',
      sampledRequestsEnabled: true,
    },
  },
  {
    name: 'CoreRuleSet',
    priority: 40,
    overrideAction: { count: {} },
    statement: {
      managedRuleGroupStatement: {
        vendorName: 'AWS',
        name: 'AWSManagedRulesCommonRuleSet',
      },
    },
    visibilityConfig: {
      cloudWatchMetricsEnabled: true,
      metricName: 'CoreRuleSet',
      sampledRequestsEnabled: true,
    },
  },
];
```

Deploy the baseline as a unit. Resist the urge to sprinkle in custom rules between baseline groups on day one — the goal is to see what the baseline alone does before adding complexity. Once the baseline is tuned and promoted to `OverrideAction: NONE`, layer in app-specific rule groups and custom rules.

## App-type to rule group mapping

Beyond the baseline, app-specific managed rule groups catch payloads targeted at specific technology stacks. Add the relevant ones; skip the irrelevant ones.

| App characteristic | Additional managed rule group |
|--------------------|-------------------------------|
| WordPress | `AWSManagedRulesWordPressRuleSet` |
| PHP backend | `AWSManagedRulesPHPRuleSet` |
| Linux OS commands (anything running on Linux and exposing CLI-style input) | `AWSManagedRulesLinuxRuleSet` |
| Windows OS commands | `AWSManagedRulesWindowsRuleSet` |
| POSIX / Unix command injection | `AWSManagedRulesUnixRuleSet` |
| Admin panels (any CMS admin, wp-admin, phpMyAdmin, etc.) | `AWSManagedRulesAdminProtectionRuleSet` |
| Public REST/GraphQL API | Baseline + `AWSManagedRulesCommonRuleSet` scoped to the API paths; Bot Control Targeted on sensitive endpoints |
| Drupal / Joomla / Magento | Not covered by a dedicated AWS-managed group — evaluate Marketplace rule groups or build custom rules; see [Vendor-managed rule groups](#vendor-managed-rule-groups) |

The full catalog of AWS-managed rule groups is published in the AWS WAF developer guide — link to that for the current list rather than enumerating every rule name here. Several app-specific groups share sub-rules with `AWSManagedRulesCommonRuleSet`; do not duplicate coverage unnecessarily.

Do not enable `AWSManagedRulesAdminProtectionRuleSet` on a public-facing web ACL that has no admin endpoints — it will block paths you never use, and adds WCU for nothing. Every managed rule group has a cost; only add what the app actually exposes.

## Bot Control managed rule groups

Bot Control ships as two managed rule groups with the same name but different inspection levels, plus ATP and ACFP for specific fraud use cases. See [bot-control-and-fraud.md](bot-control-and-fraud.md) for the complete breakdown.

- `AWSManagedRulesBotControlRuleSet` with `InspectionLevel: COMMON` — fingerprint and signature-based bot detection. Catalog of verified bots (search engines, AI crawlers, monitoring services). Good default.
- `AWSManagedRulesBotControlRuleSet` with `InspectionLevel: TARGETED` — behavioral analysis, ML signals, device fingerprinting. Scope down to high-value flows (login, checkout, price/inventory, gift-card redemption). Do not run Targeted across the entire site unless cost is justified.

Both are managed rule groups; both are referenced via `ManagedRuleGroupStatement` with `ManagedRuleGroupConfigs` supplying the inspection level configuration. See [bot-control-and-fraud.md](bot-control-and-fraud.md) for integration details including the JavaScript/Mobile SDKs, token domain lists, and AI Activity Dashboard.

## ATP and ACFP managed rule groups

- `AWSManagedRulesATPRuleSet` — Account Takeover Prevention. Protects login endpoints from credential stuffing, compromised-credential reuse, and volumetric login abuse. Requires configuration telling WAF which endpoint is the login, which fields carry username/password, and how success/failure is signaled in the response. Response inspection is mandatory for ATP to attribute attempts.
- `AWSManagedRulesACFPRuleSet` — Account Creation Fraud Prevention. Protects signup endpoints from bulk account creation, disposable email signups, and identity farming. Similar configuration shape to ATP.

Both are configured through `ManagedRuleGroupConfigs` — the request inspection config (URI and method) and response inspection config (status/header/body signal extraction) are passed at the rule level, not the rule group level. Full integration details in [bot-control-and-fraud.md](bot-control-and-fraud.md).

## Anti-DDoS managed rule group

AWS added an L7 anti-DDoS managed rule group (L7 AMR, 2025-06) that provides baseline volumetric L7 protection without the user having to hand-build rate rules. See [ddos-resilience.md](ddos-resilience.md) for positioning, scope, and how it composes with Shield Advanced and hand-built rate rules.

## Version management

Managed rule groups are versioned. AWS publishes new versions as signatures evolve — new CVEs added, false-positive-inducing rules revised, detection logic tuned.

**Auto-update (`DEFAULT` version).** Recommended default. Omit `Version` from the `ManagedRuleGroupStatement` or set it to `DEFAULT`. AWS moves your reference forward as versions release. This is the right choice for almost every web ACL — the alternative is staring at a CVE announcement and realizing you are three versions behind.

**Version pinning.** Set `Version` to a specific version string. Use when a version bump has caused a false positive in production and you need to freeze. Pinning is a tactical hold, not a strategy — always create a ticket to investigate the false positive, land a per-rule override or scope-down, and unpin. Pinned versions also eventually deprecate; AWS will not carry old versions forever.

**Subscribe to version change notifications.** AWS WAF publishes managed rule group version events to Amazon SNS (and via CloudWatch Events). Subscribe a team mailing list or Slack webhook. Link to the AWS WAF developer guide for the topic ARN pattern and subscription steps. If you run auto-update in production, these notifications are your early warning when something regresses.

When a new version ships, the right playbook is: deploy to staging first, watch for label rate changes and sampled request anomalies over at least a day, then promote. For critical web ACLs, stage managed rule group bumps with `OverrideAction: COUNT` on the updated group reference in production and switch to `NONE` after a soak.

## Override actions

Two levels of override: group-level and per-rule.

**Group-level `OverrideAction`.**

- `NONE` — rules apply as-defined. Block rules block, Allow rules allow, Count rules count.
- `COUNT` — every rule in the group is forced to Count, regardless of its defined action. The group becomes observation-only. Use for initial deployment, version bumps, and any time you need to see what the group would do without taking action.

**Per-rule overrides (`RuleActionOverrides`).** Override the action of one sub-rule inside a managed group while leaving the rest alone. Set the override action to `Count` to neutralize a specific rule that is causing false positives while retaining the rest of the group in Block.

```typescript
import { CfnWebACL } from 'aws-cdk-lib/aws-wafv2';

const coreRuleSet: CfnWebACL.RuleProperty = {
  name: 'CoreRuleSet',
  priority: 40,
  overrideAction: { none: {} },
  statement: {
    managedRuleGroupStatement: {
      vendorName: 'AWS',
      name: 'AWSManagedRulesCommonRuleSet',
      ruleActionOverrides: [
        { name: 'SizeRestrictions_BODY', actionToUse: { count: {} } },
        { name: 'CrossSiteScripting_BODY', actionToUse: { count: {} } },
      ],
    },
  },
  visibilityConfig: {
    cloudWatchMetricsEnabled: true,
    metricName: 'CoreRuleSet',
    sampledRequestsEnabled: true,
  },
};
```

Per-rule `Count` override is the correct tool for "one sub-rule is noisy; the rest of the group is fine." Do not reach for full exclusion — see [Excluded rules vs per-rule override](#excluded-rules-vs-per-rule-override).

## Scope-down statements

A `ScopeDownStatement` on a managed rule group reference filters which requests the rule group inspects. Requests that do not match the scope-down are not inspected by the group at all — both WCU and false-positive surface drop.

Apply `CoreRuleSet` only to dynamic paths and skip it on static assets:

```typescript
import { CfnWebACL } from 'aws-cdk-lib/aws-wafv2';

const coreRuleSetScoped: CfnWebACL.RuleProperty = {
  name: 'CoreRuleSetDynamicOnly',
  priority: 40,
  overrideAction: { none: {} },
  statement: {
    managedRuleGroupStatement: {
      vendorName: 'AWS',
      name: 'AWSManagedRulesCommonRuleSet',
      scopeDownStatement: {
        notStatement: {
          statement: {
            byteMatchStatement: {
              fieldToMatch: { uriPath: {} },
              positionalConstraint: 'STARTS_WITH',
              searchString: '/assets/',
              textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
            },
          },
        },
      },
    },
  },
  visibilityConfig: {
    cloudWatchMetricsEnabled: true,
    metricName: 'CoreRuleSetDynamicOnly',
    sampledRequestsEnabled: true,
  },
};
```

Apply `AWSManagedRulesSQLiRuleSet` only on API paths:

```typescript
import { CfnWebACL } from 'aws-cdk-lib/aws-wafv2';

const sqliScoped: CfnWebACL.RuleProperty = {
  name: 'SqliOnApi',
  priority: 50,
  overrideAction: { none: {} },
  statement: {
    managedRuleGroupStatement: {
      vendorName: 'AWS',
      name: 'AWSManagedRulesSQLiRuleSet',
      scopeDownStatement: {
        byteMatchStatement: {
          fieldToMatch: { uriPath: {} },
          positionalConstraint: 'STARTS_WITH',
          searchString: '/api/',
          textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
        },
      },
    },
  },
  visibilityConfig: {
    cloudWatchMetricsEnabled: true,
    metricName: 'SqliOnApi',
    sampledRequestsEnabled: true,
  },
};
```

Scope-down is also the right tool for Bot Control Targeted. Scope to `/login`, `/checkout`, `/api/price`, `/api/inventory` — run expensive inspection only where the risk is concentrated.

## Tuning workflow

Every managed rule group starts in observation-only mode. The workflow:

1. Add the managed rule group to the web ACL with `OverrideAction: COUNT`. Sampled requests on. Metrics on.
2. Let traffic run for at least one full traffic cycle — 24 to 72 hours depending on how weekly your traffic pattern is. E-commerce and B2B have very different weekly rhythms; err toward the long end.
3. Inspect sampled requests and label metrics. For each sub-rule that matched, classify the matches:
   - **True positive** — real bad traffic. Leave as-is.
   - **False positive** — legitimate traffic. Apply a per-rule `Count` override OR scope-down the rule group to exclude the legitimate path.
   - **Ambiguous** — leave in Count, add logging, revisit.
4. Remove the group-level `COUNT` override. Set `OverrideAction: NONE`. The group now blocks according to its defined actions, minus any per-rule overrides you applied.
5. Keep watching metrics. New false positives surface over time as the app changes.

Never skip step 2. The cost of a false positive that blocks real customers is higher than the cost of leaving the rule group in Count for another day.

## Excluded rules vs per-rule override

Two ways to neutralize a noisy sub-rule.

- **Per-rule `Count` override** (via `RuleActionOverrides`). The rule still runs. It still emits labels. It still appears in sampled requests. It just does not terminate.
- **Full exclusion** (historically `ExcludedRules`; the recommended current approach is per-rule override to Count). The rule is effectively off. No labels. No visibility.

Per-rule override to Count is almost always the right choice. You retain visibility. You retain the ability to promote the rule back to Block with one change when the underlying false positive is fixed. You keep telemetry that lets you notice when a false-positive becomes a true positive again (attack patterns shift).

Use full exclusion only when a sub-rule is permanently, fundamentally incompatible with the app — and even then, document why.

## Managed rule group pricing

Managed rule group pricing has two components: a base subscription fee per managed rule group per web ACL, and in some cases an additional per-request inspection fee. Bot Control, ATP, and ACFP carry per-request fees on top of the subscription. Pricing changes; do not memorize numbers.

- Link to the AWS WAF pricing page for current fees.
- Link to [pricing-and-plans.md](pricing-and-plans.md) for the flat-rate tier interactions with CloudFront — several managed rule group tiers are gated or discounted based on the CloudFront tier.

Two cost rules:

- Subscribe only to managed rule groups you actually use. Every subscription carries a base fee.
- Use scope-down to reduce the volume of requests inspected by per-request-fee rule groups (Bot Control Targeted, ATP, ACFP). Scoping down to the login endpoint instead of the whole site can reduce inspection fees materially.

## Vendor-managed rule groups

Marketplace vendors publish their own managed rule groups. Use sparingly.

- Vendor rule groups carry a separate subscription fee — often higher than AWS-managed equivalents.
- Vendor rule groups are just as opaque as AWS-managed. You cannot inspect the rules.
- Vendor release cadence and support quality vary. Evaluate reputation — who publishes it, how long they have operated, what their update cadence looks like, what their support channels are.
- Evaluate against a staging web ACL with `OverrideAction: COUNT` for a full traffic cycle before introducing to production. Treat onboarding a vendor rule group the same as onboarding any AWS-managed rule group — the same tuning workflow applies.

Do not stack vendor rule groups redundantly with AWS-managed ones. If both claim to catch the same class of attack, pick one, and lean on labels and sampled requests to validate coverage.

Evaluation checklist for any vendor rule group candidate:

- What specific gap does it cover that AWS-managed groups do not?
- What is the per-web-ACL subscription fee and per-request fee?
- What is the update cadence and who tunes it?
- What is the label namespace? (Vendor rule groups emit labels under the vendor's namespace; you will compose rules on them.)
- Is support responsive? Test by opening a dummy support ticket before committing in production.
- What happens if the vendor deprecates the rule group? Plan an exit.

## Layering custom rules on top of managed groups

Managed rule groups handle the broad-strokes generic threats. Custom rules handle the app-specific gaps. The two should compose via labels rather than replace each other.

Typical composition patterns:

- Managed group emits a label (e.g., Bot Control flags a fingerprint), a custom rule matches on the label AND an app-specific condition (URI, header, cookie) and takes a more aggressive terminating action than the managed group does.
- Custom rule labels a known-good traffic class (authenticated tenants, internal services), a later rule allows traffic carrying that label before managed groups run. Requires careful priority ordering — Allow short-circuits all downstream rules including managed groups, which can hide regressions.
- Custom rule rate-limits traffic within a managed group's label scope (see [rate-limiting.md](rate-limiting.md) for rate-based rules that use label match as a scope-down).

Avoid writing custom rules that duplicate a managed group's inspection. If you find yourself writing "is this SQLi?" in a custom rule, you are re-implementing `AWSManagedRulesSQLiRuleSet` — use the managed group instead.

## Observability hooks for managed groups

Every managed rule group reference should have:

- `VisibilityConfig.CloudWatchMetricsEnabled: true` — emits per-rule and per-group metrics to CloudWatch under the `AWS/WAFV2` namespace.
- `VisibilityConfig.SampledRequestsEnabled: true` — enables sampled request retrieval through the WAF console and the `GetSampledRequests` API.
- A distinct, meaningful `MetricName` for dashboards and alarms.

Alarm patterns worth pinning:

- Sudden rise in `BlockedRequests` for any managed group — could indicate an attack, or a new version that introduced a false-positive rule.
- Sudden drop in `CountedRequests` for a group that is in Count mode — could indicate the rule group is no longer evaluating (misconfiguration, scope-down change).
- Sustained high volume on a specific sub-rule label — review for false-positives.

Wire these alarms to the same pager that handles application incidents. Security rules that misbehave silently are worse than rules that fail loudly.

## Deployment patterns for multi-environment setups

Managed rule group behavior can differ across environments. A staging environment has lower traffic, fewer real users, and a higher proportion of test traffic — a rule that is silent in staging can light up in production. Conversely, production false-positives are the ones that hurt.

Recommended pattern:

- Separate web ACLs per environment, provisioned by the same CDK stack with environment-specific parameters.
- Same managed rule group references, same priority ordering, same overrides.
- Staging web ACL gets the `DEFAULT` managed rule group version first; production gets either `DEFAULT` (if you trust AWS's update cadence) or a pinned version promoted from staging after a soak window.
- Log both environments' sampled requests to a shared observability backend (Athena table over S3, CloudWatch Logs Insights). Diff staging against production on label rates.

For organizations with many properties behind one WAF team, promote a shared custom rule group (or a shared set of managed rule group references in a reusable CDK construct) rather than duplicating rule definitions across stacks. One place to tune, many web ACLs consuming the change.

## When to deviate from the managed baseline

A small number of cases justify departing from the standard managed baseline ordering.

- **Internal-only endpoints fronted by corporate VPN / SSO.** Default `Allow` action on the web ACL is the wrong posture. Flip to default `Block`, add explicit Allow rules for traffic carrying a valid SSO cookie or originating from corporate CIDR. Managed rule groups still run but as a second layer behind identity-based access.
- **Static-only content distributions.** Core Rule Set and SQLi add cost for no benefit on a distribution that serves only static assets. Drop them; keep IP reputation and Known-Bad Inputs. Bot Control Common remains valuable for bandwidth-consuming scraper mitigation.
- **WebSocket-heavy apps.** Body inspection and certain managed rule groups are not a good fit for long-lived WebSocket upgrades. Scope managed groups to the HTTP API paths and exclude the WebSocket upgrade paths.
- **Regulated workloads with narrow allowlist posture.** Compliance sometimes requires explicit allowlisting of every permitted path and method. Use the managed baseline as a defense-in-depth layer behind the allowlist rules rather than as the primary gate.

Document every deviation in the CDK stack with a comment linking to the rationale ticket. "Why is `AWSManagedRulesCommonRuleSet` missing from this web ACL?" is a question that will come up in audit — write the answer once.

## Common failure modes

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Legitimate API calls suddenly 403ing after a deployment | Managed rule group bumped version and introduced a new false-positive sub-rule | Pin the prior version; identify the offending sub-rule from labels; add per-rule `Count` override; unpin |
| Web ACL deployment fails with capacity error | Sum of inline rule WCU + custom rule group refs exceeds budget | Run `CheckCapacity`, identify highest-cost statement, consolidate into a pattern set or scope down |
| Managed rule group showing zero matches in CloudWatch | Scope-down excludes all traffic, or rule group reference is misconfigured | Remove scope-down temporarily to confirm rule group runs; review scope-down logic |
| Rule group in `COUNT` override but dashboard shows `BlockedRequests` for its rules | Per-rule overrides are applied, not group override; check rule-level action overrides | Confirm `OverrideAction` vs `RuleActionOverrides` semantics — group-level `COUNT` forces all sub-rules to Count regardless of per-rule overrides |
| Managed rule group version notification never arrives | SNS subscription not created, or CloudWatch Events rule misconfigured | Link to AWS WAF developer guide for the notification setup steps; verify subscription filter |
| Cost spike after enabling Bot Control | Running across whole site without scope-down | Add `scopeDownStatement` to concentrate on sensitive endpoints; reconsider tier |

Refer to [troubleshooting.md](troubleshooting.md) for broader debugging workflows including sampled-request triage and label-based false-positive analysis.

## Related

- [web-acl-and-rules.md](web-acl-and-rules.md) — web ACL anatomy, rule priority, override action mechanics
- [custom-rules-and-regex.md](custom-rules-and-regex.md) — custom rules to patch gaps managed rules do not cover
- [bot-control-and-fraud.md](bot-control-and-fraud.md) — Bot Control, ATP, ACFP configuration and integration
- [ddos-resilience.md](ddos-resilience.md) — L7 anti-DDoS managed rule group positioning
- [rate-limiting.md](rate-limiting.md) — rate-based rules as a complement to managed groups
- [pricing-and-plans.md](pricing-and-plans.md) — managed rule group cost model and tier interactions
- [troubleshooting.md](troubleshooting.md) — sampled requests, label inspection, false positive triage
- [../aws-cloudfront/SKILL.md](../aws-cloudfront/SKILL.md) — fronting with CloudFront before layering WAF
- [../aws-cloudfront/references/pricing-and-plans.md](../aws-cloudfront/references/pricing-and-plans.md) — flat-rate tier features that gate managed rule group behaviors
