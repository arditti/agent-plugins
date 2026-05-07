# AWS WAF Pricing and Plans

WAF has two pricing contexts: **bundled in CloudFront flat-rate** (the recommended path for new projects) or **standalone PAYG** (the classic per-web-ACL + per-rule + per-request model). Which context you are in changes the entire shape of the WAF-cost decision.

In the flat-rate context, WAF is not a separate line item at tier. The decision collapses from "is WAF worth it?" to "which flat-rate tier do I need?" That is a capability question, not a budget question. In the PAYG context, the decision returns to classic cost modeling — request volume times per-request fee, plus WCU overage, plus per-rule monthly charges.

This reference does **not** quote numbers. WAF and CloudFront pricing change; the authoritative source is always [aws.amazon.com/waf/pricing](https://aws.amazon.com/waf/pricing/) and [aws.amazon.com/cloudfront/pricing](https://aws.amazon.com/cloudfront/pricing/). What this reference gives you is the cost model and the decision framework.

Default scope: **CloudFront**. Regional WAF is secondary. Shield Advanced, Firewall Manager, and L3/L4 DDoS are out of scope for this skill.

## Contents

- [WAF included in CloudFront flat-rate](#waf-included-in-cloudfront-flat-rate)
- [Standalone PAYG model](#standalone-payg-model)
- [WCU cost model](#wcu-cost-model)
- [Bot Control pricing](#bot-control-pricing)
- [ATP and ACFP pricing](#atp-and-acfp-pricing)
- [L7 AMR pricing](#l7-amr-pricing)
- [Log cost model](#log-cost-model)
- [Log cost optimization](#log-cost-optimization)
- [Cost optimization strategies](#cost-optimization-strategies)
- [Pricing decision framework](#pricing-decision-framework)
- [Region cost parity](#region-cost-parity)
- [Enterprise and high-volume pricing](#enterprise-and-high-volume-pricing)
- [Related](#related)

## WAF included in CloudFront flat-rate

CloudFront flat-rate tiers bundle WAF. At tier:

- No separate web-ACL monthly fee.
- No separate per-rule monthly fee.
- Per-request WAF inspection included up to tier limits.
- Managed rule group availability is tier-gated — Bot Control, ATP, ACFP, and L7 AMR bundle at the tiers that include advanced security.

The authoritative tier-by-tier breakdown is on the [CloudFront pricing page](https://aws.amazon.com/cloudfront/pricing/). Cross-link: [`../aws-cloudfront/references/pricing-and-plans.md`](../aws-cloudfront/references/pricing-and-plans.md).

### The decision shift

If you are on a CloudFront flat-rate tier with WAF bundled, there is no cost reason **not** to attach WAF. Attach it. The question moves to which managed rule groups and custom rules to configure, not whether to pay for WAF at all.

The practical outcome: new projects that adopt CloudFront flat-rate get WAF as a default building block rather than a deferred "we'll add WAF later when the budget allows" decision.

### What's actually bundled

At tier, you receive:

- One or more web ACLs appropriate to the tier's included usage.
- A reasonable allowance of rules and managed rule groups.
- An allowance of inspected requests proportional to the tier's request volume allotment.
- Access to specific managed rule groups, including paid ones like Bot Control, ATP, ACFP, and L7 AMR at the appropriate tier levels.

What's not bundled: usage above the tier's allowances. Above-tier request volume and above-tier WCU overage return to PAYG economics. Check your usage against tier limits monthly. A site that outgrows its tier without switching tiers silently starts paying PAYG overage on top of the flat rate.

## Standalone PAYG model

For projects not on CloudFront flat-rate — or for regional WAF (ALB, API Gateway, AppSync, Cognito, App Runner, Verified Access) that runs independently — WAF is priced as:

- **Web ACL monthly charge.** Per web ACL, prorated hourly.
- **Rule monthly charge.** Per rule in the web ACL, prorated hourly. Managed rule groups count as a small number of rule-slots toward this; see [managed rule group pricing](https://aws.amazon.com/waf/pricing/).
- **Per-request charge.** Counted in millions of requests inspected.
- **Managed rule group subscription fees.** Some managed groups are free with WAF; others (Bot Control, ATP, ACFP, L7 AMR) carry additional per-request and/or per-month fees.
- **WCU overage.** Every web ACL has a base WCU allowance. Above that allowance, requests that hit rules in the overage range incur additional per-request fees.

See the [AWS WAF pricing page](https://aws.amazon.com/waf/pricing/) for current values. Do not hard-code any of these numbers.

### Where PAYG bites

- **High request volume web ACLs.** Request fees dominate. A small number of very busy web ACLs can cost more than all other WAF components combined.
- **Rule sprawl.** A web ACL with many low-traffic custom rules pays per-rule monthly for each, even if those rules almost never match. Consolidate.
- **Unscoped paid managed rule groups.** Bot Control Targeted on every path means Bot Control Targeted fees on every inspected request. Scope down.
- **WCU overage that isn't visible.** If your web ACL has silently grown above the base WCU allowance, per-request fees apply to the overage. Monitor the `ConsumedCapacityUnits` metric.

### Monthly charges prorate

Web ACL and per-rule monthly charges prorate by hour. Adding a web ACL for a day-long load test does not cost a full month. This is convenient for testing; it also means a web ACL created in the last hours of a month and deleted early in the next month generates two partial-month charges that together may approach a full-month charge. Plan accordingly.

### Soft limits on web ACLs and rules

Refer to the [WAF service quotas page](https://docs.aws.amazon.com/waf/latest/developerguide/limits.html) for current default and adjustable limits on web ACLs per region, rules per web ACL, rule groups per web ACL, and WCU per web ACL. Many limits are adjustable via AWS Support. Do not attempt to work around these limits with architectural gymnastics before checking whether a limit increase is available.

## WCU cost model

Every rule statement carries a WCU cost. A web ACL has a base capacity allowance; rules beyond that allowance incur additional per-request fees proportional to the over-capacity WCU.

See the [WAF Web ACL Capacity Units documentation](https://docs.aws.amazon.com/waf/latest/developerguide/aws-waf-capacity-units.html) for the per-statement-type capacity costs and [WAF pricing](https://aws.amazon.com/waf/pricing/) for the overage fee structure.

### Low-WCU design patterns

Covered in detail in [`web-acl-and-rules.md`](./web-acl-and-rules.md). Summary:

- **Prefer cheaper statement types.** A byte match is cheaper than a regex match; a literal string list in a regex pattern set is cheaper than multiple independent regex statements.
- **Share text transforms.** Applying `LOWERCASE` on the same field across multiple statements adds per-statement cost; restructure to a single transform where possible.
- **Order rules by cost.** Place cheap, high-terminating rules (IP allow, geo block, ASN block) early so expensive rules run on fewer requests.
- **Use scope-down on expensive managed groups.** Bot Control Targeted on a 100M-req/month site without scope-down is wasteful. Scope to `/api/login`, `/api/signup`, and `/checkout` only.
- **Consolidate regex pattern sets.** Ten rules each matching one pattern cost more than one rule matching a ten-pattern regex pattern set.

### Monitoring WCU

CloudWatch emits `ConsumedCapacityUnits` per web ACL. Set an alarm at a percentage of your base allowance (say, 80%) to catch growth before it silently crosses into overage billing. A web ACL that trends upward in consumed WCU month over month is either gaining rules (review the change log) or a managed rule group has increased its WCU in an auto-update (review the group's release notes).

### Custom rules vs managed rule groups for cost

Managed rule groups generally provide more defense-per-WCU than hand-rolled custom rules for the same attack class. Do not rebuild SQL injection or XSS protection from scratch — `AWSManagedRulesCommonRuleSet` and `AWSManagedRulesSQLiRuleSet` do this at lower WCU, lower false-positive rate, and lower maintenance cost than you will achieve with custom regex. Reserve custom rules for application-specific logic: your URL patterns, your tenant identifiers, your business rules.

## Bot Control pricing

Bot Control (`AWSManagedRulesBotControlRuleSet`) has two inspection levels with different cost profiles.

### Common inspection level

- Per-request inspection fee.
- Managed rule group subscription (bundled in some CloudFront flat-rate tiers).
- Suitable for whole-site deployment.

### Targeted inspection level

- Higher per-request fee than Common (reflects the ML and behavioral analysis cost).
- Use sparingly. Scope-down to high-value endpoints only: login, signup, checkout, password reset, account-takeover-sensitive flows.

Refer to [Bot Control pricing](https://aws.amazon.com/waf/pricing/) for current values.

### Cost optimization

- Run Common at whole-site scope.
- Layer Targeted with a scope-down covering only the handful of sensitive endpoints.
- Never run Targeted at whole-site scope on a high-volume site. The request fees dominate the bill.

Cross-link: [`bot-control-and-fraud.md`](./bot-control-and-fraud.md).

## ATP and ACFP pricing

- **ATP** (`AWSManagedRulesATPRuleSet`) — account takeover prevention. Inspects login endpoints.
- **ACFP** (`AWSManagedRulesACFPRuleSet`) — account creation fraud prevention. Inspects signup endpoints.

Both carry additional per-request fees on inspected endpoints. Scope-down to the exact login or signup path. Do not apply ATP to whole-site or to paths that are not login flows — the rule only provides value on login endpoints and applying it elsewhere pays the inspection fee without the benefit.

```typescript
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';

const atpRule: wafv2.CfnWebACL.RuleProperty = {
  name: 'AWSManagedRulesATPRuleSet',
  priority: 30,
  statement: {
    managedRuleGroupStatement: {
      vendorName: 'AWS',
      name: 'AWSManagedRulesATPRuleSet',
      managedRuleGroupConfigs: [
        {
          awsManagedRulesAtpRuleSet: {
            loginPath: '/api/login',
            requestInspection: {
              payloadType: 'JSON',
              usernameField: { identifier: '/username' },
              passwordField: { identifier: '/password' },
            },
            responseInspection: {
              statusCode: {
                successCodes: [200],
                failureCodes: [401, 403],
              },
            },
          },
        },
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
  overrideAction: { none: {} },
  visibilityConfig: {
    cloudWatchMetricsEnabled: true,
    metricName: 'AWSManagedRulesATPRuleSet',
    sampledRequestsEnabled: true,
  },
};
```

The scope-down is load-bearing for cost. Without it, ATP inspects every request and you pay the inspection fee on every request regardless of whether the request is a login attempt.

## L7 AMR pricing

`AWSManagedRulesAntiDDoSRuleSet` is the Anti-DDoS managed rule group. Per the [WAF pricing page](https://aws.amazon.com/waf/pricing/), it may carry a per-request fee and/or subscription component. Bundled in CloudFront flat-rate tiers that include advanced DDoS coverage.

Cross-link: [`ddos-resilience.md`](./ddos-resilience.md) for L7 AMR behavior and [`../aws-cloudfront/references/pricing-and-plans.md`](../aws-cloudfront/references/pricing-and-plans.md) for which flat-rate tiers bundle it.

## Log cost model

WAF supports three logging destinations. The cost model differs by destination.

| Destination | Cost pattern | Use case |
| --- | --- | --- |
| CloudWatch Logs (vended, launched 2025-09) | Per-GB ingestion + retention | Default recommended. Log Insights queries. |
| Amazon S3 | Per-GB storage + Athena query cost | Long-term retention, compliance, ad hoc SQL. |
| Kinesis Data Firehose | Per-GB delivery + downstream storage | Real-time pipelines, SIEM integration. |

The **vended CloudWatch Logs destination** (launched 2025-09) is priced differently from — and generally cheaper than — routing through Kinesis Firehose to deliver to CloudWatch Logs. For most customers running CloudWatch-based observability, the vended destination is the right default.

Refer to the [CloudWatch Logs pricing page](https://aws.amazon.com/cloudwatch/pricing/), [S3 pricing](https://aws.amazon.com/s3/pricing/), and [Kinesis Data Firehose pricing](https://aws.amazon.com/kinesis/data-firehose/pricing/) for current values, and the [WAF logging destinations documentation](https://docs.aws.amazon.com/waf/latest/developerguide/logging.html) for destination-specific notes.

## Log cost optimization

Logs are often the largest single cost in a mature WAF deployment. Optimize:

- **Filter by action.** Log only `Block`, `Count`, `CAPTCHA`, and `Challenge`. Drop `Allow`. Allow actions are typically 99%+ of request volume on a healthy site and contribute almost no diagnostic value relative to their cost.
- **Filter by rule label.** Log only requests that hit specific rules of interest.
- **Redact PII.** Use the [data protection feature](https://docs.aws.amazon.com/waf/latest/developerguide/data-protection-general.html) (launched 2025-02) to hash or drop sensitive headers, query parameters, and cookies before logs emit. Essential for GDPR/PCI compliance.
- **Use sampled requests for day-to-day visibility.** Sampled requests are free. Enable full logging only during incident investigation or tuning campaigns.
- **Tier log retention.** Short retention for CloudWatch Logs (query-optimized); longer retention for S3 (archival).

### CDK example: logging filter that drops Allow

```typescript
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';

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

## Cost optimization strategies

In priority order of impact:

1. **Move to CloudFront flat-rate if eligible.** Collapses WAF and advanced managed rule group fees into the tier.
2. **Scope down expensive managed rule groups.** Bot Control Targeted, ATP, and ACFP should never run at whole-site scope on high-volume properties.
3. **Filter Allow out of logs.** Usually the single biggest cost line item in a mature deployment.
4. **Minimize WCU.** See [`web-acl-and-rules.md`](./web-acl-and-rules.md) — regex consolidation, cheaper statement types, shared transforms, scope-down.
5. **Use Count mode liberally for tuning.** Count-mode evaluation incurs the same request fee as Block, but does not affect user experience. Use it for as long as needed to tune. There is no cost saving from rushing to Block.
6. **Use sampled requests for spot-checking.** Free. Should be the first diagnostic, not full logging.
7. **Consolidate low-traffic web ACLs.** Per-web-ACL monthly fees apply even to web ACLs with trivial traffic. In PAYG, one regional web ACL shared across several low-traffic regional resources (ALBs, API Gateways) is cheaper than one per resource. Note: CloudFront scope requires one distribution per web ACL association; regional scope allows many resources per web ACL.
8. **Redact unnecessary log fields.** Data protection reduces both cost and compliance exposure.

## Pricing decision framework

Walk through these in order.

1. **Are you on CloudFront flat-rate?** If yes, attach WAF. No additional WAF cost analysis needed at tier. Question becomes which managed rule groups and custom rules.
2. **Are you on CloudFront PAYG?** Estimate expected monthly WAF cost: web ACL + rules + request volume + managed rule subscriptions + expected WCU overage. Compare against the break-even of moving to a flat-rate tier that bundles WAF. Often the flat-rate tier pays for itself once WAF is in the picture.
3. **Are you on regional WAF only, no CloudFront?** Reconsider the architecture. CloudFront + WAF in a flat-rate tier is often cheaper than regional-WAF PAYG at the same request volume, and adds caching, edge termination, and L7 AMR availability. Cross-link: the [aws-cloudfront skill](../../aws-cloudfront/SKILL.md).
4. **Do you have a high-volume property?** Model the request fees carefully. Paid managed rule groups (Bot Control, ATP, ACFP, L7 AMR) compound with request volume. Scope-down is mandatory.
5. **Do you have many low-traffic web ACLs?** Consolidate where the scope and resource type allow.

## Region cost parity

WAF pricing is generally consistent across commercial AWS regions. CloudFront is a global service, so CloudFront-scope WAF has a single pricing entry. Regional WAF pricing may vary slightly by region — see [aws.amazon.com/waf/pricing](https://aws.amazon.com/waf/pricing/) for the current per-region breakdown. For GovCloud and China regions, check region-specific pricing pages.

## Enterprise and high-volume pricing

For very high request-volume web ACLs, custom pricing terms may apply. Engage AWS sales — the PAYG request fee on billions of requests per month may be subject to negotiated commitments that materially change the total cost. This is out of scope for this skill's configuration guidance; route to your AWS account team.

### Cost-allocation tagging

Tag web ACLs with cost-allocation tags so the WAF line items in Cost Explorer can be split by team, product, or environment. Without tags, WAF costs appear as a single service-level line and debugging which workload is driving spend becomes archaeology. Common tag dimensions:

- `Environment` (prod, staging, dev)
- `Service` (the application name)
- `Team` (ownership)
- `CostCenter` (finance)

Apply tags consistently at web ACL creation via CDK. Retroactive tagging works but requires going through every existing web ACL.

```typescript
import * as cdk from 'aws-cdk-lib';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';

const acl = new wafv2.CfnWebACL(this, 'EdgeAcl', {
  scope: 'CLOUDFRONT',
  defaultAction: { allow: {} },
  visibilityConfig: {
    cloudWatchMetricsEnabled: true,
    metricName: 'EdgeAcl',
    sampledRequestsEnabled: true,
  },
  rules: [/* … */],
  tags: [
    { key: 'Environment', value: 'prod' },
    { key: 'Service', value: 'customer-portal' },
    { key: 'Team', value: 'edge-platform' },
  ],
});
```

### When to engage AWS sales

- Your monthly WAF spend is significant relative to total AWS spend.
- You are considering a multi-year commitment on CloudFront or security services.
- You operate in an industry with compliance requirements that affect log retention and data protection configuration.
- You anticipate a request volume tier (billions per month) where public PAYG pricing is a poor fit.

For customers with an AWS account team, pricing conversations belong there, not in engineering tuning sessions.

## Cost modeling worksheet

Before opening the pricing page, write down:

- **Current request volume per month** — from CloudFront or ALB logs.
- **Expected growth over the contract period** — don't buy a flat-rate tier for last year's volume.
- **Which managed rule groups you will use** — Common, Known Bad Inputs, IP Reputation for baseline; Bot Control / ATP / ACFP if the workload has login, signup, or bot-sensitive paths; L7 AMR for any internet-facing property.
- **Scope-down coverage** — what fraction of your traffic will hit expensive managed rule groups.
- **Log volume estimate** — what's your expected Block + Count + Challenge + CAPTCHA volume (not total request volume).

Plug these into the pricing page and compare PAYG monthly against flat-rate tier monthly. The right answer is usually obvious once you have the inputs; the work is gathering the inputs. Without them, the pricing discussion is guesswork.

## Migrating from PAYG to flat-rate

When the break-even math favors a flat-rate tier:

1. **Inventory current WAF configuration.** Web ACLs, rules, managed rule groups, associations. Export via CDK or capture via `aws wafv2 list-web-acls` and related commands.
2. **Confirm tier coverage.** The tier's bundled managed rule groups must include what your web ACLs currently use. If you rely on a managed group that's not bundled at the tier, pricing math changes.
3. **Migrate CloudFront distributions to flat-rate.** This is a CloudFront operation, not a WAF operation. The WAF association carries over.
4. **Monitor billing for the first full month.** Verify the expected cost shape appears.
5. **Revisit annually.** Tier decisions made at one traffic level may not fit at another. Growth across the tier boundary quietly returns you to PAYG-on-overage.

## Regional-only deployments reconsidered

A regional WAF attached to an ALB without CloudFront in front is a common legacy pattern. The modern default is CloudFront + regional origin + edge-scope WAF. Reasons to prefer the edge pattern:

- **Lower latency.** TLS terminates at the edge POP, closer to the user.
- **Better attack absorption.** CloudFront caching absorbs attack traffic; regional WAF has no such layer.
- **Flat-rate bundling.** Flat-rate tiers bundle WAF; standalone regional WAF is always PAYG.
- **L7 AMR compatibility.** L7 AMR works at CloudFront scope with full behavior; regional-only deployments miss the edge-scale detection baseline.

Exceptions where regional-only is right: private VPC-only services, internal-only ALBs without internet exposure, compliance workflows that require traffic to remain in a specific region. For all external, user-facing workloads, move to CloudFront + WAF.

## Multi-tenant cost attribution

For platform teams running WAF on behalf of product teams, establish a chargeback model up front. Two patterns:

### Shared web ACL, per-tenant labels

One web ACL fronts many tenants. Rules emit tenant-identifying labels. Log-based attribution assigns request cost to tenants by label frequency. Pro: low operational overhead. Con: shared WCU budget across tenants; one tenant's noisy rule affects all.

### Per-tenant web ACL

Each tenant has its own web ACL. Cost-allocation tags track spend per tenant directly. Pro: clean attribution, isolated WCU budgets. Con: per-web-ACL monthly charges multiply; only viable if tenants are large enough to justify the monthly.

The right choice is usually determined by the variance in tenant request volume. Many small tenants → shared web ACL. A few large tenants → per-tenant web ACLs. A mix → shared web ACL for small tenants, dedicated web ACLs for the largest.

## Reserved capacity and commitments

Refer to AWS Savings Plans and any current WAF-specific commitment discounts on the [pricing page](https://aws.amazon.com/waf/pricing/). At time of writing this reference, the primary cost commitment path is via CloudFront Savings Bundles, which cover WAF bundled at the flat-rate tier. For standalone WAF PAYG, commitment discount availability changes; check current offerings before a major planning cycle.

## Budgets and alerts

Create an AWS Budget for WAF spend per account, with alerts at configurable thresholds of the expected monthly. Catch silent cost growth — new managed rule groups, new web ACLs, above-tier overage — before the bill arrives.

```typescript
import * as budgets from 'aws-cdk-lib/aws-budgets';

new budgets.CfnBudget(this, 'WafBudget', {
  budget: {
    budgetName: 'waf-monthly',
    budgetType: 'COST',
    timeUnit: 'MONTHLY',
    budgetLimit: { amount: 5000, unit: 'USD' }, // placeholder; tune to your baseline
    costFilters: {
      Service: ['AWS WAF'],
    },
  },
  notificationsWithSubscribers: [
    {
      notification: {
        notificationType: 'ACTUAL',
        comparisonOperator: 'GREATER_THAN',
        threshold: 80,
        thresholdType: 'PERCENTAGE',
      },
      subscribers: [{ subscriptionType: 'EMAIL', address: 'edge-platform@example.com' }],
    },
  ],
});
```

## Do-not list for WAF cost

- Do not enable Bot Control Targeted at whole-site scope on high-volume properties.
- Do not skip the scope-down on ATP and ACFP.
- Do not log every Allow action to your expensive destination.
- Do not keep Kinesis Firehose as the default log destination after the vended CloudWatch Logs destination launched unless you have a SIEM-integration reason.
- Do not pay per-rule monthly for dead rules — delete rules you no longer need.
- Do not run dev and staging web ACLs at production tier scale. Separate, smaller web ACLs for lower environments.

## Related

- [`web-acl-and-rules.md`](./web-acl-and-rules.md) — WCU optimization and rule ordering for cost.
- [`bot-control-and-fraud.md`](./bot-control-and-fraud.md) — Bot Control, ATP, ACFP scope-down patterns.
- [`ddos-resilience.md`](./ddos-resilience.md) — L7 AMR pricing and L7AM migration.
- [`managed-rules.md`](./managed-rules.md) — full managed rule group catalog with pricing notes.
- [`troubleshooting.md`](./troubleshooting.md) — log filtering, sampled requests, log destination selection.
- [`../aws-cloudfront/references/pricing-and-plans.md`](../aws-cloudfront/references/pricing-and-plans.md) — CloudFront flat-rate tiers that bundle WAF.
