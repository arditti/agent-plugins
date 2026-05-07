# Custom Rules and Regex

Custom rules cover what managed rule groups cannot: app-specific signals, unusual attack patterns, business-logic abuse, and multi-stage label-driven logic. Reach for managed rule groups first for generic threats. Reach for custom rules when the signal is unique to your application — your admin path structure, your tenant routing, your known-bad fingerprints, your business-specific rate-limit boundaries. Every custom rule you write should be the cheapest possible statement that captures the signal. Regex is expensive. Body inspection is expensive. String match is cheap.

## Contents

- [String match: the cheap default](#string-match-the-cheap-default)
- [Regex pattern sets](#regex-pattern-sets)
- [IP sets](#ip-sets)
- [Geo match](#geo-match)
- [JA3 and JA4 TLS fingerprints](#ja3-and-ja4-tls-fingerprints)
- [ASN match](#asn-match)
- [URI fragment match](#uri-fragment-match)
- [Label-based multi-stage rules](#label-based-multi-stage-rules)
- [Body inspection](#body-inspection)
- [Cookies and headers](#cookies-and-headers)
- [Anti-patterns](#anti-patterns)
- [Related](#related)

## String match: the cheap default

`ByteMatchStatement` is the cheapest positional statement in WAF. Prefer it over regex whenever the signal is a fixed string or a path prefix/suffix.

Positional constraints:

| Constraint | Example | Cost posture |
|------------|---------|--------------|
| `EXACTLY` | Match only when the entire field equals the search string | Cheapest |
| `STARTS_WITH` | Match path prefix (`/admin`, `/api/v1/`) | Cheap |
| `ENDS_WITH` | Match file extension (`.php`, `.env`) | Cheap |
| `CONTAINS` | Match any occurrence | More expensive |
| `CONTAINS_WORD` | Match as a whole word (bounded by non-word chars) | More expensive |

`EXACTLY`, `STARTS_WITH`, and `ENDS_WITH` are substantially cheaper than `CONTAINS` and `CONTAINS_WORD`. Pick the most specific that captures the signal. "Requests whose path starts with `/admin`" is a `STARTS_WITH` — it is not a `CONTAINS`.

Field choices matter for cost too. Inspecting `UriPath` or `SingleHeader` by name is cheaper than inspecting `Headers` (all headers), `QueryString`, or `Body`. Target the narrowest field that carries the signal.

```typescript
import { CfnWebACL } from 'aws-cdk-lib/aws-wafv2';

const blockEnvFiles: CfnWebACL.RuleProperty = {
  name: 'BlockDotEnvPaths',
  priority: 70,
  action: { block: {} },
  statement: {
    byteMatchStatement: {
      fieldToMatch: { uriPath: {} },
      positionalConstraint: 'ENDS_WITH',
      searchString: '.env',
      textTransformations: [
        { priority: 0, type: 'LOWERCASE' },
        { priority: 1, type: 'URL_DECODE' },
      ],
    },
  },
  visibilityConfig: {
    cloudWatchMetricsEnabled: true,
    metricName: 'BlockDotEnvPaths',
    sampledRequestsEnabled: true,
  },
};
```

## Regex pattern sets

When a single regex statement is needed, use `RegexMatchStatement`. When multiple regexes cover the same logical concern (admin paths, sensitive file extensions, PII formats, internal routes), consolidate into one `CfnRegexPatternSet` and reference it with `RegexPatternSetReferenceStatement`.

A regex pattern set with N patterns costs the WCU of a single pattern-set-reference statement. N individual `RegexMatchStatement` rules cost roughly N times as much. The pattern-set approach scales near-free per additional pattern.

Current limits (maximum patterns per set, maximum regex size, maximum pattern sets per account) are published in the AWS WAF quotas documentation — link to that rather than memorize.

Regex flavor is a limited PCRE subset. Backreferences, lookbehind, and other advanced constructs are not supported; link to the AWS WAF developer guide for the current supported syntax. Keep patterns small, test them, and avoid catastrophic backtracking — WAF will reject regex that it considers unsafe but design your patterns to be linear-time anyway.

Use regex pattern sets for:

- SSN, phone number, credit-card-shaped, or other PII formats for data-loss detection.
- Custom token formats your app uses (so you can detect tokens leaked into logs or query strings).
- Admin-route patterns with variations (`^/admin`, `^/wp-admin`, `^/\.git`, `^/internal`).

```typescript
import { CfnRegexPatternSet, CfnWebACL } from 'aws-cdk-lib/aws-wafv2';

const sensitivePaths = new CfnRegexPatternSet(this, 'SensitivePaths', {
  scope: 'CLOUDFRONT',
  regularExpressionList: [
    '^/admin(/.*)?$',
    '^/internal(/.*)?$',
    '^/\\.git(/.*)?$',
    '^/\\.env$',
    '^/phpmyadmin(/.*)?$',
  ],
});

const blockSensitivePaths: CfnWebACL.RuleProperty = {
  name: 'BlockSensitivePaths',
  priority: 75,
  action: { block: {} },
  statement: {
    regexPatternSetReferenceStatement: {
      arn: sensitivePaths.attrArn,
      fieldToMatch: { uriPath: {} },
      textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
    },
  },
  visibilityConfig: {
    cloudWatchMetricsEnabled: true,
    metricName: 'BlockSensitivePaths',
    sampledRequestsEnabled: true,
  },
};
```

## IP sets

`CfnIPSet` holds CIDR blocks. IPv4 and IPv6 each live in their own set — one set cannot mix address families. Create an IPv4 set and an IPv6 set side by side when you need coverage of both.

Use cases:

- Office / VPN allowlists for admin paths.
- Persistent blocklists maintained by security engineering (known-bad IPs accumulated over time).
- Feed-driven blocklists updated via CDK deployment or via the UpdateIPSet API from an external feed.

Maximum addresses per set and maximum sets per account are published in the AWS WAF quotas. Large dynamic feeds that exceed the per-set cap should be sharded across multiple sets and combined with `OrStatement`.

### Forwarded IP configuration

Regional-scope WAFs often sit behind a proxy (CloudFront fronting an ALB, or a third-party CDN). The source IP that WAF sees is the proxy's IP, not the client's. Resolve this with `ForwardedIPConfig`.

- `HeaderName` — typically `X-Forwarded-For`.
- `FallbackBehavior` — `MATCH` or `NO_MATCH` when the header is missing or malformed. Pick deliberately; the default is not safe for every use case.
- `Position` — `FIRST`, `LAST`, or `ANY`. Pin this to the position your edge writes the client IP. Never leave it as `ANY` in production — it lets attackers spoof by adding headers.

```typescript
import { CfnIPSet, CfnWebACL } from 'aws-cdk-lib/aws-wafv2';

const trustedOffices = new CfnIPSet(this, 'TrustedOffices', {
  scope: 'REGIONAL',
  ipAddressVersion: 'IPV4',
  addresses: [],
});

const allowFromOffices: CfnWebACL.RuleProperty = {
  name: 'AllowFromOffices',
  priority: 5,
  action: { allow: {} },
  statement: {
    ipSetReferenceStatement: {
      arn: trustedOffices.attrArn,
      ipSetForwardedIpConfig: {
        headerName: 'X-Forwarded-For',
        fallbackBehavior: 'NO_MATCH',
        position: 'FIRST',
      },
    },
  },
  visibilityConfig: {
    cloudWatchMetricsEnabled: true,
    metricName: 'AllowFromOffices',
    sampledRequestsEnabled: true,
  },
};
```

For CloudFront-scope web ACLs, skip forwarded-IP configuration on `X-Forwarded-For` — CloudFront inserts the client IP into a dedicated header (`CloudFront-Viewer-Address`) that is not attacker-spoofable because CloudFront strips/overrides client-supplied versions. Use the CloudFront-Viewer-Address header for origin-facing logic; use the WAF source IP (the actual TCP source CloudFront sees) for rate-based rules and IP sets.

## Geo match

`GeoMatchStatement` matches on ISO 3166 country codes (with optional region granularity depending on WAF support at the time — link to docs).

Use cases:

- Compliance-driven blocking (export control, sanctioned jurisdictions).
- Region-restricted content (licensing, distribution agreements).
- Detection signal combined with other rules (`labels-based` multi-stage — flag traffic from unusual origins and challenge it).

CloudFront distributions support a native geo-restriction feature that is billed separately from WAF. For simple blanket allowlist or blocklist Block behavior, distribution-level geo restriction is free of WAF WCU. WAF geo match is the right tool when you need Count, labels, CAPTCHA, Challenge, or composition with other statements. Decision:

- Simple "block country X at the edge, return 403" — distribution-level geo restriction on CloudFront.
- "From country X, issue a Challenge" or "if from country X AND path is /admin, block" — WAF geo match.

```typescript
import { CfnWebACL } from 'aws-cdk-lib/aws-wafv2';

const challengeUnusualGeo: CfnWebACL.RuleProperty = {
  name: 'ChallengeUnusualGeoOnLogin',
  priority: 25,
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
          notStatement: {
            statement: {
              geoMatchStatement: {
                countryCodes: ['US', 'CA', 'GB', 'DE', 'FR'],
              },
            },
          },
        },
      ],
    },
  },
  visibilityConfig: {
    cloudWatchMetricsEnabled: true,
    metricName: 'ChallengeUnusualGeoOnLogin',
    sampledRequestsEnabled: true,
  },
};
```

## JA3 and JA4 TLS fingerprints

JA3 and JA4 are TLS client hello fingerprints. They identify the client library or browser based on how it negotiates TLS — cipher suites, extensions, elliptic curves, ALPN values. Different libraries and browsers produce distinct fingerprints. Bots written on `curl`, `python-requests`, Go's `net/http`, headless browsers, and scraping frameworks each have identifiable fingerprints.

- JA3 is older. Still widely used. Based on TLS 1.2 hello structure. Less stable across TLS version changes.
- JA4 is newer. More stable across TLS 1.2 and TLS 1.3. Prefer JA4 for new rules.

AWS WAF exposes both as `FieldToMatch` options (`JA3Fingerprint`, `JA4Fingerprint`). Match with `ByteMatchStatement` or via a pattern set.

Use cases:

- Block specific known-bad scraper fingerprints.
- Aggregate rate-based rules by fingerprint instead of IP — one fingerprint per bot campaign, even across a rotating IP pool. See [rate-limiting.md](rate-limiting.md).
- Challenge traffic matching library fingerprints on user-facing endpoints.

```typescript
import { CfnWebACL } from 'aws-cdk-lib/aws-wafv2';

const blockKnownBadJa4: CfnWebACL.RuleProperty = {
  name: 'BlockKnownBadJa4',
  priority: 15,
  action: { block: {} },
  statement: {
    byteMatchStatement: {
      fieldToMatch: {
        ja4Fingerprint: { fallbackBehavior: 'NO_MATCH' },
      },
      positionalConstraint: 'EXACTLY',
      searchString: 't13d1516h2_8daaf6152771_b186095e22b6',
      textTransformations: [{ priority: 0, type: 'NONE' }],
    },
  },
  visibilityConfig: {
    cloudWatchMetricsEnabled: true,
    metricName: 'BlockKnownBadJa4',
    sampledRequestsEnabled: true,
  },
};
```

Keep a fingerprint allowlist for known-good browsers and let your inspection logic focus on outliers. Publish the fingerprint catalog your security team uses as a versioned artifact.

## ASN match

`AsnMatchStatement` (2025-06) matches on Autonomous System Numbers. Every IP belongs to an ASN — the ISP or cloud provider that announces the route.

Use cases:

- Block entire hosting providers that generate predominantly abusive traffic (OVH, Hetzner, certain bulletproof hosts). Most legitimate users do not originate from hosting ASNs.
- Allow verified crawler ASNs (Googlebot, Bingbot) before Bot Control rules run, so legitimate crawlers are not accidentally rate-limited.
- Combine with geo to catch AWS-hosted scrapers: "from US geo but not from a residential ASN, and not from an allowlisted cloud ASN." Scrapers running on AWS/GCP/Azure EC2/VMs show up here.

```typescript
import { CfnWebACL } from 'aws-cdk-lib/aws-wafv2';

const blockHostingAsns: CfnWebACL.RuleProperty = {
  name: 'BlockHostingAsnsExceptAllowlist',
  priority: 12,
  action: { block: {} },
  statement: {
    andStatement: {
      statements: [
        {
          asnMatchStatement: {
            asnList: [],
          },
        },
        {
          notStatement: {
            statement: {
              asnMatchStatement: {
                asnList: [],
              },
            },
          },
        },
      ],
    },
  },
  visibilityConfig: {
    cloudWatchMetricsEnabled: true,
    metricName: 'BlockHostingAsnsExceptAllowlist',
    sampledRequestsEnabled: true,
  },
};
```

Populate the ASN lists from published datasets (Cloudflare's radar, BGP views, verified-bot publishers) and maintain them like any other security feed.

## URI fragment match

The URI fragment (`#...` portion) is the piece of a URL after the hash. Browsers do not send it to servers; some clients and libraries do, and attackers occasionally use it to smuggle payloads past naive proxies and logs. WAF added fragment inspection in 2025-03.

Use cases are narrow. Treat fragment inspection as defense-in-depth rather than a primary detection surface. Where used, it typically pairs with other signals in an `AndStatement` — a fragment containing suspicious content is a weak signal alone but strong when combined with a suspicious method or path.

## Label-based multi-stage rules

Labels let you build complex AND logic across stages without duplicating inspection cost. The pattern:

1. A low-priority rule inspects the request for a single property and applies a label. Its action is `Count` so evaluation continues.
2. A higher-priority rule matches on that label via `LabelMatchStatement` plus any additional conditions, and takes a terminating action.

The benefit is decomposition. Each stage is a cheap statement targeting one field. The combined logic is a composition of labels, not a nested monolithic condition. Stages are individually observable in sampled requests and metrics.

```typescript
import { CfnWebACL } from 'aws-cdk-lib/aws-wafv2';

const labelLoginEndpoint: CfnWebACL.RuleProperty = {
  name: 'LabelLoginEndpoint',
  priority: 10,
  action: { count: {} },
  statement: {
    byteMatchStatement: {
      fieldToMatch: { uriPath: {} },
      positionalConstraint: 'STARTS_WITH',
      searchString: '/login',
      textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
    },
  },
  ruleLabels: [{ name: 'app:auth:login-endpoint' }],
  visibilityConfig: {
    cloudWatchMetricsEnabled: true,
    metricName: 'LabelLoginEndpoint',
    sampledRequestsEnabled: true,
  },
};

const rateLimitLogin: CfnWebACL.RuleProperty = {
  name: 'RateLimitLoginByLabel',
  priority: 60,
  action: { block: {} },
  statement: {
    rateBasedStatement: {
      aggregateKeyType: 'IP',
      limit: 100,
      scopeDownStatement: {
        labelMatchStatement: {
          scope: 'LABEL',
          key: 'app:auth:login-endpoint',
        },
      },
    },
  },
  visibilityConfig: {
    cloudWatchMetricsEnabled: true,
    metricName: 'RateLimitLoginByLabel',
    sampledRequestsEnabled: true,
  },
};
```

Every rule that emits labels is a reusable building block. Writing one "identify the login endpoint" rule lets you layer bot challenges, rate limits, geo checks, and logging onto that one signal.

## Body inspection

Body inspection is the most expensive inspection in WAF. The maximum inspectable body size is capped per the AWS WAF developer guide (different limits for CloudFront and regional scopes; link to docs). Above the cap, only the first N bytes are inspected — this is why payloads in the tail of a long body can evade body-inspecting rules.

`OversizeHandling` governs behavior when the body exceeds the limit:

- `CONTINUE` — inspect what fits, skip the rest.
- `MATCH` — treat oversized as a match. Useful when you want to block every oversized request outright.
- `NO_MATCH` — treat oversized as no match. Rarely the right choice for security rules.

Scope-down is mandatory for body-inspection rules. Applying `XssMatchStatement` on the body of every request costs far more WCU than applying it on POST requests to specific endpoints.

For JSON bodies, use `FieldToMatch.JsonBody` with a `MatchPattern` that targets the specific JSON path, rather than inspecting the full body as raw text. JSON-aware inspection is both cheaper and more accurate.

## Cookies and headers

Every modern WAF rule that targets auth, session, or tenancy signals reaches into cookies or custom headers.

- `FieldToMatch.SingleHeader { name }` — inspect one header by name. Cheap. Prefer when you know the field.
- `FieldToMatch.Headers` — inspect all headers with a `MatchPattern` (include / exclude specific names, or `All`). Specify `OversizeHandling` and `MatchScope`.
- `FieldToMatch.SingleCookie { name }` — inspect one cookie by name. Cheap.
- `FieldToMatch.Cookies` — inspect all cookies with a `MatchPattern`. Specify `OversizeHandling` and `MatchScope`.

`OversizeHandling` for headers and cookies defaults vary — always set explicitly. Forgotten oversize handling is a silent failure: rules pass on oversized fields when they should have matched, or vice versa.

`MatchScope` controls whether you match on keys, values, or both. Pick the narrowest that matches the signal.

## Anti-patterns

- **Writing regex where a string match works.** `^/admin` is a `STARTS_WITH`, not a regex.
- **Inspecting body on every request.** Scope down to the endpoints where body content matters.
- **Not using labels.** Duplicated inspection logic across rules is a smell. If two rules inspect the same field, collapse the first into a labeling stage.
- **Trusting `X-Forwarded-For` raw.** Attackers set it. Pin `Position` in `ForwardedIPConfig` or use CloudFront-provided headers.
- **Leaving `Position: ANY` or `FallbackBehavior` unset.** Explicit beats implicit.
- **Dropping regex into a single `RegexMatchStatement` instead of a pattern set.** One pattern in a set is fine; the moment you add a second related pattern, consolidate.
- **Writing custom rules before checking whether a managed rule group already covers the case.** Check first; custom is for gaps.
- **Naming rules opaquely.** Metric names show up in dashboards and alarms. `BlockAdminExceptTrustedOffices` is clear; `Rule27` is not.

## Related

- [web-acl-and-rules.md](web-acl-and-rules.md) — rule statement types, actions, priority, WCU
- [managed-rules.md](managed-rules.md) — managed rule groups that should precede custom rules
- [rate-limiting.md](rate-limiting.md) — rate-based rules with fingerprint / ASN aggregation keys
- [bot-control-and-fraud.md](bot-control-and-fraud.md) — Bot Control labels to combine with custom rules
- [ddos-resilience.md](ddos-resilience.md) — custom rate rules and scope-downs for L7 volumetric defense
- [troubleshooting.md](troubleshooting.md) — sampled requests, label inspection, false positive triage
- [../aws-cloudfront/SKILL.md](../aws-cloudfront/SKILL.md) — CloudFront-provided viewer headers that replace X-Forwarded-For
