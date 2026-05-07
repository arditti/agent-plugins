# Web ACLs and Rules

A web ACL is the unit of deployment for AWS WAF. Its anatomy is simple: a default action (Allow or Block), an ordered list of rules, optional rule group references (AWS-managed, vendor-managed, or custom), and one or more associations to CloudFront distributions or regional resources. Default to a denylist posture — default action Allow, with specific rules that Block known-bad traffic. An allowlist posture (default Block, explicit Allow rules) only makes sense for tightly scoped internal endpoints or compliance carve-outs. Front everything with CloudFront and attach the web ACL at CloudFront scope unless the user has explicitly rejected CloudFront.

## Contents

- [Scope: CloudFront vs regional](#scope-cloudfront-vs-regional)
- [Rule priority and evaluation order](#rule-priority-and-evaluation-order)
- [Rule actions](#rule-actions)
- [Labels: cross-rule communication](#labels-cross-rule-communication)
- [Web ACL Capacity Units (WCU)](#web-acl-capacity-units-wcu)
- [WCU optimization](#wcu-optimization)
- [WCU Statement Cost Reference](#wcu-statement-cost-reference)
- [Label-Based Scope-Down Pattern](#label-based-scope-down-pattern)
- [Rule statements overview](#rule-statements-overview)
- [Request inspection components](#request-inspection-components)
- [Text transforms](#text-transforms)
- [Rule groups](#rule-groups)
- [Web ACL associations](#web-acl-associations)
- [IaC with CDK L1 constructs](#iac-with-cdk-l1-constructs)
- [Logging and observability](#logging-and-observability)
- [Deployment and change management](#deployment-and-change-management)
- [Related](#related)

## Scope: CloudFront vs regional

AWS WAF has two scopes and they are not interchangeable. Pick scope before writing a single rule.

| Scope | Attaches to | Region constraint | Use when |
|-------|-------------|-------------------|----------|
| `CLOUDFRONT` | CloudFront distributions | Resources created in `us-east-1` only | Always, when CloudFront is in play |
| `REGIONAL` | ALB, API Gateway, AppSync GraphQL APIs, Cognito user pools, App Runner services, Verified Access instances | Same region as the protected resource | Only when the user has explicitly rejected CloudFront |

CloudFront scope is the default recommendation. Inspection happens at the edge before traffic hits regional infrastructure, which gives three compounding advantages: attacks are blocked closer to the source, a single web ACL can cover many origins behind one distribution, and CloudFront's cache absorbs volumetric pressure on static assets before WAF ever sees the request. Regional scope forces every request to reach a regional endpoint before inspection, which wastes compute and fails badly under L7 volumetric load.

For CloudFront scope, all WAF resources — the web ACL itself, rule groups, IP sets, regex pattern sets — must be created in `us-east-1`. This is not a CDK restriction; it is an AWS WAF restriction. Structure the CDK app so the CloudFront-scope stack deploys to `us-east-1` regardless of the primary deployment region of the application.

If the user runs a regional-only architecture (ALB with no CloudFront in front of it), recommend adding CloudFront first. The conversation to have is: what blocks CloudFront adoption here? Most objections (WebSocket support, origin access, certificate management) are resolved.

## Rule priority and evaluation order

Rules evaluate in ascending order of `Priority`. Lowest number first. The first terminating action wins — Block, Allow, CAPTCHA, and Challenge are terminating. Count is non-terminating: it increments metrics and applies labels, then evaluation continues to the next rule. A matched Count rule never stops processing.

Use sparse numbering. Start priorities at 10 and increment by 10. This leaves gaps for rules inserted later without forcing a mass renumber. A typical layout:

| Priority | Purpose |
|----------|---------|
| 10 | IP reputation and allowlists (cheap terminating denies first) |
| 20 | Geo and ASN filters |
| 30 | Known-bad inputs managed rule group |
| 40 | Bot Control managed rule group |
| 50 | Core rule set managed rule group |
| 60 | Rate-based rules |
| 70 | Application-specific custom rules |
| 80 | Label-dependent follow-up rules |

Evaluation order matters for more than correctness — it matters for cost. Put cheap terminating rules (IP set match, geo match) ahead of expensive rules (body inspection, regex, managed rule groups with broad scope). A request blocked at priority 10 never incurs the evaluation cost of priority 50.

## Rule actions

Five actions. Four are terminating; one is not.

- `Block` — return an HTTP response and stop. Custom response body and status code are optional but recommended for any Block rule that a legitimate user might hit (differentiating from generic 403s helps support triage). Custom response bodies are registered on the web ACL and referenced by key.
- `Allow` — short-circuit Allow and stop. Use sparingly — an explicit Allow rule at low priority overrides every rule at higher priority, including managed rule groups. Wrong Allows create dangerous bypasses.
- `Count` — non-terminating. Increments CloudWatch metrics and applies labels. Always the first deployment state of any new rule.
- `CAPTCHA` — terminating interactive challenge requiring human interaction.
- `Challenge` — terminating silent JavaScript challenge. Preferred over CAPTCHA for anything except explicit human gates.

Custom response bodies are defined once on the web ACL (`CustomResponseBodies` map) and referenced from individual Block actions by key. Register bodies for: API endpoints (return a JSON error with a support reference), HTML endpoints (return a branded deny page), and bot endpoints (return a 200 with a honeypot response — forces scrapers to waste cycles parsing nothing useful).

## Labels: cross-rule communication

Labels are the mechanism for building multi-stage inspection logic without duplicating match conditions. A rule applies a label when it matches; a later rule matches on that label via `LabelMatchStatement`. Rules never have to re-inspect the same part of the request.

Label naming follows a namespace convention. AWS-managed rules emit labels under `awswaf:managed:aws:<rule-group>:<signal>`. Custom rule groups emit under the rule group's namespace. Rules directly on a web ACL emit labels under the web ACL's namespace. Always prefix custom labels meaningfully — `app:auth:login-endpoint`, `app:bot:fingerprint-flagged`, `app:tenant:premium`.

Typical pattern: one rule identifies a traffic class (low-priority Count rule that only labels), and follow-up rules add conditions and terminate.

```typescript
import { Stack, StackProps } from 'aws-cdk-lib';
import { CfnWebACL } from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';

export class WebAclStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    new CfnWebACL(this, 'WebAcl', {
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: 'EdgeWebAcl',
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: 'LabelLoginEndpoint',
          priority: 10,
          action: { count: {} },
          statement: {
            byteMatchStatement: {
              fieldToMatch: { uriPath: {} },
              positionalConstraint: 'STARTS_WITH',
              searchString: '/login',
              textTransformations: [{ priority: 0, type: 'NONE' }],
            },
          },
          ruleLabels: [{ name: 'app:auth:login-endpoint' }],
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'LabelLoginEndpoint',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'ChallengeBotsOnLogin',
          priority: 20,
          action: { challenge: {} },
          statement: {
            andStatement: {
              statements: [
                {
                  labelMatchStatement: {
                    scope: 'LABEL',
                    key: 'app:auth:login-endpoint',
                  },
                },
                {
                  labelMatchStatement: {
                    scope: 'LABEL',
                    key: 'awswaf:managed:aws:bot-control:bot:category:http_library',
                  },
                },
              ],
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'ChallengeBotsOnLogin',
            sampledRequestsEnabled: true,
          },
        },
      ],
    });
  }
}
```

The first rule labels every `/login` request. The second rule matches the combination of that label and a Bot Control label and issues a Challenge. Neither rule has to re-inspect the URI or re-run Bot Control.

## Web ACL Capacity Units (WCU)

WCU is AWS WAF's abstract cost unit for rule evaluation complexity. Every statement type has a base cost, with modifiers for text transformations and match targets. The docs enumerate the WCU cost of every statement — link to the AWS WAF developer guide for current values.

Two caps apply:

- Web ACL total WCU budget — the sum of all inline rule WCUs plus custom rule group references. Link to quotas page for the ceiling.
- Rule group capacity — declared at rule group creation. Sum of the WCU costs of all rules inside. The rule group will not accept a rule that would push it over capacity.

Rule group capacity is immutable after creation. You cannot increase capacity on an existing rule group. Always over-provision — set `Capacity` to roughly twice the expected sum at creation. Reserving headroom is free; running out forces a rule group rebuild.

Managed rule groups use a separate capacity model — their WCU is accounted against the web ACL budget but the group itself is not a custom rule group. Bot Control, ATP, and ACFP consume more WCU than basic managed groups. Link to the managed rule group docs for current per-group costs.

## WCU optimization

WCU optimization is rule engineering. A tight web ACL costs less, runs faster, and has more room for new rules. Optimize in this order.

**Prefer cheap statement types.** `IPSetReferenceStatement`, `GeoMatchStatement`, `LabelMatchStatement`, and exact `ByteMatchStatement` have the lowest WCU costs. Regex, SQLi, XSS, and body inspection are expensive. Given two statements that solve the same problem, pick the cheap one.

**Consolidate regex into pattern sets.** One `RegexPatternSetReferenceStatement` pointing at a pattern set with N patterns costs a single statement's WCU — far less than N individual `RegexMatchStatement` blocks. Build a pattern set per logical category (admin paths, sensitive headers, PII formats) and reference it from one rule each.

**Share text transformations.** When WAF sees the same text transform list in the same order across multiple statements, it deduplicates the underlying transformation work internally. List `[URL_DECODE, LOWERCASE]` the same way everywhere. Inconsistent ordering forces redundant work.

**Scope down managed rule groups.** A `ScopeDownStatement` on a managed rule group reference limits which requests the rule group inspects. The Core Rule Set only needs to run on dynamic endpoints; `AWSManagedRulesSQLiRuleSet` only needs to run on paths that hit a SQL backend. Scope-down reduces both WCU consumed per request and false-positive surface.

**Sequence cheap checks first in AND/OR chains.** In an `AndStatement`, WAF short-circuits on the first failure. Put the cheapest statement first — if it fails, the expensive one never runs. Same logic for `OrStatement`: put the most selective cheap statement first.

**Call `CheckCapacity` before deploy.** The API returns the WCU cost of a proposed rule set without creating resources. Integrate it into CI so a pull request that pushes the web ACL over budget fails before merge.

**Over-provision rule group capacity.** Declare capacity roughly twice the expected sum. Capacity reservation costs nothing per se; resizing forces a destroy-and-recreate.

## WCU Statement Cost Reference

This reference is a snapshot — always validate with `aws wafv2 check-capacity` before deploying, and consult the [AWS WAF capacity units docs page](https://docs.aws.amazon.com/waf/latest/developerguide/aws-waf-capacity-units.html) for additions. AWS periodically adds new statement types (JA3/JA4, ASN, etc.) and may update costs; the docs page is authoritative.

### Statement costs table

| Statement Type | WCU | Notes |
| --- | --- | --- |
| GeoMatchStatement | 1 | Country/region matching |
| IPSetReferenceStatement | 1 | Standard IP matching |
| IPSetReferenceStatement (Forwarded IP, ANY position) | 5 | Inspecting forwarded IPs at ANY position |
| IPSetReferenceStatement (Forwarded IP, FIRST/LAST) | 1 | Specific position |
| SizeConstraintStatement | 1 | Size checks |
| LabelMatchStatement | 1 | Matching a label emitted earlier in the web ACL |
| ByteMatchStatement (EXACTLY) | 2 | Exact string match |
| ByteMatchStatement (STARTS_WITH) | 2 | Prefix match |
| ByteMatchStatement (ENDS_WITH) | 2 | Suffix match |
| ByteMatchStatement (CONTAINS) | 10 | Substring match — avoid when a prefix/suffix works |
| SqliMatchStatement (LOW sensitivity) | 20 | SQL injection detection |
| SqliMatchStatement (HIGH sensitivity) | 30 | SQL injection, higher FP risk |
| XssMatchStatement | 40 | Cross-site scripting detection |
| RegexMatchStatement | 3 | Single regex pattern |
| RegexPatternSetReferenceStatement | 25 | Regex pattern set (up to 10 patterns) |
| RateBasedStatement | 2 | Rate limiting (shadow IP set cost) |
| ManagedRuleGroupStatement | Varies | Check the rule group's documented capacity |

WAF also charges additional WCU on top of the base:

- **JSON body multiplier** — Statements that inspect `JsonBody` cost **2× the base WCU**. `XssMatchStatement` on `JsonBody` = 80 WCU. `SqliMatchStatement` HIGH on `JsonBody` = 60 WCU. The multiplier does NOT apply to text-transformation costs or field-parsing costs.
- **Field parsing costs (all-query / single-query)** — `AllQueryArguments` adds **+10 WCU**. `SingleQueryArgument` adds **+10 WCU**. All other fields (`UriPath`, `QueryString`, single `Header`, etc.) add 0.
- **Rule labels** — `0.2 WCU per label` rounded up to the nearest integer (so 1–5 labels = 1 WCU, 6–10 labels = 2 WCU).

### Text-transformation dedup

Each non-`NONE` text transform costs **10 WCU per transform in the chain**. The charge is **deduplicated** across rules only when the chain is identical — same transforms, same order, same field.

Concrete examples (validated against `CheckCapacity` API):

| Rule | Field + Chain | WCU | Reason |
| --- | --- | --- | --- |
| Rule 1 | UriPath + [LOWERCASE, URL_DECODE] | 20 | New chain, 2 transforms |
| Rule 2 | UriPath + [LOWERCASE, URL_DECODE] | 0 | Same chain, same field — shared |
| Rule 3 | UriPath + [LOWERCASE] | 10 | Different chain on same field — not shared |
| Rule 4 | QueryString + [LOWERCASE] | 10 | Different field — not shared |
| Rule 5 | UriPath + [URL_DECODE, HTML_ENTITY_DECODE] | 20 | Different chain — full charge again |

Rule: pick a standard transform chain per field (e.g. `UriPath: [LOWERCASE, URL_DECODE]`) and reuse it across every rule that inspects that field. Adding or removing even one transform creates a new chain.

### WCU budget planning

- Base web ACL capacity limit: 1500 WCU. Max on quota increase: 5000 WCU (see [AWS WAF quotas](https://docs.aws.amazon.com/waf/latest/developerguide/limits.html)).
- Managed rule groups have their own documented WCU cost — see the [AWS Managed Rules list](https://docs.aws.amazon.com/waf/latest/developerguide/aws-managed-rule-groups-list.html).
- Call `aws wafv2 check-capacity --scope CLOUDFRONT --rules file://rules.json` before deploying new rules.

### When to split rule groups

Rule group capacity is **immutable after creation**. Over-provision when creating a rule group — once set, you cannot resize without recreating. If you hit the 1500 WCU limit on a web ACL, split into multiple custom rule groups (each with its own immutable capacity), or request a limit increase to 5000 WCU.

### Docs reference

Always consult <https://docs.aws.amazon.com/waf/latest/developerguide/aws-waf-capacity-units.html> for the latest statement-cost values. AWS adds new statement types (JA3/JA4, ASN, etc.) and may update costs.

## Label-Based Scope-Down Pattern

When multiple managed rule groups all need the same scope-down (e.g. "only inspect `/api/*`"), avoid repeating an expensive `ByteMatchStatement` + text transform in every rule group's `ScopeDownStatement`. Label the traffic once with a cheap rule, then reference the label via `LabelMatchStatement` (1 WCU) in each rule group.

### Step 1 — label traffic once

Write a low-priority rule with `Action: Count` and a label.

```typescript
// Priority 25 — label traffic as API without terminating evaluation.
{
  name: 'LabelApiTraffic',
  priority: 25,
  action: { count: {} }, // CRITICAL: Count (or CAPTCHA / Challenge). Block or Allow terminates and the label never emits.
  statement: {
    byteMatchStatement: {
      fieldToMatch: { uriPath: {} },
      positionalConstraint: 'STARTS_WITH',
      searchString: '/api/',
      textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
    },
  },
  ruleLabels: [{ name: 'custom:api-traffic' }],
  visibilityConfig: {
    cloudWatchMetricsEnabled: true,
    sampledRequestsEnabled: true,
    metricName: 'LabelApiTraffic',
  },
}
```

Cost: ByteMatch STARTS_WITH (2) + LOWERCASE transform (10) + label (1) = 13 WCU one-time.

### Step 2 — scope down managed rule groups with a label match

Each subsequent managed rule group uses `LabelMatchStatement` in its `ScopeDownStatement` — 1 WCU each instead of 12+ WCU per-group.

```typescript
{
  name: 'CoreRuleSet',
  priority: 180,
  overrideAction: { count: {} }, // count-mode first
  statement: {
    managedRuleGroupStatement: {
      vendorName: 'AWS',
      name: 'AWSManagedRulesCommonRuleSet',
      scopeDownStatement: {
        labelMatchStatement: {
          scope: 'LABEL',
          key: 'custom:api-traffic',
        },
      },
    },
  },
  visibilityConfig: { /* ... */ },
}
```

### Savings

For N rule groups scoped-down on the same condition:

- Without label: N × (ByteMatch + transform) = N × 12 WCU + potentially each group re-charging transform if chain differs.
- With label: 13 WCU (once) + N × 1 WCU (LabelMatch per group).

Example: 3 managed rule groups with an API scope-down = 36 WCU without label vs 16 WCU with label. Savings scale linearly with rule-group count and make this pattern load-bearing for complex web ACLs.

### Label ordering gotcha

Labels are available only to rules that run AFTER the labeling rule. Put `LabelApiTraffic` at a low priority number (it evaluates first) and reference the label from higher-priority rule groups.

Rule-action discipline: the labeling rule's action MUST be Count, CAPTCHA, or Challenge. If you use Block or Allow, the rule terminates evaluation and the label never flows to later rules.

### Other label-based patterns

- **Multi-stage validation**: cheap rule emits "endpoint-is-login", expensive rule rate-limits on that label.
- **Positive security for APIs**: emit `api:valid-path` / `api:valid-method` / `api:valid-headers`, terminate at priority 9999 on label AndMatch — see [positive-security-for-apis.md](./positive-security-for-apis.md).
- **Composition with Anti-DDoS AMR**: compose custom rules on `awswaf:managed:aws:anti-ddos:*` labels — see [ddos-resilience.md](./ddos-resilience.md).

## Rule statements overview

| Statement | Notes |
|-----------|-------|
| `ByteMatchStatement` | String match — `EXACTLY`, `STARTS_WITH`, `ENDS_WITH`, `CONTAINS`, `CONTAINS_WORD`. Prefer the most specific positional constraint. |
| `RegexMatchStatement` | Single inline regex. Prefer `RegexPatternSetReferenceStatement`. |
| `RegexPatternSetReferenceStatement` | N patterns in one pattern set. Cheap scaling. |
| `IPSetReferenceStatement` | CIDR-based IPv4/IPv6 set reference. |
| `GeoMatchStatement` | ISO 3166 country codes. |
| `SizeConstraintStatement` | Field size comparison. Detect oversized payloads, empty bodies. |
| `SqliMatchStatement` | SQL injection detection. Expensive; scope down. |
| `XssMatchStatement` | Cross-site scripting detection. Expensive; scope down. |
| `LabelMatchStatement` | Match on labels from prior rules. Cheap. |
| `RateBasedStatement` | Volume-based limit. See `rate-limiting.md`. |
| `RuleGroupReferenceStatement` | Custom rule group reference. |
| `ManagedRuleGroupStatement` | Managed rule group reference. Supports scope-down and excluded rules. |
| `AndStatement`, `OrStatement`, `NotStatement` | Boolean composition of any of the above. |

## Request inspection components

Every statement selects a `FieldToMatch`. Pick the narrowest field that carries the signal.

| Field | Notes |
|-------|-------|
| `UriPath` | Path only, no query. Cheap. |
| `QueryString` | Full query string. Size-limited — link to docs. |
| `SingleHeader { name }` | One header by name. Prefer over `Headers` when you know the field. |
| `Headers` | All headers with `MatchPattern` (include/exclude/all). Specify `OversizeHandling`. |
| `Cookies` | Similar shape to `Headers`. Specify `OversizeHandling`. |
| `SingleCookie { name }` | One cookie by name. |
| `Body` | Request body, up to size limit. Specify `OversizeHandling`. Expensive. |
| `JsonBody` | Parsed JSON body with JSON path. Prefer when body is JSON. |
| `Method` | HTTP method. |
| `JA3Fingerprint` | TLS client hello fingerprint (legacy). |
| `JA4Fingerprint` | TLS client hello fingerprint (current). |
| `HeaderOrder` | Header ordering fingerprint. |

`OversizeHandling` options are `CONTINUE`, `MATCH`, or `NO_MATCH`. Default varies by field — always set it explicitly. `MATCH` treats an oversized field as a match (useful to reject oversized headers outright); `NO_MATCH` treats it as no match; `CONTINUE` inspects what fits under the limit.

## Text transforms

Text transforms normalize the field before matching. Chain them via `TextTransformations` array with `Priority` values — lower priority runs first.

| Transform | Use case |
|-----------|----------|
| `NONE` | No transform. Use when the field is already canonical. |
| `URL_DECODE` | Decode percent-encoded input. Apply before matching URL parameters. |
| `URL_DECODE_UNI` | Decode Unicode-encoded input. |
| `HTML_ENTITY_DECODE` | Decode HTML entities. Apply before matching HTML content. |
| `LOWERCASE` | Case-insensitive match. |
| `COMPRESS_WHITE_SPACE` | Collapse runs of whitespace. Foils padding evasion. |
| `CMD_LINE` | Normalize command-line-style inputs for CMD injection detection. |
| `JS_DECODE` | Decode JavaScript escapes. |
| `BASE64_DECODE`, `BASE64_DECODE_EXT` | Base64 decode. |
| `CSS_DECODE` | Decode CSS escapes. |
| `ESCAPE_SEQ_DECODE` | Decode backslash escapes. |
| `HEX_DECODE` | Decode hex escapes. |
| `NORMALIZE_PATH`, `NORMALIZE_PATH_WIN` | Path traversal normalization. |
| `SQL_HEX_DECODE` | SQL-specific hex decoding. |
| `UTF8_TO_UNICODE` | UTF-8 to Unicode. |
| `REPLACE_COMMENTS`, `REPLACE_NULLS` | Strip comment markers and null bytes. |
| `REMOVE_NULLS` | Strip null bytes. |

Maintain identical transform lists across statements that share a normalization to maximize internal deduplication.

## Rule groups

Two kinds of rule groups: managed and custom.

**Managed rule groups** are maintained by AWS or by Marketplace vendors. They are opaque — you cannot modify the rules inside. You can override the action of the entire group, override the action of individual sub-rules, exclude sub-rules, or scope down which requests hit the group. Managed rule group capacity is modeled separately from custom rule group WCU — link to the AWS WAF pricing and quotas pages for the current model.

Changes to a managed rule group's version happen on AWS's release cadence. The version you reference can be pinned (`Version: <specific>`) or set to auto-update (omit `Version` or set to `DEFAULT`). See `managed-rules.md` for version management strategy.

**Custom rule groups** are your reusable rule bundles. Use them for rules that need to be reused across multiple web ACLs (staging and production, multiple business units, multiple distributions). Capacity is immutable — over-provision.

A rule group is a cleaner unit of ownership than dumping rules inline in the web ACL. Every organization with more than one web ACL should structure shared security policy as custom rule groups.

## Web ACL associations

A web ACL is useless until associated with a resource.

- **CloudFront distribution.** The web ACL ARN goes on the distribution's `WebACLId` field. Create the association as part of the distribution configuration, not as a separate `CfnWebACLAssociation`. CloudFront-scope web ACLs cannot be associated with regional resources.
- **ALB, API Gateway, AppSync, Cognito, App Runner, Verified Access.** Regional-scope web ACLs use `CfnWebACLAssociation` with the resource ARN. One web ACL per resource; a resource cannot have multiple web ACLs.

A single CloudFront-scope web ACL can front many distributions — use this to your advantage. One security policy, one place to tune, many properties protected.

## IaC with CDK L1 constructs

CDK does not yet have mature L2 constructs for WAFv2. All WAFv2 work in CDK is done through L1 CloudFormation-equivalent constructs in `aws-cdk-lib/aws-wafv2`.

Core constructs:

- `CfnWebACL` — the web ACL itself.
- `CfnRuleGroup` — a custom rule group.
- `CfnWebACLAssociation` — association to regional resources.
- `CfnIPSet` — CIDR set.
- `CfnRegexPatternSet` — regex pattern bundle.
- `CfnLoggingConfiguration` — logging destination for a web ACL.

```typescript
import { Stack, StackProps, RemovalPolicy } from 'aws-cdk-lib';
import { CfnIPSet, CfnRegexPatternSet, CfnRuleGroup, CfnWebACL } from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';

export class EdgeSecurityStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, { ...props, env: { region: 'us-east-1' } });

    const trustedOffices = new CfnIPSet(this, 'TrustedOffices', {
      scope: 'CLOUDFRONT',
      ipAddressVersion: 'IPV4',
      addresses: [],
    });

    const adminPaths = new CfnRegexPatternSet(this, 'AdminPaths', {
      scope: 'CLOUDFRONT',
      regularExpressionList: [
        '^/admin(/.*)?$',
        '^/internal(/.*)?$',
        '^/\\.git(/.*)?$',
      ],
    });

    const appRuleGroup = new CfnRuleGroup(this, 'AppRuleGroup', {
      scope: 'CLOUDFRONT',
      capacity: 500,
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: 'AppRuleGroup',
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: 'BlockAdminExceptTrustedOffices',
          priority: 10,
          action: { block: {} },
          statement: {
            andStatement: {
              statements: [
                {
                  regexPatternSetReferenceStatement: {
                    arn: adminPaths.attrArn,
                    fieldToMatch: { uriPath: {} },
                    textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
                  },
                },
                {
                  notStatement: {
                    statement: {
                      ipSetReferenceStatement: { arn: trustedOffices.attrArn },
                    },
                  },
                },
              ],
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'BlockAdminExceptTrustedOffices',
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    new CfnWebACL(this, 'EdgeWebAcl', {
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: 'EdgeWebAcl',
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: 'AppRuleGroupRef',
          priority: 100,
          overrideAction: { none: {} },
          statement: {
            ruleGroupReferenceStatement: { arn: appRuleGroup.attrArn },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'AppRuleGroupRef',
            sampledRequestsEnabled: true,
          },
        },
      ],
    }).applyRemovalPolicy(RemovalPolicy.RETAIN);
  }
}
```

A few patterns worth pinning:

- Pass the rule group's `attrArn` to `ruleGroupReferenceStatement.arn`. CDK resolves the ARN at deploy time.
- Set `overrideAction` to `{ none: {} }` on custom rule group references — required by the API shape.
- Name every rule's metric in `visibilityConfig.metricName` and enable sampled requests. Without these, the rule is a black box in CloudWatch.
- Deploy CloudFront-scope stacks to `us-east-1` by pinning the region in `env`.
- `RETAIN` the web ACL on destroy if it is production-facing.

## Logging and observability

A web ACL without logging is opaque. Enable logging before any rule goes to Block.

- `CfnLoggingConfiguration` sends web ACL logs to Kinesis Data Firehose, CloudWatch Logs, or S3. Pick one destination aligned with the existing observability stack — S3 for long-term retention and Athena analysis, CloudWatch Logs for real-time search, Firehose for downstream processing.
- Redact fields that must not leak into logs (auth headers, session cookies) via the `RedactedFields` configuration. PII redaction is mandatory for compliance footprints (PCI, HIPAA, GDPR); link to the AWS WAF developer guide for the redaction field shape.
- Sample rate controls log volume. In production, sample only non-matching traffic and keep 100% of matching (Block/Count/CAPTCHA/Challenge) traffic.
- Every rule with `SampledRequestsEnabled` also surfaces in the console's sampled requests view — the faster-feedback tool during tuning. Do not rely on sampled requests as the long-term audit trail; use the logging configuration for that.

Pair logging with CloudWatch metrics and alarms on `BlockedRequests`, `CountedRequests`, and `AllowedRequests` per rule. Set alarms on step changes rather than absolute thresholds — a sudden rise in blocks is usually more informative than a fixed ceiling.

## Deployment and change management

Web ACL changes deploy through the same IaC pipeline as the rest of the infrastructure. Guardrails for change management:

- Every rule change goes through a pull request. Security rules are code.
- CI calls `CheckCapacity` on the proposed rule set and fails the PR if the web ACL would exceed the WCU budget.
- Deploy new rules with `OverrideAction: COUNT` (for rule groups) or `Action: Count` (for inline rules). A separate follow-up PR promotes to terminating actions after the soak period.
- Stage changes to non-production web ACLs first. The staging web ACL should reference the same rule groups as production so version drift does not mask issues.
- Tag every web ACL, rule group, IP set, and regex pattern set with owner, environment, and change ticket reference. WAF resources are security-critical; ownership clarity matters.

Rollback strategy: treat the web ACL's prior committed state as the rollback target. Revert the PR, redeploy. Do not hand-edit the console to remove a rule — it drifts from IaC and the next deployment undoes the fix.

## Related

- [managed-rules.md](managed-rules.md) — managed rule group selection, overrides, version management
- [custom-rules-and-regex.md](custom-rules-and-regex.md) — custom rule statements, regex pattern sets, label-driven logic
- [bot-control-and-fraud.md](bot-control-and-fraud.md) — Bot Control, ATP, ACFP integration
- [rate-limiting.md](rate-limiting.md) — rate-based statements and aggregation keys
- [ddos-resilience.md](ddos-resilience.md) — L7 volumetric defense patterns
- [pricing-and-plans.md](pricing-and-plans.md) — WCU and managed-rule-group costs
- [troubleshooting.md](troubleshooting.md) — sampled requests, log inspection, false positive triage
- [../aws-cloudfront/SKILL.md](../aws-cloudfront/SKILL.md) — CloudFront fronting, the default recommendation
- [../aws-cloudfront/references/agentic-patterns.md](../aws-cloudfront/references/agentic-patterns.md) — x402, AI crawler policy
