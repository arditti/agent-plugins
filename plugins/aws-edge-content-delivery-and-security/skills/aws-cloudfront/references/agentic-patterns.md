# Agentic Patterns on CloudFront

CloudFront plus AWS WAF is the natural front door for AI-agent and autonomous-workload traffic. Caching absorbs repeat requests at the edge. WAF classifies bots and rate-limits distributed crawler fleets. CloudFront Functions run content negotiation and routing logic at the edge with no cold start. CloudFront KV Store enables per-tenant routing without origin round trips. Put CloudFront in front of every agent-facing endpoint: public API, MCP registry, content catalog, SaaS control plane. The economics, security, and performance properties all favor edge-first architectures for agent traffic.

## Contents

- [Why the edge is the right layer for agent traffic](#why-the-edge-is-the-right-layer-for-agent-traffic)
- [x402 content monetization](#x402-content-monetization)
- [Private MCP registry hosting](#private-mcp-registry-hosting)
- [Accept-Markdown content negotiation](#accept-markdown-content-negotiation)
- [AI bot visibility and monetization](#ai-bot-visibility-and-monetization)
- [SaaS tenant routing with CloudFront Functions and KVS](#saas-tenant-routing-with-cloudfront-functions-and-kvs)
- [Rate-limiting AI crawlers](#rate-limiting-ai-crawlers)
- [Agent observability at the edge](#agent-observability-at-the-edge)
- [Related](#related)

## Why the edge is the right layer for agent traffic

Agent traffic has three properties that make edge-first architecture obviously correct:

1. **Bursty fan-out.** An agent orchestrating 100 parallel tool calls generates 100 near-simultaneous requests. Origin capacity planning against worst-case fan-out is wasteful. Edge caching absorbs the burst — the first request warms the cache, the remaining 99 are hits.
2. **Duplicate work across agents.** Many agents, at many IPs, operated by many vendors, all fetching the same content (same docs, same schemas, same OpenAPI specs, same product listings). The edge deduplicates automatically — every viewer shares the same POP cache.
3. **Divergent content needs.** Human browsers need HTML. AI agents benefit from Markdown, JSON, or structured schemas. Content-negotiation at the origin means every request touches origin compute. Content-negotiation at the edge via CloudFront Functions costs nothing per request and does not warm the origin.

Put differently: origin-first architecture punishes agent workloads. Edge-first architecture rewards them.

## x402 content monetization

x402 (HTTP 402 Payment Required) is the emerging pattern for monetizing content access by AI agents. Originally defined in HTTP but underused, it is now the standard for micropayment-gated content intended for machine consumption.

### The flow

1. Agent sends request to `https://api.example.com/article/123`.
2. CloudFront evaluates WAF rules. A custom rule checks for presence of `Authorization: Bearer <token>` or `X-402-Payment: <signed-token>`.
3. If the payment token is absent or invalid, respond `402 Payment Required` with a body or response headers advertising the price, wallet address, and payment instructions.
4. If valid, CloudFront forwards to origin (or serves from cache).

### Implementation layers

| Verification complexity | Where it runs |
|---|---|
| Header presence check | WAF custom rule |
| Token signature verification (HMAC, RSA) | CloudFront Function at viewer-request |
| Token requires outbound HTTP to an issuer | Lambda@Edge at viewer-request (with caching of issuer responses) |

The preference order is **WAF custom rule → CFF → L@E**. Walk down the list only when the simpler layer cannot express the check.

### Minimal CDK + CFF skeleton

```typescript
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';

const paymentCheck = new cloudfront.Function(this, 'PaymentCheck', {
  code: cloudfront.FunctionCode.fromFile({
    filePath: 'assets/agentic-x402-monetization.ts',
  }),
  runtime: cloudfront.FunctionRuntime.JS_2_0,
});

const distribution = new cloudfront.Distribution(this, 'Dist', {
  defaultBehavior: {
    origin: origins.S3BucketOrigin.withOriginAccessControl(contentBucket),
    cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
    functionAssociations: [{
      function: paymentCheck,
      eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
    }],
  },
  webAclId: paymentWebAcl.attrArn,
});
```

The CFF inspects the `X-402-Payment` header, verifies the HMAC signature against a shared secret stored in KVS, and either forwards the request or returns a 402 response with payment instructions in the body.

See `assets/agentic-x402-monetization.ts` for the full CFF implementation skeleton.

### Monetization models

- **Per-content-fetch.** A fee per article, document, or data-file access.
- **Per-token.** If you are serving LLM-generated content, charge per inference token returned.
- **Tier-gated.** Free tier for small agents, paid tier for commercial agents, with tiers encoded in the payment token.

The edge is where the payment check happens. The origin never sees unpaid traffic.

## Private MCP registry hosting

Private MCP (Model Context Protocol) registries serve manifests describing available MCP servers to authorized agents. The pattern:

- **Origin.** S3 bucket with MCP manifest JSON files.
- **Distribution.** CloudFront with Origin Access Control (OAC) — not OAI.
- **Access control.** WAF IP filtering for corporate agents, or viewer mTLS for client-cert-authenticated agents.
- **Manifest downloads.** Signed URLs or signed cookies for ephemeral access.
- **Cache invalidation.** Tag the registry index with cache tags so that publishing a new manifest propagates instantly via tag invalidation — see `cache-behaviors-and-policies.md`.

```typescript
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';

const registry = new s3.Bucket(this, 'McpRegistry', {
  encryption: s3.BucketEncryption.S3_MANAGED,
  enforceSSL: true,
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
});

const distribution = new cloudfront.Distribution(this, 'RegistryDist', {
  defaultBehavior: {
    origin: origins.S3BucketOrigin.withOriginAccessControl(registry),
    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
    cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
    responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
  },
  webAclId: mcpWebAcl.attrArn,
});
```

Each manifest gets a cache tag matching its registry index entry. On publish, invalidate the tag — all POPs drop the stale manifest immediately, on order-of-seconds propagation.

## Accept-Markdown content negotiation

AI crawlers and agents parse Markdown with far lower error rates than HTML. Browsers need HTML for rendering. Serving Markdown only to the right clients is a pure win — origins emit a single source format, CloudFront Functions branch at the edge.

### The pattern

- Agent sends `Accept: text/markdown` (or `text/markdown, text/html;q=0.5` if polite).
- CloudFront Function at viewer-request inspects `Accept`. If Markdown is preferred, rewrite `/docs/foo` to `/docs/foo.md`. Otherwise rewrite to `/docs/foo.html`.
- Cache key includes `Accept` (normalized to "markdown" or "html" to avoid cache fragmentation on arbitrary MIME combinations).
- Two cache variants per URL.

### CFF snippet

```typescript
const negotiate = new cloudfront.Function(this, 'Negotiate', {
  code: cloudfront.FunctionCode.fromInline(`
    function handler(event) {
      var req = event.request;
      var accept = req.headers['accept'] ? req.headers['accept'].value : '';
      var wantsMarkdown = accept.indexOf('text/markdown') !== -1;
      if (req.uri === '/' || req.uri.endsWith('/')) {
        req.uri = req.uri + (wantsMarkdown ? 'index.md' : 'index.html');
      } else if (req.uri.indexOf('.') === -1) {
        req.uri = req.uri + (wantsMarkdown ? '.md' : '.html');
      }
      req.headers['x-accept-normalized'] = {
        value: wantsMarkdown ? 'markdown' : 'html'
      };
      return req;
    }
  `),
  runtime: cloudfront.FunctionRuntime.JS_2_0,
});
```

Include `x-accept-normalized` in the cache key via the cache policy. The two variants share no cache entries and never collide.

## AI bot visibility and monetization

AWS WAF Bot Control has a catalog of 650+ identified bots including AI crawler fingerprints (OpenAI, Anthropic, Google, Perplexity, and more). Bot Control labels requests with the bot category, the specific vendor, and verification status (verified owner vs unverified).

Layer monetization and control on top of Bot Control visibility:

### Layer 1 — Visibility

Enable Bot Control at the Pro+ tier. CloudWatch dashboards show which AI vendors are crawling, how much traffic each generates, and trend over time. See `../aws-waf/references/bot-control-and-fraud.md` for capabilities.

### Layer 2 — Differentiated response

Based on the Bot Control label, branch the request handling:

- **Verified partner AI crawler** (one you have a commercial relationship with) → forward to origin or serve cached.
- **Unverified AI crawler claiming to be a known vendor** → Challenge. Forces a TLS or JS puzzle. Verified bots pass; spoofers fail.
- **Known AI crawler without commercial relationship** → serve cached versions only. Prevents fresh-content scraping. Or respond with x402 payment challenge.
- **Suspicious or unknown bot** → rate-limit aggressively using JA4 or ASN aggregation.

### Layer 3 — Training restrictions header

Serve `x-license: training-restricted` and include an `llms.txt` or equivalent machine-readable policy advertising your training-data terms. Responsible AI crawlers honor it. Irresponsible ones reveal themselves via repeated fetches despite the restriction header.

### Layer 4 — Monetization via x402

If an AI vendor wants your content for training or inference, gate the path via x402. Commercial access becomes a revenue stream instead of uncompensated scraping.

See `../aws-waf/references/bot-control-and-fraud.md` for bot categorization detail and `../aws-waf/references/rate-limiting.md` for aggregation-key strategies.

## SaaS tenant routing with CloudFront Functions and KVS

Multi-tenant SaaS platforms route by subdomain or header. Doing the routing at the origin (ALB host-based routing, application-layer lookup) means every request pays an origin hop even for routing decisions. CloudFront Functions plus KVS move the decision to the edge.

### The pattern

- Tenant identifier extracted from `Host` header (subdomain) or a custom header.
- CFF reads the tenant ID, looks up the backend target in KVS, rewrites the request's origin metadata or Host header to route to the correct VPC Origin.
- KVS lookups are sub-millisecond. CFF itself has no cold start.

### CFF skeleton with KVS

```typescript
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';

const tenantStore = new cloudfront.KeyValueStore(this, 'TenantStore', {
  source: cloudfront.ImportSource.fromInline(JSON.stringify({
    data: [
      { key: 'tenant-a', value: 'backend-a.internal' },
      { key: 'tenant-b', value: 'backend-b.internal' },
    ],
  })),
});

const router = new cloudfront.Function(this, 'TenantRouter', {
  code: cloudfront.FunctionCode.fromInline(`
    import cf from 'cloudfront';
    const kvsId = '${tenantStore.keyValueStoreId}';
    const kvs = cf.kvs(kvsId);

    async function handler(event) {
      const req = event.request;
      const host = req.headers.host.value;
      const tenant = host.split('.')[0];
      try {
        const backend = await kvs.get(tenant);
        req.headers['x-tenant-backend'] = { value: backend };
      } catch (e) {
        return { statusCode: 404, statusDescription: 'Tenant not found' };
      }
      return req;
    }
  `),
  runtime: cloudfront.FunctionRuntime.JS_2_0,
  keyValueStore: tenantStore,
});
```

The origin (ALB or VPC Origin) routes based on `x-tenant-backend`. Tenant provisioning is a KVS write — no CloudFront redeploy.

## Rate-limiting AI crawlers

IP-based rate limiting fails against distributed AI crawler fleets. GoogleBot, OpenAI's GPTBot, Anthropic's ClaudeBot, Perplexity's PerplexityBot, and others operate from large IP ranges — often hundreds of IPs, sometimes thousands. Each individual IP sends a modest request rate; the aggregate is massive. Per-IP rate limiting misses the aggregate entirely.

### Aggregation keys that actually work

- **JA4 TLS fingerprint.** Groups clients by their TLS handshake signature. A crawler fleet using the same HTTP client library shares a JA4 across all IPs. Strong signal.
- **ASN.** Groups clients by their autonomous system. OpenAI's IPs share an ASN; Anthropic's share a different ASN. Captures fleet-level volume. See `../aws-waf/references/rate-limiting.md` for ASN aggregation details.
- **User-agent substring.** Fragile — bots can and do lie about their user agent. Use only as a secondary signal, not as the primary aggregation key.

### Combining Bot Control labels with rate rules

The best pattern combines Bot Control categorization with WAF rate rules:

```
IF label = "bot:category:ai" AND label-verified-owner = true
  THEN rate-limit softly (generous threshold)

IF label = "bot:category:ai" AND label-verified-owner = false
  THEN Challenge (forces TLS/JS puzzle, spoofers fail)

IF unlabeled AND ASN in (known AI crawler ASNs)
  THEN rate-limit at ASN key, medium threshold

IF unlabeled AND JA4 rate > threshold
  THEN Block at JA4 key
```

This is the standard AI-crawler enforcement ladder. Verified AI crawlers get generous treatment. Unverified ones are challenged. Unlabeled but recognizable fleets are rate-limited at the ASN or JA4 level.

See `../aws-waf/references/rate-limiting.md` for the full rate-rule syntax and `../aws-waf/references/bot-control-and-fraud.md` for Bot Control label usage.

## Agent observability at the edge

Agent traffic reporting relies on two CloudFront response headers and the standard log format:

- **`x-amz-cf-pop`** — which POP served the response. Useful for geographic attribution.
- **`x-amz-cf-id`** — unique request ID. Correlate a single request across logs, agent telemetry, and downstream systems.
- **`x-edge-request-id`** (L@E) — if using Lambda@Edge, ties viewer-request to origin-request log lines.

### Standard logs to Athena

Enable standard logs in Parquet v2 format, hourly partitioning, to an S3 data lake bucket. Query via Athena. Example queries that matter for agent traffic:

- Per-bot vendor volume (join with Bot Control label data).
- Per-tenant request count and bytes (from tenant header in logs).
- Per-agent session trace (filter on `x-amz-cf-id` from an agent's correlation ID).
- Paid vs unpaid x402 request ratio (filter on 402 response status code).

### Publishing for revenue reporting

If you are monetizing via x402 or Bot Control gating, push the per-bot aggregates into a data lake table used for billing and revenue reporting. Standard logs are the authoritative source — they capture every request, paid and unpaid, verified and spoofed.

See `performance-tuning.md` for the standard-log vs real-time-log tradeoff.

## Agent authentication patterns

Agent-to-API authentication differs from human-to-API. Humans get interactive login. Agents get programmatic credentials. The edge handles both.

### API-key authentication

Simplest pattern. Agent sends `Authorization: Bearer <key>`. CloudFront Function or WAF rule validates presence. Origin verifies the key against a backend store.

Caveat: API keys in Bearer tokens are no different from session cookies for security — rotate frequently, scope to minimum capability.

### Signed requests (SigV4-style)

For agents operating on behalf of AWS principals, AWS SigV4 signing ensures the request has not been tampered with and comes from the claimed principal. WAF supports matching on the `Authorization: AWS4-HMAC-SHA256` pattern.

### Client certificate authentication (viewer mTLS)

For agent fleets where each agent has a client certificate issued from a trusted CA, viewer mTLS at CloudFront is the strongest pattern. Business-tier feature. See `security-and-access.md` for trust store configuration.

### OAuth / OIDC

For user-delegated agents (agent acts on behalf of a human user), standard OAuth 2.0 or OIDC flows. CloudFront Functions verify JWT bearer tokens using signatures cached in KVS or external to the CFF via L@E if signature rotation is frequent.

## Tool-call caching for AI agents

AI agents often repeat the same tool call (fetch the same file, query the same schema) within a session and across sessions. Each tool call is an HTTP request at the edge.

Cache aggressively:

- **GET tool-call endpoints.** Most tool-call endpoints are read-only GETs. Cache with a TTL that matches your content-freshness needs.
- **Normalize argument order.** Tool calls often serialize arguments as JSON query strings. Sort keys at the CFF layer before cache key generation.
- **Content-type-aware cache key.** If the tool supports multiple response formats (JSON, Markdown, OpenAPI), include `Accept` in the cache key.

The result: a tool that is called 100 times per day with 90% duplicate invocations serves 90% of calls from the edge with no origin hit.

## Webhook delivery optimization

Agents frequently dispatch webhooks to notify external services. The receiving end of the webhook often sits behind CloudFront. Optimize the path:

- **Verify webhook signatures at the edge.** Common patterns (HMAC over body + secret) verify with a CloudFront Function or WAF custom rule. Unsigned or wrong-signed webhooks are rejected at the edge without origin compute.
- **Rate-limit by webhook source.** Group by `X-Webhook-Source` header or SNI subject. See `../aws-waf/references/rate-limiting.md`.
- **Absorb retry storms.** Webhook senders retry aggressively on 5xx. A failed origin that returns 503 causes retry storms. CloudFront can serve a configured 2xx or 429 from a response headers policy when origin is unhealthy, stopping the storm.

## MCP server deployment behind CloudFront

MCP servers often run as HTTP services behind CloudFront. Design considerations:

### Streaming responses

MCP responses can stream (Server-Sent Events, chunked transfer). CloudFront supports streaming end-to-end. Configure the cache behavior with a cache policy that does not cache the streaming endpoint (since each agent session is unique), and use an origin request policy that forwards required headers without stripping.

```typescript
const streamingBehavior = {
  origin: origins.HttpOrigin.fromDomainName('mcp.internal.example.com'),
  cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
  originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
  viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
  allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
};
```

### WebSocket MCP transport

If the MCP server uses WebSocket transport, CloudFront supports WebSocket origins. Use an origin request policy that forwards the `Upgrade` and `Connection` headers.

### Authentication forwarding

MCP authentication typically flows through the `Authorization` header. Ensure the origin request policy forwards it — the managed `AllViewer` policy does.

## Content-tagging for agent training

If you are publishing content you want AI training sets to pick up (or avoid), advertise via response headers:

```typescript
const trainingPolicy = new cloudfront.ResponseHeadersPolicy(this, 'TrainingPolicy', {
  customHeadersBehavior: {
    customHeaders: [
      {
        header: 'x-license',
        value: 'training-allowed; citation-required',
        override: true,
      },
      {
        header: 'x-content-provenance',
        value: 'verified-publisher=example-corp',
        override: true,
      },
    ],
  },
});
```

Serve a machine-readable license file at a well-known path (`/llms.txt`, `/.well-known/ai-policy.json`). Responsible AI crawlers read and honor it. Others reveal themselves via Bot Control logs.

## Agent fleet IP allowlisting

For enterprise agent fleets operating from known IP ranges (corporate agents, partner integrations), IP allowlisting via WAF IPSet is cheap and effective:

```typescript
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';

const agentFleetIps = new wafv2.CfnIPSet(this, 'AgentFleetIps', {
  scope: 'CLOUDFRONT',
  ipAddressVersion: 'IPV4',
  addresses: [
    '203.0.113.0/24',
    '198.51.100.0/24',
  ],
});
```

Combine with label-based rules: `IF IP in AgentFleetIps → generous rate-limit`, `ELSE → Bot Control enforcement applies`.

## Related

- `../aws-waf/references/bot-control-and-fraud.md` — Bot Control catalog, labels, enforcement.
- `../aws-waf/references/rate-limiting.md` — JA4 and ASN aggregation, rate-rule syntax.
- `../aws-waf/references/ddos-resilience.md` — absorbing attack traffic rather than billing for it.
- `cache-behaviors-and-policies.md` — cache policies, tag-based invalidation for MCP registries.
- `edge-functions.md` — CloudFront Functions runtime details, KVS access.
- `security-and-access.md` — OAC, signed URLs, WAF integration, viewer mTLS.
- `pricing-and-plans.md` — flat-rate bundling with x402 as a revenue layer.
- `performance-tuning.md` — cache hit ratio for agent traffic.
- `assets/agentic-x402-monetization.ts` — x402 CFF skeleton.
