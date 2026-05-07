# CloudFront Pricing and Plans

CloudFront has two pricing models: traditional pay-as-you-go (per-request + per-GB egress, with separate line items for WAF, Route 53, logs, and edge compute) and **flat-rate plans** (launched 2025-11, tier expansion 2026-03). Flat-rate is the default recommendation for any workload where finance wants a predictable bill. It bundles CDN, WAF, basic L7 DDoS, DNS, logs, edge compute, and edge storage under a single monthly tier price, tolerates traffic spikes without penalty, and never charges for blocked attack traffic. Pick flat-rate unless you have a specific reason to stay on PAYG.

## Contents

- [The two pricing models](#the-two-pricing-models)
- [Flat-rate pricing model](#flat-rate-pricing-model)
- [Tier capabilities](#tier-capabilities)
- [Spike tolerance and overage handling](#spike-tolerance-and-overage-handling)
- [PAYG vs flat-rate decision framework](#payg-vs-flat-rate-decision-framework)
- [What's bundled across skills](#whats-bundled-across-skills)
- [Blocked and attack traffic](#blocked-and-attack-traffic)
- [Reserved capacity and commitments](#reserved-capacity-and-commitments)
- [Custom pricing and RFQ](#custom-pricing-and-rfq)
- [Log cost reductions](#log-cost-reductions)
- [Migrating from PAYG to flat-rate](#migrating-from-payg-to-flat-rate)
- [Related](#related)

## The two pricing models

| | Pay-as-you-go (PAYG) | Flat-rate plans |
|---|---|---|
| Bill predictability | Variable per month | Fixed tier price |
| Data transfer | Per-GB egress by region | Bundled within tier allowance |
| HTTP requests | Per-10,000 requests by region | Bundled |
| WAF | Separately billed (per rule, per request) | Bundled including managed rule groups |
| Route 53 | Separately billed (per hosted zone, per query) | Bundled up to tier query allowance |
| Logs | Separately billed (S3 storage + request count) | Bundled |
| Edge compute (CFF, L@E) | Per-invocation | Bundled up to tier allowance |
| Edge storage (KV Store) | Per-GB + per-request | Bundled |
| Spike tolerance | Every spike bills at marginal rate | Spikes absorbed up to plan threshold; graceful degrade if sustained |
| Attack traffic | Billed as normal egress | Never billed |

Link to the [CloudFront pricing page](https://aws.amazon.com/cloudfront/pricing/) for the current tier prices and allowances. Do not hardcode any of the numbers — they change, and the page is authoritative.

## Flat-rate pricing model

Flat-rate is a fixed monthly subscription that bundles the commonly-paired edge services. The value is not just the unit cost — it's the predictability, the bundled services that you would otherwise budget separately, and the spike tolerance.

### What's bundled

- **CloudFront CDN.** All POPs. No price-class restriction. Data transfer allowance by tier.
- **AWS WAF.** WebACL, rules, and managed rule groups (including AWS Managed Rules). Bot Control tier availability is tier-gated — see `../aws-waf/references/pricing-and-plans.md`.
- **Basic L7 DDoS.** The L7 Automatic Mitigation Response (AMR) layer is included. See `../aws-waf/references/ddos-resilience.md` for the mitigation flow. Shield Advanced remains a separate subscription for network-layer and dedicated response team coverage.
- **Route 53.** DNS hosted zones and queries bundled up to a tier allowance.
- **CloudFront Functions and CloudFront KV Store.** Invocations and storage bundled.
- **Lambda@Edge.** Tier-dependent allowance. Beyond the allowance, L@E bills at marginal PAYG rates.
- **Standard logs.** S3 delivery of Parquet-formatted hourly logs, bundled.
- **Real-time logs.** Generally NOT bundled — they go through Kinesis Data Streams, which carries its own pricing. Verify on the current pricing page.

### Why flat-rate is the default

- **Predictable bill.** Finance teams can forecast CDN spend as a line item, not a variable.
- **No per-service budget fragmentation.** WAF, DNS, logs, and edge compute are one invoice, not four.
- **Spike tolerance.** Traffic bursts (product launches, news cycles, being featured on a major site) do not produce a surprise bill.
- **Attack-traffic immunity.** DDoS and bot traffic that WAF blocks or CloudFront absorbs does not charge against your allowance.
- **Simpler architecture decisions.** You stop optimizing every CDN decision against per-GB cost. You ship features instead.

## Tier capabilities

Flat-rate is structured as tiers. Names and exact features change — link to the pricing page for the authoritative current list. The capability model is:

| Tier | Capability focus |
|---|---|
| **Free** | Basic CDN. Minimal WAF visibility. Suitable for development and low-traffic personal sites. |
| **Pro** | Core CDN + WAF visibility. Bot Control Common visibility. AI Activity Dashboard visibility (which AI vendors are crawling you). Suitable for small production workloads. |
| **Business** | Enforcement unlocked. Bot Control Challenge/CAPTCHA/Block actions. Viewer mTLS. Anycast static IPs (for viewers requiring fixed-IP allowlists). Targeted Bot Control features gated here or on Premium. Suitable for commercial production workloads. |
| **Premium** | Highest allowances. Advanced security and DDoS features. Suitable for high-traffic sites and enterprises. |

**Tier gating to know.**

- **Bot Control visibility** (which AI/bot vendor is requesting) typically unlocks at Pro.
- **Bot Control enforcement** (Challenge, CAPTCHA, Block based on bot labels) unlocks at Business.
- **Bot Control Targeted** (advanced signals, browser fingerprinting depth) is gated higher — check the current page.
- **Viewer mTLS** is gated at Business or higher.
- **Anycast static IPs** for viewer-to-CloudFront fixed addressing are gated.

When a reader asks "what do I get at tier X" — link to the [pricing page](https://aws.amazon.com/cloudfront/pricing/) rather than quoting the current table. The tier contents get updated.

## Spike tolerance and overage handling

The flat-rate model does not behave like traditional metered services. Traffic above the plan's designed threshold is handled in three phases:

1. **Absorption.** Traffic above the nominal allowance is served. No charge. The plan has headroom built in.
2. **Graceful degradation.** If traffic stays sustained above the plan's spike tolerance, CloudFront may shed load through cache-heavier behavior (serving stale longer) or other soft-degrade mechanics. Viewers continue to be served. Attackers are not rewarded with origin-destruction.
3. **Upgrade prompt.** If your traffic profile has durably shifted to a higher plane, you are prompted to upgrade tiers — but this is not retroactive overage billing.

The key property: **you do not get a surprise bill for a traffic spike.** A product launch day that quadruples your traffic does not quadruple your bill. This is the single biggest practical difference from PAYG.

## PAYG vs flat-rate decision framework

### PAYG wins when

- **Very low traffic.** Your monthly CDN bill on PAYG is below the cost of the lowest flat-rate tier. Hobby sites and pre-launch products.
- **Extreme regularity.** Your traffic is flat, low, and you want to pay only for the bytes you serve with no tier ceiling concerns.
- **Per-service chargeback.** Your finance org requires per-service line-item chargeback across business units. Flat-rate bundles — you lose the granularity.
- **Short-lived campaigns.** A one-off campaign where per-unit billing is easier to reconcile against campaign ROI.

### Flat-rate wins when

- **Predictability is a feature.** Finance, procurement, or leadership wants monthly cost forecasting.
- **You already spend on WAF, DNS, and logs separately.** The bundled tier is usually less than the sum of separate PAYG line items once traffic is non-trivial.
- **Traffic is spiky.** Product launches, seasonal peaks, news-cycle exposure. PAYG punishes these; flat-rate absorbs them.
- **You want bundled security.** WAF enforcement, Bot Control, and L7 DDoS without separately budgeting each.
- **You are on Shield Advanced or planning to add it.** Flat-rate Business/Premium tiers complement Shield cleanly.

### Break-even method

Do not quote a break-even number — tier prices change. Instead:

1. **Export PAYG cost data** from AWS Cost Explorer for the last 3 months. Filter by CloudFront, WAF, Route 53, and CloudFront-related S3 logs.
2. **Sum the monthly total** across those services. Include Lambda@Edge and CloudFront Functions if used.
3. **Match against tier pricing** on the current [pricing page](https://aws.amazon.com/cloudfront/pricing/). Pick the tier whose allowances cover your 95th-percentile month.
4. **Use the AWS pricing calculator** to sanity-check — do not estimate from memory.

The decision is usually obvious once you sum the line items. Many teams discover they are overpaying on PAYG because they never added up WAF + logs + DNS together.

## What's bundled across skills

Flat-rate plans bundle capabilities that live in other skills in this plugin:

- **CloudFront CDN** — everything in this skill, up to tier allowance.
- **AWS WAF** — WebACL, rules, and managed rule groups. See `../aws-waf/references/pricing-and-plans.md` for WAF-specific tier detail.
- **Bot Control** — visibility at Pro+, enforcement at Business+. See `../aws-waf/references/bot-control-and-fraud.md` for capabilities.
- **L7 DDoS via AMR** — Automatic Mitigation Response, basic coverage. See `../aws-waf/references/ddos-resilience.md`.
- **Route 53** — DNS hosted zones and queries up to tier allowance.
- **CloudFront Functions** and **KV Store** — invocations and storage up to allowance.
- **Standard logs** — Parquet hourly logs to S3.

What is NOT bundled:

- **Shield Advanced** — separate subscription, separate value proposition (dedicated response team, network-layer coverage).
- **Route 53 Resolver DNS Firewall** — separate.
- **Real-time logs via Kinesis** — Kinesis itself bills separately. Verify on the pricing page.
- **S3 origin storage** — origin bytes on S3 bill as normal S3.
- **Origin compute** — Lambda, ECS, EC2, ALB on origin side bill as normal.

## Blocked and attack traffic

**Blocked traffic and absorbed DDoS traffic never count against your allowance and are never separately billed.**

This is not a quirk — it's an intentional design property. Charging a customer for the bytes an attacker sent would punish the victim of the attack. The rationale:

- WAF rules that block a request: the block happens at the edge before the request reaches origin. No origin egress. Not counted.
- L7 DDoS traffic absorbed by AMR or CloudFront's DDoS infrastructure: same — attackers do not generate billable egress for the customer.
- Requests that WAF rate-limits with `BLOCK`: not counted.

Link to `../aws-waf/references/ddos-resilience.md` for the DDoS mitigation flow and `../aws-waf/references/rate-limiting.md` for rate-limit rule behavior.

## Reserved capacity and commitments

CloudFront has had private-pricing agreements for large enterprise customers historically. The flat-rate model largely subsumes this for mid-market and mainstream enterprise. For very high volumes, contact AWS sales for custom pricing — see the next section.

Savings Plans: CloudFront is not part of the general Compute Savings Plans program. Commitment-based discounts come via custom agreements, not Savings Plans instances. Check the [AWS Savings Plans documentation](https://aws.amazon.com/savingsplans/) for current coverage.

## Custom pricing and RFQ

For very large volumes (hundreds of PB per month, or custom feature requirements), contact AWS sales. The flat-rate Premium tier is customizable for enterprise contracts — allowances can be raised, dedicated TAM engagement can be added, and pricing terms can be negotiated.

Indicators you are past the standard tier:

- Monthly CDN spend routinely in the high six figures or more.
- Traffic patterns include recurring multi-Tbps spikes.
- You need contractual SLA commitments beyond the standard CloudFront SLA.
- You have a cross-region origin architecture with custom routing requirements.

## Log cost reductions

Logging is an easy over-spend. The pattern:

| Log tier | Cost characteristic | When to use |
|---|---|---|
| Standard logs (Parquet v2, hourly) | Cheap per-request | Default. Analytics, reporting, compliance, forensics. |
| Standard logs (legacy text format) | Cheap per-request, larger storage | Only if you have legacy tooling. Migrate to Parquet v2. |
| Real-time logs (Kinesis Data Streams) | Expensive per-record | Active debugging, fraud pipelines, SIEM near-real-time ingestion. |

Real-time logs cost materially more than standard logs for the same request volume because of Kinesis pricing. Enable them only when you actually need sub-minute latency. For Athena analytics, standard logs are the answer — partition-pruned Parquet queries are fast and cheap.

See `performance-tuning.md` for the logging decision in the context of observability.

## Migrating from PAYG to flat-rate

Runbook:

1. **Baseline.** Export the last 3 months of Cost Explorer data filtered by CloudFront, WAF, Route 53, and CloudFront-logging S3 line items. Sum by month.
2. **Identify your 95th-percentile month.** Not the average — the month you would have been unhappy if a surprise bill arrived.
3. **Map to tier.** On the current pricing page, find the tier whose allowances cover that 95th-percentile month with headroom. If you are between tiers, pick the higher one — tier-change mid-cycle is possible but simpler to start above.
4. **Switch.** Via the CloudFront console or the Pricing API. No downtime. The switch is a billing-model change, not a resource change — distributions, WebACLs, and Route 53 zones are not modified.
5. **Monitor for the first month.** Watch Cost Explorer under the new plan. Verify allowances are not tight. Adjust tier if needed.
6. **Decommission PAYG-specific monitoring.** You can stop tracking per-GB egress and per-request line items as cost drivers.

The switch is reversible. If flat-rate turns out wrong for your workload, switch back to PAYG — again, no resource change.

## Cost anti-patterns to avoid

### Over-forwarding in the cache key

Every header, cookie, and query string dimension added to the cache key multiplies cache variants. Cache misses increase. Bytes out of origin increase. Bill goes up. Audit the cache policy: what does each dimension actually do for the response?

### Leaving real-time logs on permanently

Real-time logs were enabled during an incident, then never disabled. Kinesis bills every record. Months later, the bill shows large spend on real-time logs for a workload that does not use them. Audit enabled log tiers quarterly.

### Wildcard invalidations on a PAYG distribution

Each wildcard invalidation (`/*`) bills per path on many tiers. Deployment scripts that invalidate `/*` on every release cost real money. Switch to tag-based invalidation (see `cache-behaviors-and-policies.md`) or invalidate specific paths.

### `PriceClass_All` when audience is regional

Default global price class is correct for global audiences. For a workload where 95%+ of viewers are in NA/EU, `PriceClass_100` saves on edge locations you will never serve. The reverse is the anti-pattern — restricting price class when the audience is actually global, then wondering why TTFB is poor from Asia.

### Lambda@Edge for work that belongs in CloudFront Functions

L@E bills per invocation with a higher unit cost than CFF. Simple header manipulation, URL rewrites, and auth checks belong in CFF. Moving from L@E to CFF for appropriate workloads cuts edge-compute bill materially.

### Lambda@Edge for security headers

Setting HSTS, X-Frame-Options, CSP via L@E at viewer-response. Every response pays an L@E invocation. Response Headers Policies do the same work at zero per-request compute cost. See `security-and-access.md` and `performance-tuning.md`.

### Duplicating WAF and origin-layer protection

If you are paying for AWS WAF with managed rule groups AND running application-layer protection (web framework's built-in rate limiter, ModSecurity on the origin, etc.), you are duplicating cost. Commit to one layer. WAF at the edge is the recommended layer.

## Free tier and dev workloads

CloudFront's free tier and the flat-rate Free tier cover most development and small personal workloads. A single hobby site or demo application rarely leaves the free tier. Do not over-engineer pricing optimization for dev workloads — most are free.

For production workloads, free tier is irrelevant on day one.

## Billing observability

Instrument CloudFront cost visibility before it becomes a problem:

### Cost Explorer

Filter by service: `CloudFront`, `WAF`, `Route 53`, `S3` (for log storage). Group by `UsageType` to see per-region data transfer, request counts, and log delivery broken out.

### Cost allocation tags

Tag distributions, WebACLs, and hosted zones with team/project/environment. Cost Explorer can then group by tag, enabling chargeback and per-team cost visibility.

```typescript
import * as cdk from 'aws-cdk-lib';

cdk.Tags.of(distribution).add('Team', 'edge-platform');
cdk.Tags.of(distribution).add('Environment', 'production');
cdk.Tags.of(distribution).add('CostCenter', 'infra-001');
```

### AWS Budgets

Set a CloudFront budget alert at 80% of expected monthly. Combine with WAF and Route 53 for total edge cost. Alerts surface cost anomalies before month-end.

```typescript
import * as budgets from 'aws-cdk-lib/aws-budgets';

new budgets.CfnBudget(this, 'EdgeBudget', {
  budget: {
    budgetType: 'COST',
    timeUnit: 'MONTHLY',
    budgetLimit: { amount: 5000, unit: 'USD' },
    costFilters: {
      Service: ['Amazon CloudFront', 'AWS WAF', 'Amazon Route 53'],
    },
  },
  notificationsWithSubscribers: [{
    notification: {
      comparisonOperator: 'GREATER_THAN',
      notificationType: 'ACTUAL',
      threshold: 80,
    },
    subscribers: [{ address: 'edge-team@example.com', subscriptionType: 'EMAIL' }],
  }],
});
```

### Anomaly detection

AWS Cost Anomaly Detection on CloudFront surfaces unusual spikes within a day. Useful for catching cache-miss regressions or DDoS events that leaked through to origin egress (rare under WAF + L7 AMR, but possible on misconfigured distributions).

## Case studies: when flat-rate is obviously right

### Content-heavy marketing site with unpredictable PR cycles

- Steady-state traffic is modest.
- Every few months a PR mention, conference talk, or viral social post drives a massive spike.
- PAYG bill on spike months is several times the baseline. Unpredictable.
- Flat-rate Pro or Business tier absorbs the spikes without surprise cost.

Flat-rate is obviously right.

### SaaS product with integrated WAF and bot management

- Already paying for WAF WebACL, managed rule groups, Bot Control.
- Already paying for Route 53 hosted zones and queries.
- Already paying for CloudFront standard logs to S3.
- Sum of PAYG line items is usually above the equivalent flat-rate tier.

Flat-rate bundles them all. Obviously right.

### Content monetization business (x402-gated content)

- Revenue scales with request volume.
- Cost predictability is essential for unit economics calculations.
- Variable CDN cost against per-request revenue breaks gross-margin modeling.

Flat-rate gives a fixed cost floor. Obviously right.

## Case studies: when PAYG is arguably right

### Pre-launch product with uncertain traffic

- Zero viewers during development.
- Launch traffic unknown.
- Hard to pick a flat-rate tier without data.

PAYG until there are a few months of real traffic to size against.

### Internal tool on a private VPC-only distribution

- Traffic measured in thousands of requests per day, not millions.
- Almost certainly stays inside CloudFront's free tier.
- No external exposure requiring WAF or Bot Control.

PAYG at essentially zero cost.

### Short-campaign microsite

- Three-month campaign, then decommissioned.
- Cannot justify a monthly subscription.

PAYG for the campaign window, then tear down.

## FinOps conversation starters

When discussing flat-rate with finance, emphasize:

- **Predictability.** Monthly bill is a budgeted line item, not a variance.
- **Budget consolidation.** WAF, DNS, logs, edge compute collapse into one invoice line.
- **Capacity for growth.** Traffic increase within the tier allowance does not increase cost. Product launches do not require finance approval.
- **DDoS and abuse immunity.** Attack traffic never surprises the bill.

When discussing PAYG, emphasize:

- **Per-unit granularity.** Each request, byte, and rule cleanly attributes to the business action driving it.
- **Zero minimum.** Low-traffic periods cost correspondingly little.
- **No commitment.** Cost scales with usage; you never overpay for unused allowance.

## Common questions

### Does switching to flat-rate lock me in?

No. You can switch back to PAYG at any billing boundary. No contractual minimum.

### What happens if I hit my plan's spike tolerance?

Traffic continues to be served. Sustained excess triggers graceful degradation (longer stale serving, cache-tightened behavior) before any cost event. You receive notifications to upgrade. You are never billed for an overage.

### Does flat-rate include all CloudFront features?

Most commonly-used features. Premium tier adds high-end features. Some features remain separately priced (Shield Advanced, real-time logs via Kinesis). Link to the [pricing page](https://aws.amazon.com/cloudfront/pricing/) for the authoritative list.

### Can I split usage across plans?

One pricing model per account per billing cycle for CloudFront. Multiple distributions in one account share the same billing model.

### Does flat-rate cover Lambda@Edge unlimited?

No. L@E has a per-tier allowance. Beyond the allowance, L@E bills at marginal rates. For workloads with heavy L@E usage, model this carefully before switching.

### Does flat-rate cover origin egress from S3 to CloudFront?

S3-to-CloudFront data transfer (in the same region) is free — this is unchanged on PAYG or flat-rate. CloudFront-to-viewer egress is what the CloudFront bill covers.

### What if my traffic is seasonal?

Flat-rate tiers are monthly. If your traffic is seasonal — high in Q4, low in Q1 — you can upgrade the tier for the peak months and downgrade during quiet months. Changes apply at the next billing boundary.

### Does the pricing model affect distribution configuration?

No. Distributions, behaviors, cache policies, and origin configurations are identical across pricing models. Switching between PAYG and flat-rate does not require redeployment.

### Can different accounts in my Organization use different models?

Yes. Pricing model is per-account. Accounts in the same AWS Organization can independently pick PAYG or flat-rate.

### How does flat-rate interact with AWS Enterprise Discount Program (EDP)?

EDP commitments typically apply across AWS services. Flat-rate CloudFront subscription counts toward EDP commitment. Discuss with AWS sales to confirm your specific agreement.

### Are there credits or incentives for migrating?

Periodically. Check with AWS sales when you are considering migration.

## Related

- `../aws-waf/references/pricing-and-plans.md` — WAF tier detail, what's bundled when.
- `../aws-waf/references/ddos-resilience.md` — L7 AMR mitigation, blocked-traffic billing rationale.
- `../aws-waf/references/bot-control-and-fraud.md` — Bot Control tier gating, enforcement capabilities.
- `../aws-waf/references/rate-limiting.md` — rate-limit rule billing behavior.
- `performance-tuning.md` — logging tier choice for observability.
- `agentic-patterns.md` — x402 content monetization as a revenue layer complementing flat-rate costs.
- `troubleshooting.md` — cost-related debugging (cache miss causing egress spike, log volume surge).
