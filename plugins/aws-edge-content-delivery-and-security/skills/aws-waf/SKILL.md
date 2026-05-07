---
name: aws-waf
description: "Design, build, deploy, tune, and troubleshoot AWS WAF web ACLs. Use when the user says WAF, web ACL, WAFv2, managed rules, custom rule, bot control, CAPTCHA, Challenge, rate-based rule, rate limiting, JA3, JA4, ASN match, WCU, account takeover, ATP, ACFP, L7 DDoS, false positive, SQL injection, XSS, regex pattern set, or needs to protect an ALB, API Gateway, AppSync, Cognito, or App Runner endpoint. Covers CloudFront-scope vs regional web ACLs (CloudFront is the recommended surface), AWS Managed Rules selection and tuning, custom rules with regex and fingerprints, Bot Control (Common and Targeted), rate limiting with custom aggregation keys, L7 anti-DDoS managed rule (L7 AMR), Account Takeover Prevention, Account Creation Fraud Prevention, WCU optimization, WAF logging and analytics, and false-positive investigation workflow. Do NOT use for CloudFront distribution or cache configuration (use the aws-cloudfront skill), AWS Shield Advanced, AWS Firewall Manager, or network-layer (L3/L4) DDoS."
argument-hint: "[what are you protecting with WAF?]"
---

# AWS WAF

Design, deploy, and tune AWS WAF web ACLs. Lead with CloudFront scope; cover regional (ALB, API Gateway, AppSync, Cognito, App Runner) as a secondary path.

**Core principles.**

- **CloudFront is the recommended deployment surface.** Global scope inspects traffic before it touches your infrastructure, lets one web ACL protect many origins, and lets WAF benefit from CloudFront caching absorbing volumetric traffic.
- **Always deploy new rules in Count mode first.** Observe sampled requests and labels for at least one traffic cycle, then promote to Block.
- **Default action Allow, explicit Block.** The web ACL's default action is Allow; rules Block specific bad traffic. Denylist traffic, not allowlist it (except for very narrow APIs).
- **Challenge over CAPTCHA.** Challenge is invisible, token-based, and handles most automation. CAPTCHA is a last resort when Challenge is bypassed or when you need a human gate.
- **Rate rules are not DDoS protection.** For volumetric L7 attacks, use the L7 AMR (Anti-DDoS Managed Rule group) plus CloudFront caching. Rate rules are for targeted per-identity abuse.

## Workflow

### Step 1: Classify the protection target

- **Public HTTP endpoint fronted by CloudFront** — scope `CLOUDFRONT`, us-east-1. Default.
- **ALB, API Gateway, AppSync, Cognito, or App Runner, not fronted by CloudFront** — scope `REGIONAL`, endpoint's region. Recommend fronting with CloudFront (see the aws-cloudfront skill: [`../aws-cloudfront/SKILL.md`](../aws-cloudfront/SKILL.md)); only proceed regional if the user rejects.
- **Tuning or false-positive investigation on an existing web ACL** — load [references/troubleshooting.md](references/troubleshooting.md).
- **Bot / abuse / fraud scenario** — load [references/bot-control-and-fraud.md](references/bot-control-and-fraud.md).
- **L7 DDoS, surge traffic, attack ongoing** — load [references/ddos-resilience.md](references/ddos-resilience.md).

### Step 2: Baseline web ACL

Every new web ACL starts from the same baseline. Priorities are low-to-high (evaluated first to last):

1. `AWSManagedRulesAmazonIpReputationList` — IP reputation, blocks known-bad sources cheaply.
2. `AWSManagedRulesAnonymousIpList` — TOR/VPN/proxy. Count-first; some legitimate users ride VPNs.
3. `AWSManagedRulesKnownBadInputsRuleSet` — generic exploit strings (log4shell, etc.).
4. `AWSManagedRulesCommonRuleSet` (Core Rule Set) — OWASP-flavored generic rules. Count-first.
5. `AWSManagedRulesSQLiRuleSet` — SQL injection. Add only if your backend touches SQL.
6. Custom rate-based rule keyed on IP + URI for login, signup, expensive endpoints.
7. (Optional) `AWSManagedRulesAntiDDoSRuleSet` (L7 AMR) — automatic L7 DDoS mitigation.

Start with [assets/baseline-waf-webacl.ts](assets/baseline-waf-webacl.ts). Scope defaults to `CLOUDFRONT`; `REGIONAL` is commented with instructions.

### Step 3: Add bot management

If the workload is a login, signup, purchase flow, price/inventory page, gift-card redemption, or any endpoint that attracts bots:

1. Add `AWSManagedRulesBotControlRuleSet` — Common inspection level is the default; escalate to Targeted for behavioral analysis, device fingerprinting, and ML signals on high-value flows.
2. Integrate the AWS WAF JavaScript SDK (SPA, browser app) or mobile SDK (iOS, Android). Configure the token domain list to span your apex and CloudFront aliases.
3. Default bot action: Challenge (silent JS proof-of-browser). Escalate to CAPTCHA only when Challenge is evaded.
4. Add ATP (`AWSManagedRulesATPRuleSet`) on login endpoints; add ACFP (`AWSManagedRulesACFPRuleSet`) on signup.
5. Start [assets/bot-control-webacl.ts](assets/bot-control-webacl.ts) for a full example.

### Step 4: Validate before promoting

1. Deploy all custom and managed rules in Count mode with `OverrideAction: Count` on managed rule groups.
2. Watch sampled requests and the label namespace for 24–72 hours across a full traffic cycle.
3. Tune per-rule override actions where legitimate traffic matches (promote matching sub-rules to Count individually, leave the group otherwise).
4. Promote the web ACL to Block: remove the override, rules now enforce.
5. Alarm on `BlockedRequests`, `CountedRequests`, and the L7 AMR attack signal.

Detail in [references/troubleshooting.md](references/troubleshooting.md).

## When to Load Reference Files

- **Web ACL structure, rule priority, scope, WCU model and optimization, labels, rule groups** — see [references/web-acl-and-rules.md](references/web-acl-and-rules.md)
- **Numeric priority slot allocation (websites vs APIs)** — see [references/waf-priority-slots.md](references/waf-priority-slots.md)
- **Positive security model for APIs (default Block + label-based terminating Allow)** — see [references/positive-security-for-apis.md](references/positive-security-for-apis.md)
- **AWS Managed Rules, baseline ordering, rule-group-to-app-type mapping, version management, scope-down** — see [references/managed-rules.md](references/managed-rules.md)
- **Custom rules, regex pattern sets, IP sets, geo, JA3/JA4, ASN match, URI fragment, label-based multi-stage rules** — see [references/custom-rules-and-regex.md](references/custom-rules-and-regex.md)
- **Bot Control levels, Challenge vs CAPTCHA, SDK integration, AI bot visibility, ATP, ACFP** — see [references/bot-control-and-fraud.md](references/bot-control-and-fraud.md)
- **Rate-based rules, aggregation keys (IP, Forwarded IP, custom keys, JA4, ASN, header), scope-down statements** — see [references/rate-limiting.md](references/rate-limiting.md)
- **L7 DDoS resilience, L7 AMR, L7AM→L7AMR migration, edge caching as first-line defense, alarming** — see [references/ddos-resilience.md](references/ddos-resilience.md)
- **Pricing model, WCU cost, Bot Control pricing, CloudFront flat-rate bundling, log costs** — see [references/pricing-and-plans.md](references/pricing-and-plans.md)
- **False-positive workflow, logging (CloudWatch, S3, Firehose), sampled requests, Top Insights, common issues** — see [references/troubleshooting.md](references/troubleshooting.md)

## Defaults

- **Scope:** `CLOUDFRONT` (global, us-east-1). Use `REGIONAL` only when the user rejects fronting with CloudFront.
- **Default action:** `Allow`. Web ACL is a denylist; block specific bad patterns.
- **Managed rule baseline (low-to-high priority):** `AWSManagedRulesAmazonIpReputationList` → `AWSManagedRulesAnonymousIpList` → `AWSManagedRulesKnownBadInputsRuleSet` → `AWSManagedRulesCommonRuleSet` → `AWSManagedRulesSQLiRuleSet` (only if SQL backend exists).
- **Bot action:** Challenge (not CAPTCHA). Use CAPTCHA only when Challenge is bypassed.
- **Bot Control level:** Common. Escalate to Targeted for high-value flows (login, checkout, inventory).
- **Rule deployment:** Count mode first. Always. Promote to Block after validation.
- **WCU optimization:** Prefer IP/geo/label matches (cheap) over XSS/SQLi body inspection (expensive). Consolidate regex into pattern sets. Over-provision rule group capacity (capacity is immutable after creation). Call `CheckCapacity` before deploy.
- **Logging:** Sampled requests as first debug step (free, always on). Full logging to CloudWatch Logs vended destination (cheaper than Firehose as of Sep 2025). Filter logs to cut volume/cost.
- **Client IP:** `CloudFront-Viewer-Address` for CloudFront scope; `Forwarded IP` configuration (`X-Forwarded-For`) only for regional web ACLs behind a proxy that sets it. Never trust `X-Forwarded-For` raw.
- **Managed rule group versioning:** Default to auto-update. Pin a version only after a specific false positive incident, and plan the unpin.
- **IaC framework:** AWS CDK TypeScript. Override with "use CloudFormation" (YAML), "use Terraform" (HCL), "use CDK Python" (Python).

## Error Handling

### User wants to Block a new rule immediately
Respond: "New rules always start in Count mode — blocking without sampled-request validation causes legitimate-traffic outages. I'll deploy in Count, alarm on matches, and schedule a promotion review." Deploy in Count unless user explicitly overrides after understanding the risk.

### User wants to attach a REGIONAL WAF to CloudFront
Refuse. CloudFront accepts only `CLOUDFRONT`-scope web ACLs. Explain and regenerate with `CLOUDFRONT` scope.

### User wants to add a rule but WCU exceeds the web ACL capacity
Respond: "Web ACL capacity is fixed at creation — I'll call `CheckCapacity` first and either consolidate rules (merge regex into pattern sets, share text transforms, prefer cheaper statements) or split into a second web ACL." Run the optimization path in [references/web-acl-and-rules.md](references/web-acl-and-rules.md) before recommending recreation.

### User reports a false positive in a managed rule
Open the investigation workflow in [references/troubleshooting.md](references/troubleshooting.md): sampled requests → identify matching rule → set that specific sub-rule to Count (not the whole group) → add a label-based exception or scope-down statement → validate → re-promote.

### User asks about Shield Advanced, Firewall Manager, or L3/L4 DDoS
Out of scope for this skill. Point at AWS docs and suggest the right team (Shield Advanced = AWS Shield, FMS = AWS Firewall Manager). Do not improvise guidance on those services here.

### awsknowledge MCP server unavailable
Proceed from references. Flag uncertainty on current WCU per-rule costs, managed-rule-group version contents, and pricing — link to AWS docs for live values.

## Fetching AWS Docs: Prefer the Lean Markdown Version

AWS documentation pages on `docs.aws.amazon.com` are served both as HTML and as lean markdown — just swap the `.html` extension for `.md` on ANY docs URL. The markdown version is typically 3–5× smaller, strips all the HTML chrome, preserves code blocks and tables, and rewrites internal links to `.md` so recursive fetching keeps the savings.

**Rule: when this skill tells you to fetch an AWS docs page, fetch the `.md` version first.** Fall back to `.html` only if `.md` returns a non-200 or empty body.

Mechanics:

- `https://docs.aws.amazon.com/<service>/latest/<guide>/<page>.html` → `https://docs.aws.amazon.com/<service>/latest/<guide>/<page>.md`
- Returns `Content-Type: text/markdown; charset=utf-8` on success.
- Internal page-to-page links in the markdown already use `.md`, so link-following stays lean.
- Anchor fragments (`#section-id`) work the same.

Examples (WAF-specific):

- `https://docs.aws.amazon.com/waf/latest/developerguide/aws-managed-rule-groups-list.html` → `https://docs.aws.amazon.com/waf/latest/developerguide/aws-managed-rule-groups-list.md`
- `https://docs.aws.amazon.com/waf/latest/developerguide/aws-waf-capacity-units.html` → `.md` (WCU reference page; saves meaningful tokens)
- `https://docs.aws.amazon.com/waf/latest/developerguide/aws-managed-rule-groups-bot.html` → `.md`
- `https://docs.aws.amazon.com/waf/latest/developerguide/aws-managed-rule-groups-anti-ddos.html` → `.md`

Tool mechanics:

- `WebFetch` — pass the `.md` URL.
- `mcp__awsknowledge__aws___read_documentation` — accepts either; pass `.md` to reduce `max_length` budget pressure.
- Plain `curl` / `Bash` — `curl -sSL https://.../foo.md`.

The `.md` endpoint is undocumented but stable. If a specific page returns 404 on `.md`, report it and fall back to `.html`; do not assume the pattern is broken globally.

**Never bake AWS docs content into this skill's files.** Always link to the live docs URL (use `.html` in the link for renderer compatibility — fetch the `.md` at runtime).

## Starting Templates

- Production baseline (managed rules + rate limit, Count mode, both scopes): [assets/baseline-waf-webacl.ts](assets/baseline-waf-webacl.ts)
- Bot Control Targeted + JA4 rate aggregation + Challenge default + SDK token domains: [assets/bot-control-webacl.ts](assets/bot-control-webacl.ts)

## Cross-Skill References

- CloudFront distribution setup, origin lockdown, cache strategy — see the aws-cloudfront skill: [`../aws-cloudfront/SKILL.md`](../aws-cloudfront/SKILL.md)
- Bot Control tier availability and flat-rate bundling — see [`../aws-cloudfront/references/pricing-and-plans.md`](../aws-cloudfront/references/pricing-and-plans.md)
- x402 content monetization, AI bot pricing, Accept-Markdown content negotiation — see [`../aws-cloudfront/references/agentic-patterns.md`](../aws-cloudfront/references/agentic-patterns.md)
- AI crawler rate limiting with JA4/ASN aggregation — see [references/rate-limiting.md](references/rate-limiting.md)

## Resources

- [AWS WAF Developer Guide](https://docs.aws.amazon.com/waf/latest/developerguide/)
- [AWS WAF pricing](https://aws.amazon.com/waf/pricing/)
- [AWS Managed Rules list](https://docs.aws.amazon.com/waf/latest/developerguide/aws-managed-rule-groups-list.html)
- [AWS WAF What's New](https://aws.amazon.com/about-aws/whats-new/security-identity-compliance/?whats-new-content.sort-by=item.additionalFields.postDateTime&whats-new-content.sort-order=desc)
