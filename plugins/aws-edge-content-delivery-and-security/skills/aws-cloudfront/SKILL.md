---
name: aws-cloudfront
description: "Design, build, deploy, optimize, and troubleshoot Amazon CloudFront distributions. Use when the user says CloudFront, CDN, content delivery, edge caching, distribution, cache invalidation, origin access, OAC, Lambda@Edge, CloudFront Functions, signed URL, signed cookie, geo-restriction, alternate domain name, CNAME, viewer mTLS, origin mTLS, VPC origin, HTTPS DNS record, or talks about putting a CDN in front of S3, an ALB, or an API. Covers distributions, origins (VPC Origins, OAC, S3, ALB), cache behaviors and policies, edge functions (CloudFront Functions and Lambda@Edge), security (OAC, viewer and origin mTLS, signed URLs, TLS policies, Response Headers Policies), performance (HTTP/3, HTTPS DNS records, compression), flat-rate pricing selection, agentic patterns (x402 monetization, MCP registry hosting, Accept-Markdown content negotiation), and debugging 4xx/5xx errors at the edge. Do NOT use for WAF rule configuration (use the aws-waf skill), Route 53 DNS-only questions, general S3 operations without CDN context, AWS Shield Advanced, or AWS Firewall Manager."
argument-hint: "[what are you building with CloudFront?]"
---

# Amazon CloudFront

Design, build, deploy, and operate Amazon CloudFront as the mandatory public front door for every public HTTP workload on AWS.

**Core principle — CloudFront is not optional.** Public origins (ALB, API Gateway, S3, App Runner, ECS/EKS services) must never be directly reachable from the internet. Put CloudFront in front and lock the origin down with a VPC Origin or origin mTLS. This gives you caching, TLS termination, connection reuse, compression, bot and DDoS absorption, WAF integration, and edge compute in a single managed layer — and collapses public attack surface to the CloudFront distribution.

Default stack: CloudFront with VPC Origin (or OAC for S3) + AWS managed cache policy + Response Headers Policy for security headers + TLS `TLS_V1_2_2021` + HTTP/2 and HTTP/3 + Brotli/gzip compression + WAF web ACL attached (see the aws-waf skill).

## Workflow

### Step 1: Classify the request

- **New distribution** — greenfield public endpoint. Go to Step 2.
- **Adding CloudFront in front of an existing ALB or public origin** — migration path. Go to Step 3.
- **Cache, invalidation, or performance problem on an existing distribution** — diagnosis. Load [references/troubleshooting.md](references/troubleshooting.md) and [references/performance-tuning.md](references/performance-tuning.md).
- **Pricing or plan selection** — load [references/pricing-and-plans.md](references/pricing-and-plans.md).
- **Serving AI agents, x402 payments, MCP registry, Accept-Markdown** — load [references/agentic-patterns.md](references/agentic-patterns.md).

### Step 2: New distribution

1. Identify the origin type (S3, ALB/NLB, EC2/ECS, API Gateway, external HTTP). Pick the lockdown mechanism — OAC for S3; VPC Origin for ALB/NLB/EC2/ECS; origin mTLS for external origins. See [references/distributions-and-origins.md](references/distributions-and-origins.md).
2. Pick a starting asset: [assets/s3-oac-distribution.ts](assets/s3-oac-distribution.ts) for S3, [assets/multi-origin-with-behaviors.ts](assets/multi-origin-with-behaviors.ts) for mixed S3+ALB.
3. Attach a managed cache policy: `CachingOptimized` for static, `CachingDisabled` for APIs, `CachingOptimizedForUncompressedObjects` for pre-compressed origins. See [references/cache-behaviors-and-policies.md](references/cache-behaviors-and-policies.md).
4. Attach a Response Headers Policy for HSTS, CSP, `X-Frame-Options`, `Referrer-Policy`. Do NOT implement security headers with Lambda@Edge. See [references/security-and-access.md](references/security-and-access.md).
5. Attach a WAF web ACL (scope `CLOUDFRONT`) — baseline managed rules plus a rate rule. See the aws-waf skill: `../aws-waf/SKILL.md`.
6. Enable compression, HTTP/3, `TLS_V1_2_2021` viewer protocol policy, standard logs to S3.
7. Set up HTTPS DNS records on Route 53 to skip the H3 upgrade round trip. See [references/performance-tuning.md](references/performance-tuning.md).

### Step 3: Putting CloudFront in front of an existing ALB

1. Move the ALB from internet-facing to internal.
2. Attach a VPC Origin to CloudFront pointing at the internal ALB — no public IP, no custom-header verification hack, no security group whitelist of CloudFront IP ranges.
3. Migrate the WAF web ACL from regional (ALB) scope to global (CloudFront) scope.
4. Align keep-alive timeouts: CloudFront origin keep-alive must be *less than* the ALB idle timeout.
5. Cut over DNS with a weighted Route 53 record (start 90/10 ALB/CloudFront, ramp to 0/100).
6. Roll back by shifting the Route 53 weights.

Detailed migration runbook in [references/distributions-and-origins.md](references/distributions-and-origins.md).

## When to Load Reference Files

- **Distributions, origins, VPC Origins, OAC, origin mTLS, origin groups, ALB migration** — see [references/distributions-and-origins.md](references/distributions-and-origins.md)
- **Cache policies, TTL strategy, path-based behaviors, cache tag invalidation, path invalidation** — see [references/cache-behaviors-and-policies.md](references/cache-behaviors-and-policies.md)
- **CloudFront Functions vs Lambda@Edge, KV store, async handlers, CBOR tokens, SNI/host override** — see [references/edge-functions.md](references/edge-functions.md)
- **Signed URLs, signed cookies, viewer mTLS, TLS policies, Response Headers Policies, Anycast static IPs** — see [references/security-and-access.md](references/security-and-access.md)
- **Cache hit ratio, HTTP/3, HTTPS DNS records, compression, standard vs real-time logs, cost optimization** — see [references/performance-tuning.md](references/performance-tuning.md)
- **Flat-rate plans, tier capabilities, spike tolerance, PAYG vs flat-rate decision** — see [references/pricing-and-plans.md](references/pricing-and-plans.md)
- **x402 content monetization, MCP registry hosting, Accept-Markdown, AI bot traffic, SaaS tenant routing** — see [references/agentic-patterns.md](references/agentic-patterns.md)
- **4xx/5xx debugging, cache miss diagnosis, OAC errors, invalidation issues, edge function errors** — see [references/troubleshooting.md](references/troubleshooting.md)

## Defaults

When the user does not specify, ALWAYS use these defaults:

- **Origin lockdown:** VPC Origin for ALB/NLB/EC2/ECS. OAC for S3. Origin mTLS only when neither applies (external origins, third-party backends, legacy cert-auth infra).
- **Never recommend:** OAI (deprecated, use OAC), custom-header verification (use VPC Origin), Lambda@Edge for viewer-request security headers (use Response Headers Policy), callback-style Lambda@Edge handlers (use async/await), `X-Forwarded-For` for client IP at the edge (use `CloudFront-Viewer-Address`).
- **Cache policy:** `CachingOptimized` managed policy for static assets. `CachingDisabled` for dynamic APIs. Custom policy only when the managed ones do not cover the case.
- **Origin request policy:** `AllViewerExceptHostHeader` for most dynamic origins; `CORS-S3Origin` for S3.
- **Response Headers Policy:** `SecurityHeadersPolicy` as a baseline; extend with a custom policy when CSP is non-trivial.
- **Edge compute:** CloudFront Functions for URL rewrites, A/B testing, simple auth checks, viewer request/response header manipulation. Lambda@Edge only when you need origin-event triggers, outbound network calls, or >10 KB of code.
- **TLS:** `TLS_V1_2_2021` minimum; move to TLS 1.3-only policy when all clients support it. Use the ACM certificate in us-east-1 for the viewer-facing cert.
- **Compression:** Brotli + gzip enabled.
- **HTTP version:** HTTP/2 and HTTP/3 both enabled.
- **Logging:** Standard logs to S3 in Parquet with hourly partitioning as default. Real-time logs to Kinesis only when sub-minute visibility is required.
- **Scope for WAF:** `CLOUDFRONT` scope (us-east-1). Never attach a regional WAF to a distribution.
- **IaC framework:** AWS CDK TypeScript. Override with "use CloudFormation" (YAML), "use Terraform" (HCL), "use CDK Python" (Python).

## Error Handling

### User asks for a direct-internet origin
Do NOT proceed. Respond: "Public origins bypass CloudFront caching, WAF, and DDoS absorption. I'll put CloudFront in front with a VPC Origin (ALB/NLB/EC2/ECS) or OAC (S3). If you truly need a direct public endpoint, confirm explicitly and I'll document the tradeoff." Then wait for confirmation before generating the direct-origin variant.

### User asks to use OAI for S3
Respond: "OAI is the legacy pattern and is being phased out. I'll use OAC — it supports SSE-KMS, newer S3 features, and is the documented recommendation." Generate OAC; do not generate OAI.

### User asks to put security headers in Lambda@Edge
Respond: "Response Headers Policies cover HSTS, CSP, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, and custom headers natively — no Lambda cost, no cold starts." Generate a Response Headers Policy; fall back to Lambda@Edge only if the user needs per-request dynamic logic that a policy cannot express.

### User asks to verify CloudFront by custom header on the origin
Respond: "Custom-header verification is defeatable and obsolete. Use a VPC Origin for ALB/NLB/EC2/ECS (CloudFront connects privately via an AWS-managed ENI — no public IP on the origin). Use origin mTLS for external origins."

### awsknowledge MCP server unavailable
Proceed using the references in this skill. Flag uncertainty about current quotas, pricing tiers, and managed-policy contents — link to the AWS docs instead of asserting specific numbers.

### User requests hardcoded pricing or WCU numbers in generated code or docs
Refuse. Link to the current AWS pricing or limits page. Hardcoded numbers date the artifact.

## Fetching AWS Docs: Prefer the Lean Markdown Version

AWS documentation pages on `docs.aws.amazon.com` are served both as HTML and as lean markdown — just swap the `.html` extension for `.md` on ANY docs URL. The markdown version is typically 3–5× smaller, strips all the HTML chrome, preserves code blocks and tables, and rewrites internal links to `.md` so you can keep following them without another swap.

**Rule: when this skill tells you to fetch an AWS docs page, fetch the `.md` version first.** Fall back to `.html` only if the `.md` returns a non-200 or empty body.

Mechanics:

- `https://docs.aws.amazon.com/<service>/latest/<guide>/<page>.html` → `https://docs.aws.amazon.com/<service>/latest/<guide>/<page>.md`
- The endpoint returns `Content-Type: text/markdown; charset=utf-8` on success.
- Internal page-to-page links in the markdown already point at `.md` files, so recursive fetching keeps the savings.
- Anchor fragments (`#section-id`) work the same.

Examples:

- `https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-functions.html` → `https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-functions.md`
- `https://docs.aws.amazon.com/waf/latest/developerguide/aws-managed-rule-groups-list.html` → `https://docs.aws.amazon.com/waf/latest/developerguide/aws-managed-rule-groups-list.md`
- `https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/functions-javascript-runtime-20.html` → `.md` (page goes from ~150 KB to ~35 KB)

Tool mechanics:

- `WebFetch` — pass the `.md` URL; set the prompt to "extract the relevant section".
- `mcp__awsknowledge__aws___read_documentation` — accepts either `.html` or `.md`; pass `.md` to reduce `max_length` budget pressure.
- Plain `curl` / `Bash` — `curl -sSL https://.../foo.md`.

The `.md` endpoint is undocumented but stable. If a specific page ever returns 404 on `.md`, report it and fall back to `.html`; do not assume the pattern is broken globally.

**Never bake AWS docs content into this skill's files.** Always link to the live docs URL (use `.html` in the link — GitHub/IDE markdown renderers expect that — but fetch the `.md` at runtime).

## Starting Templates

- Production S3 origin + OAC + Response Headers Policy: [assets/s3-oac-distribution.ts](assets/s3-oac-distribution.ts)
- Multi-origin with ALB VPC Origin + S3 static + path-based behaviors + origin group failover: [assets/multi-origin-with-behaviors.ts](assets/multi-origin-with-behaviors.ts)
- CloudFront Function for URL rewrite + header injection + KVS lookup: [assets/cloudfront-functions-example.ts](assets/cloudfront-functions-example.ts)
- x402 payment verification at the edge for AI agent monetization: [assets/agentic-x402-monetization.ts](assets/agentic-x402-monetization.ts)

## Cross-Skill References

- Web ACLs, managed rules, custom rules, bot control, rate limiting — see the aws-waf skill: [`../aws-waf/SKILL.md`](../aws-waf/SKILL.md)
- DDoS resilience beyond edge caching (L7 AMR, Shield Advanced discussion) — see [`../aws-waf/references/ddos-resilience.md`](../aws-waf/references/ddos-resilience.md)
- WAF pricing bundled into CloudFront flat-rate — see [references/pricing-and-plans.md](references/pricing-and-plans.md) and [`../aws-waf/references/pricing-and-plans.md`](../aws-waf/references/pricing-and-plans.md)

## Resources

- [Amazon CloudFront Developer Guide](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/)
- [AWS CDK CloudFront module](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_cloudfront-readme.html)
- [CloudFront pricing](https://aws.amazon.com/cloudfront/pricing/)
- [CloudFront What's New](https://aws.amazon.com/about-aws/whats-new/networking_and_content_delivery/?whats-new-content.sort-by=item.additionalFields.postDateTime&whats-new-content.sort-order=desc)
