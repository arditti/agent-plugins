# Bot Control and Fraud Prevention

AWS WAF ships three managed bot and fraud products: Bot Control for generic bot categorization, Account Takeover Prevention (ATP) for login abuse, and Account Creation Fraud Prevention (ACFP) for signup abuse. Use them in layers — Bot Control is the baseline across the site, ATP protects the login endpoint, ACFP protects the signup endpoint. Each has its own configuration surface, its own cost profile, and its own tuning loop. Combine with custom label-based rules for app-specific behavior, and front the entire stack with CloudFront so inspection happens at the edge before regional resources see the traffic.

## Contents

- [Bot Control levels](#bot-control-levels)
- [Challenge vs CAPTCHA](#challenge-vs-captcha)
- [SDK integration](#sdk-integration)
- [Bot Control rule group structure](#bot-control-rule-group-structure)
- [Verified bot allowlisting](#verified-bot-allowlisting)
- [AI Activity Dashboard](#ai-activity-dashboard)
- [AI bot monetization](#ai-bot-monetization)
- [Account Takeover Prevention (ATP)](#account-takeover-prevention-atp)
- [Account Creation Fraud Prevention (ACFP)](#account-creation-fraud-prevention-acfp)
- [Flat-rate tier gating](#flat-rate-tier-gating)
- [Tuning workflow](#tuning-workflow)
- [Common issues](#common-issues)
- [Composition with rate limiting](#composition-with-rate-limiting)
- [Positioning Bot Control alongside Shield Advanced](#positioning-bot-control-alongside-shield-advanced)
- [Privacy and compliance considerations](#privacy-and-compliance-considerations)
- [Migration paths](#migration-paths)
- [Related](#related)

## Bot Control levels

Bot Control is one managed rule group (`AWSManagedRulesBotControlRuleSet`) with two inspection levels selected via `ManagedRuleGroupConfigs.AWSManagedRulesBotControlRuleSet.InspectionLevel`.

**Common.** Fingerprint and signature-based detection. A catalog of verified bots — Google, Bing, OpenAI, Anthropic, and more than six hundred other verified bots — is maintained by AWS and updated continuously. Bot Control Common categorizes traffic into verified, unverified, known-malicious, and automation-framework buckets based on user-agent, JA3/JA4 fingerprint, ASN, and reverse-DNS verification. Good default for most sites.

**Targeted.** Adds behavioral analysis, machine-learning signals, device fingerprinting, and cross-request correlation. Detects sophisticated bots that spoof user agents, rotate fingerprints, and solve basic challenges. Use on high-value flows only:

- Login endpoints.
- Checkout and payment flows.
- Price or inventory scraping endpoints.
- Gift-card redemption or similar money-adjacent endpoints.
- Account data export or account enumeration endpoints.

Targeted is more expensive per request than Common — link to the AWS WAF pricing page for the current per-request fee. Scope-down is mandatory. Do not run Targeted across the entire site unless cost is explicitly justified by business risk.

Decision framework:

1. Start with Bot Control Common across the site.
2. Identify the handful of high-value endpoints where bot sophistication matters.
3. Add a second rule reference to `AWSManagedRulesBotControlRuleSet` with `InspectionLevel: TARGETED` and a `ScopeDownStatement` restricting it to those endpoints.

```typescript
import { CfnWebACL } from 'aws-cdk-lib/aws-wafv2';

const botControlCommon: CfnWebACL.RuleProperty = {
  name: 'BotControlCommon',
  priority: 40,
  overrideAction: { count: {} },
  statement: {
    managedRuleGroupStatement: {
      vendorName: 'AWS',
      name: 'AWSManagedRulesBotControlRuleSet',
      managedRuleGroupConfigs: [
        { awsManagedRulesBotControlRuleSet: { inspectionLevel: 'COMMON' } },
      ],
    },
  },
  visibilityConfig: {
    cloudWatchMetricsEnabled: true,
    metricName: 'BotControlCommon',
    sampledRequestsEnabled: true,
  },
};

const botControlTargeted: CfnWebACL.RuleProperty = {
  name: 'BotControlTargetedSensitive',
  priority: 45,
  overrideAction: { count: {} },
  statement: {
    managedRuleGroupStatement: {
      vendorName: 'AWS',
      name: 'AWSManagedRulesBotControlRuleSet',
      managedRuleGroupConfigs: [
        { awsManagedRulesBotControlRuleSet: { inspectionLevel: 'TARGETED' } },
      ],
      scopeDownStatement: {
        orStatement: {
          statements: [
            {
              byteMatchStatement: {
                fieldToMatch: { uriPath: {} },
                positionalConstraint: 'STARTS_WITH',
                searchString: '/login',
                textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
              },
            },
            {
              byteMatchStatement: {
                fieldToMatch: { uriPath: {} },
                positionalConstraint: 'STARTS_WITH',
                searchString: '/checkout',
                textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
              },
            },
            {
              byteMatchStatement: {
                fieldToMatch: { uriPath: {} },
                positionalConstraint: 'STARTS_WITH',
                searchString: '/api/price',
                textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
              },
            },
          ],
        },
      },
    },
  },
  visibilityConfig: {
    cloudWatchMetricsEnabled: true,
    metricName: 'BotControlTargetedSensitive',
    sampledRequestsEnabled: true,
  },
};
```

Note both rules start with `overrideAction: { count: {} }`. Promote to `NONE` only after tuning.

## Challenge vs CAPTCHA

Two interactive terminating actions; very different friction profiles.

**Challenge** is invisible. WAF issues a JavaScript challenge that the browser solves automatically — proof-of-browser, lightweight cryptographic work, fingerprint validation. On success, WAF issues a token. Subsequent requests carry the token (via the integration SDK or via a WAF-managed cookie) and flow through without re-challenging. Real users never see it. Headless bots without JS, or with naive JS evaluators, fail.

**CAPTCHA** is visible. The user must interact — typically a visual puzzle. Friction is high. Abandonment is real. Users fail sometimes. Accessibility concerns.

**Default to Challenge.** Use CAPTCHA only when:

- Challenge has been bypassed by adversary infrastructure on a specific flow (rare but happens; escalate to Targeted Bot Control first).
- The flow warrants explicit human presence — admin escalation, high-risk transactions, KYC-adjacent steps.
- Compliance or fraud policy explicitly requires CAPTCHA.

In a Bot Control rule group, override individual sub-rules to `Challenge` rather than `Block` for non-verified bot categories unless you are highly confident the category is malicious. Challenge gives false-positives a way out; Block does not.

## SDK integration

Without the SDK, Challenge actions cost one interstitial per challenged request boundary. With the SDK, one token acquisition covers many downstream API calls.

**JavaScript SDK.** For single-page apps and traditional web pages. Ships a small script from AWS-hosted CDN. The SDK:

1. Fetches a challenge token from a WAF token-acquisition endpoint on first page load.
2. Caches the token (in memory, and via a WAF cookie managed by the SDK).
3. Attaches the token to outbound requests via the `x-aws-waf-token` header or via the cookie, depending on integration mode.
4. Refreshes tokens before they expire.

Without the SDK, every API call that hits a Challenge-protected rule triggers a new interstitial, breaking SPA flows. With the SDK, the SPA acquires a token once, attaches it to every fetch, and API calls pass through.

**Mobile SDK.** iOS and Android. Same pattern, native implementation. The mobile SDK handles token acquisition and attaches the token to API calls made by the app. Without the mobile SDK, native apps cannot satisfy Challenge on API endpoints.

**Token domain list.** Configure on the web ACL (`ChallengeConfig.ImmunityTimeProperty`, `TokenDomains`). Lists the domains where the token is valid. Must include every domain that will present the token:

- The apex domain (`example.com`).
- `www.example.com` if used.
- CloudFront CNAMEs used as aliases.
- API subdomains (`api.example.com`).

Misconfigured token domain list is the single most common Challenge/Bot-Control integration failure. Tokens acquired on `www.example.com` get rejected when submitted to `api.example.com` if `api.example.com` is not in the domain list. Every rejected token triggers a fresh challenge, producing challenge loops.

**Integration checklist.**

1. Install the JS SDK in the document head of every page, or integrate the mobile SDK into the app.
2. Configure the token acquisition endpoint — the AWS WAF-provided URL for your distribution.
3. Set the token domain list on the web ACL to include every domain that will present tokens.
4. Test in browser devtools: confirm the `x-aws-waf-token` header (or the SDK's cookie) is present on requests to protected endpoints. Confirm challenge interstitials do not appear on SPA navigations after initial token acquisition.
5. Deploy Challenge rules in Count first (see [Tuning workflow](#tuning-workflow)).

## Bot Control rule group structure

Bot Control's rule group contains sub-rules each targeting a bot category or signal. Representative categories:

- **Verified bots** — `CategoryVerifiedSearchBot`, `CategoryVerifiedSocialMediaBot`, etc. Bots auto-verified via reverse DNS lookup and ASN allowlisting.
- **Unverified categories** — `CategoryHttpLibrary`, `CategoryScrapingFramework`, `CategoryMonitoring`, `CategoryAdvertising`. Traffic identified as bot-like by signature but not auto-verified.
- **Malicious categories** — `CategoryAI` (where not verified), `CategorySeo` (for aggressive SEO scrapers), and other known-bad categories.
- **Signals** — `SignalNonBrowserUserAgent`, `SignalAutomatedBrowser`, `SignalKnownBotDataCenter`. Individual evidence signals that fire even when category attribution is ambiguous.

Every sub-rule can be overridden individually via `RuleActionOverrides` on the managed rule group statement. This is the mechanism for "let Googlebot through but block other crawlers" — override the verified search bot sub-rule to `Allow` (or leave it at its default which typically already allows verified bots), and keep other category rules at `Block` or `Challenge`.

```typescript
import { CfnWebACL } from 'aws-cdk-lib/aws-wafv2';

const botControlWithOverrides: CfnWebACL.RuleProperty = {
  name: 'BotControlWithOverrides',
  priority: 40,
  overrideAction: { none: {} },
  statement: {
    managedRuleGroupStatement: {
      vendorName: 'AWS',
      name: 'AWSManagedRulesBotControlRuleSet',
      managedRuleGroupConfigs: [
        { awsManagedRulesBotControlRuleSet: { inspectionLevel: 'COMMON' } },
      ],
      ruleActionOverrides: [
        { name: 'CategoryHttpLibrary', actionToUse: { challenge: {} } },
        { name: 'CategoryMonitoring', actionToUse: { count: {} } },
        { name: 'SignalNonBrowserUserAgent', actionToUse: { challenge: {} } },
      ],
    },
  },
  visibilityConfig: {
    cloudWatchMetricsEnabled: true,
    metricName: 'BotControlWithOverrides',
    sampledRequestsEnabled: true,
  },
};
```

Labels emitted by Bot Control (`awswaf:managed:aws:bot-control:...`) are available to downstream rules for label-based multi-stage logic. See [custom-rules-and-regex.md](custom-rules-and-regex.md) for label patterns.

## Verified bot allowlisting

Bot Control verifies legitimate crawlers via reverse DNS lookup and ASN matching. Googlebot is verified not by the `User-Agent: Googlebot` string (attackers send that too), but by the combination of reverse DNS resolving to a `googlebot.com` domain and originating from a Google-owned ASN. The same applies to Bingbot, DuckDuckBot, and the growing list of verified AI crawlers.

**Never allowlist verified bots by User-Agent string.** Bots lie. User-Agent is a suggestion, not a proof. Allow by Bot Control's verification (which does the DNS/ASN check) or by direct ASN match against published crawler ASN lists.

The `CategoryVerifiedSearchBot` sub-rule default action typically allows verified search bots through Bot Control. If you have other rules upstream that might block them (a hostile geo rule, a restrictive rate rule), allowlist verified bots explicitly via a low-priority Allow rule that matches on the Bot Control label.

## AI Activity Dashboard

AWS WAF AI Activity Dashboard (2026-02) surfaces AI crawler traffic patterns across the 650+ verified bot catalog. Per-vendor traffic volumes, endpoint distribution, token usage patterns. Visibility into which AI companies are crawling your content.

Availability is tiered:

- Visibility at all Bot Control tiers (subject to current tier definitions — link to [../aws-cloudfront/references/pricing-and-plans.md](../aws-cloudfront/references/pricing-and-plans.md)).
- Enforcement actions are tier-gated. Higher tiers unlock per-vendor policy enforcement.

Use cases:

- Understand which AI vendors are crawling and how heavily.
- Set per-vendor allow, challenge, or block policies.
- Monetize AI crawler access via x402 — see [AI bot monetization](#ai-bot-monetization) and [../aws-cloudfront/references/agentic-patterns.md](../aws-cloudfront/references/agentic-patterns.md).
- Inform robots.txt policy with actual behavior data.

The dashboard is not a rule; it is visibility. Rules that act on AI crawler traffic are written as standard Bot Control sub-rule overrides or as custom rules matching on Bot Control labels.

## AI bot monetization

Compose Bot Control's AI vendor identification with CloudFront's x402 payment verification. AI bots that identify as verified crawlers can be offered a paywall via x402 — CloudFront validates payment, and the request flows through to origin. Unpaid AI bots receive a 402 Payment Required response with payment instructions.

Positioning:

- Bot Control identifies and attributes the AI vendor.
- CloudFront's x402 handler validates payment.
- WAF enforces access based on verified-and-paid status.

See [../aws-cloudfront/references/agentic-patterns.md](../aws-cloudfront/references/agentic-patterns.md) for x402 patterns and CloudFront configuration. The exact configuration surface will evolve as AWS releases primitives. Recommend customers start with visibility (AI Activity Dashboard), then move to selective challenge/block policies, then move to monetization when x402 integration matures.

## Account Takeover Prevention (ATP)

`AWSManagedRulesATPRuleSet` protects login endpoints. Threats it detects:

- **Credential stuffing.** Attackers replay username/password pairs from leaked dumps against your login endpoint.
- **Compromised credentials.** Usernames or passwords that appear in AWS's dataset of publicly leaked credentials.
- **Volumetric login abuse.** Anomalous login attempt rates per IP, per session, per fingerprint.
- **Behavioral anomalies.** ATP correlates login patterns across requests.

**Configuration is mandatory.** Unlike generic managed rule groups, ATP needs to be told:

- Which endpoint is the login — URI path and HTTP method.
- Which fields carry username and password — request field specifications (typically JSON body pointers).
- How success and failure are signaled in the response — response inspection configuration.

Response inspection is the piece most often misconfigured. ATP has to distinguish successful logins from failed ones to build its behavioral model. Supply at least one of:

- **Status code inspection.** Which HTTP status codes indicate success, which indicate failure.
- **Header match.** A specific response header indicating auth result.
- **Body contains.** A string in the response body indicating result (often easiest — `"success":true` or similar).
- **JSON body.** A JSON path that evaluates to a specific value.

Without response inspection, ATP cannot attribute attempts. The rule group will emit some signals but cannot build the full behavioral picture.

```typescript
import { CfnWebACL } from 'aws-cdk-lib/aws-wafv2';

const atp: CfnWebACL.RuleProperty = {
  name: 'AccountTakeoverPrevention',
  priority: 35,
  overrideAction: { count: {} },
  statement: {
    managedRuleGroupStatement: {
      vendorName: 'AWS',
      name: 'AWSManagedRulesATPRuleSet',
      managedRuleGroupConfigs: [
        {
          awsManagedRulesAtpRuleSet: {
            loginPath: '/api/auth/login',
            requestInspection: {
              payloadType: 'JSON',
              usernameField: { identifier: '/email' },
              passwordField: { identifier: '/password' },
            },
            responseInspection: {
              bodyContains: {
                successStrings: ['"status":"ok"'],
                failureStrings: ['"error":"invalid_credentials"'],
              },
            },
          },
        },
      ],
    },
  },
  visibilityConfig: {
    cloudWatchMetricsEnabled: true,
    metricName: 'AccountTakeoverPrevention',
    sampledRequestsEnabled: true,
  },
};
```

## Account Creation Fraud Prevention (ACFP)

`AWSManagedRulesACFPRuleSet` protects signup endpoints. Threats:

- **Bulk account creation.** Bot-driven creation of many accounts at once.
- **Disposable / throwaway emails.** Signups using disposable email services.
- **Identity farming.** Slower-paced creation with rotated identities intended to mature accounts for later abuse.
- **Bot-driven signups.** Automation signatures on the signup flow.

Configuration mirrors ATP: signup path, HTTP method, request field specifications (email, username, password, address fields as applicable), response inspection.

Same rule: response inspection is mandatory. Same rule: deploy in Count first.

## Flat-rate tier gating

Bot Control, ATP, and ACFP features are gated by CloudFront's flat-rate tier. Tier boundaries shift as AWS updates the offering.

Representative layout at the time of writing (always confirm against current pricing):

- **Pro tier.** AI Activity Dashboard visibility. Bot Control Common visibility. Limited enforcement.
- **Business tier and above.** Bot Control Targeted. ATP and ACFP full features. Full enforcement across all tiers.

Always link to [../aws-cloudfront/references/pricing-and-plans.md](../aws-cloudfront/references/pricing-and-plans.md) for the current tier matrix. Do not quote specific tier feature mappings without verifying them; AWS updates these.

Design implication: if a customer is on a lower tier, Bot Control Targeted and ATP enforcement are unavailable. Scope the initial design to what the tier supports, and use the gap as the justification for a tier upgrade conversation with the customer's sales team.

## Tuning workflow

Same pattern as the generic managed rule group tuning workflow — Count first, observe, tune, promote. With one addition: validate SDK integration before promoting.

1. Deploy Bot Control (Common and Targeted where scoped), ATP, ACFP all with `OverrideAction: COUNT`.
2. Install the JS / Mobile SDK. Configure token domain list. Verify in devtools.
3. Run one full traffic cycle (24–72 hours, longer for weekly-rhythmic traffic).
4. Inspect sampled requests and labels. For each sub-rule that matched:
   - True positive (real bot / real abuse): leave as-is.
   - False positive (legitimate traffic): per-rule override to Count, or refine scope-down.
5. Verify verified-bot traffic (Googlebot, Bingbot, etc.) is passing — if Count-mode ATP or ACFP are incorrectly flagging verified bots, investigate upstream.
6. Promote from `COUNT` to `NONE` group-level. Keep per-rule overrides as needed.
7. Keep watching. Bot ecosystems shift; re-tune on a regular cadence.

## Common issues

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Challenge token not attached to requests | JS/Mobile SDK not installed correctly | Verify SDK in devtools; confirm `x-aws-waf-token` header on protected endpoints |
| Challenge loops — users repeatedly see interstitial | Token domain list too narrow or misconfigured | Add all domains (apex, www, API subdomains, CloudFront CNAMEs) to `TokenDomains` |
| Verified bot blocked (Googlebot, Bingbot) | Bot Control sub-rule action too strict, or upstream rule blocking | Per-rule override to Allow on `CategoryVerifiedSearchBot`; add explicit low-priority Allow rule matching Bot Control verified-bot label |
| ATP not firing on obvious credential stuffing | Response inspection configuration missing or wrong | Verify `responseInspection` block; confirm success/failure strings match actual response bodies |
| ACFP false-positives on legitimate bulk imports | Rule group not scoped to real signup endpoint | Add `scopeDownStatement` to limit ACFP to signup endpoint only |
| Bot Control Targeted cost spike | Targeted running on too-broad scope | Add `scopeDownStatement` limiting Targeted to handful of sensitive endpoints |
| AI Activity Dashboard empty | Wrong tier or Bot Control not deployed | Verify tier (see [pricing-and-plans.md](pricing-and-plans.md)); verify Bot Control rule group is attached and enabled |
| Mobile app broken after enabling Challenge | Mobile SDK not integrated | Integrate iOS/Android SDK; without it, mobile cannot satisfy Challenge |
| Legitimate third-party integrations blocked | Partner traffic classified as automation | Allowlist partner traffic by JA4 fingerprint or by pre-shared header, add Allow rule at priority lower than Bot Control |
| Rate spikes from challenged traffic | Challenge interstitials triggering on API calls because SDK is not present or token expired | Install SDK; widen token TTL via `ChallengeConfig.ImmunityTimeProperty` after validating threat model |

## Composition with rate limiting

Bot Control and rate-based rules compose naturally via labels. Bot Control labels traffic (e.g., `awswaf:managed:aws:bot-control:bot:category:http_library`); a rate-based rule scopes down to that label and applies a volumetric threshold. Result: "HTTP-library-identified traffic is rate-limited at one threshold; everyone else flows freely." See [rate-limiting.md](rate-limiting.md) for rate rule patterns including aggregation by JA4 fingerprint or ASN — often a stronger signal than IP for bot campaigns.

Rate rules on their own cannot distinguish a burst of legitimate users from a burst of bots. Bot Control on its own cannot distinguish one bot hitting once from one bot hitting ten thousand times. Compose both.

## Positioning Bot Control alongside Shield Advanced

Bot Control is a request-layer tool. Shield Advanced (see [ddos-resilience.md](ddos-resilience.md)) is an infrastructure-layer tool that provides L3/L4 DDoS mitigation, advanced L7 protection, and access to the Shield Response Team. The two are complementary:

- Bot Control classifies and labels bot traffic per request.
- Shield Advanced protects the infrastructure against volumetric attack, including volumetric L7 attacks that Bot Control alone cannot absorb.

Recommend both for customers with brand-risk profiles (financial services, retail during peak, high-profile consumer apps, public-sector targets). Bot Control answers "what is this traffic?"; Shield Advanced answers "can we absorb the surge?".

## Privacy and compliance considerations

Bot Control and ATP/ACFP inspect request and response content. ATP specifically handles username/password fields and response signals that indicate auth success or failure. Treat the configuration as sensitive:

- `usernameField` and `passwordField` paths in ATP configuration are operational metadata, not secrets, but their presence reveals your login request shape. Keep IaC in your standard security-sensitive repo.
- Response inspection configurations may disclose how your backend signals auth outcomes. Same handling.
- Log redaction applies to WAF logs — configure `RedactedFields` on `CfnLoggingConfiguration` to strip password fields from logs. Link to the AWS WAF developer guide for the redaction field shape.
- Under GDPR / CCPA / similar frameworks, WAF metadata (IP, fingerprint, geo, ASN) is personal data. Retention policy on WAF logs should align with the broader personal-data retention policy. S3 lifecycle rules or CloudWatch Logs retention handle the mechanics.
- AI Activity Dashboard aggregates crawler traffic; the aggregates are not personal data but the underlying sampled requests are. Handle both tiers distinctly.

Do not log request bodies wholesale. ATP inspects body fields by path; WAF logs do not have to carry the full body. Configure redaction before enabling Block actions.

## Migration paths

For customers transitioning from third-party bot management products (Akamai Bot Manager, Cloudflare Bot Management, PerimeterX, DataDome) to AWS Bot Control:

1. Map the third-party product's detection categories to Bot Control sub-rules. The taxonomies are different but overlapping — verified bots, automation frameworks, headless browsers, known-malicious bots.
2. Run AWS Bot Control alongside the existing product in `COUNT` mode initially. Compare classification and Block rates over a full traffic cycle.
3. Identify gaps where the third-party product catches traffic Bot Control does not, and vice versa. Close the gaps with custom rules, Bot Control overrides, or ASN/fingerprint custom rules.
4. Switch Bot Control to `NONE` for the sub-rules where confidence matches, disable the third-party product progressively.
5. Retain the third-party product only for capabilities Bot Control does not match (if any). Most customers complete the migration without ongoing third-party dependency.

For customers transitioning from custom rate-rule-only bot defense to Bot Control: start with Bot Control Common in `COUNT`, layer Targeted on sensitive endpoints, and revisit the rate rules — many can be simplified or removed once Bot Control's classification runs upstream.

## Related

- [web-acl-and-rules.md](web-acl-and-rules.md) — rule priority, action semantics, labels as cross-rule plumbing
- [managed-rules.md](managed-rules.md) — Bot Control alongside other managed rule groups
- [custom-rules-and-regex.md](custom-rules-and-regex.md) — label matching and fingerprint-based custom rules
- [rate-limiting.md](rate-limiting.md) — rate rules with fingerprint / ASN aggregation, complement to Bot Control
- [ddos-resilience.md](ddos-resilience.md) — bot defense in a DDoS context
- [pricing-and-plans.md](pricing-and-plans.md) — Bot Control, ATP, ACFP cost model
- [troubleshooting.md](troubleshooting.md) — sampled requests and label triage
- [../aws-cloudfront/references/agentic-patterns.md](../aws-cloudfront/references/agentic-patterns.md) — x402, AI crawler monetization patterns
- [../aws-cloudfront/references/pricing-and-plans.md](../aws-cloudfront/references/pricing-and-plans.md) — flat-rate tier feature gating
- [../aws-cloudfront/SKILL.md](../aws-cloudfront/SKILL.md) — CloudFront fronting as the default deployment shape
