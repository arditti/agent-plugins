# CloudFront Performance Tuning

Cache hit ratio is the dominant performance lever on CloudFront. Every other knob — HTTP/3, Brotli, Origin Shield, HTTPS DNS records — is a multiplier on the traffic you failed to cache. Optimize in this order and stop when you hit diminishing returns: (1) cache more, (2) narrow the cache key, (3) right-size TTLs, (4) enable HTTP/3 with HTTPS DNS advertisement, (5) enable compression, (6) reconcile logging spend against visibility needs. Anything else (price class tweaks, Origin Shield, connection tuning) is a secondary optimization that matters only after the first six are done.

## Contents

- [Optimization order](#optimization-order)
- [Cache hit ratio optimization](#cache-hit-ratio-optimization)
- [Compression: Brotli and gzip](#compression-brotli-and-gzip)
- [HTTP/3 and QUIC](#http3-and-quic)
- [HTTPS DNS records (RFC 9460)](#https-dns-records-rfc-9460)
- [TTFB optimization](#ttfb-optimization)
- [Real-user monitoring](#real-user-monitoring)
- [Logging: standard vs real-time](#logging-standard-vs-real-time)
- [Price class](#price-class)
- [Cost optimization](#cost-optimization)
- [Related](#related)

## Optimization order

Do not skip ahead. Enabling HTTP/3 on a distribution with a 12% cache hit ratio does not fix the hit ratio. Enabling Brotli on uncacheable responses does not reduce origin load. Walk the order:

1. **Cache more.** Find the uncacheable responses. Classify them: genuinely dynamic, wrongly marked no-store, or cacheable-if-you-normalized-the-key.
2. **Narrow the cache key.** Each header, cookie, and query-string dimension you include multiplies the working set of cached variants.
3. **Right-size TTLs.** Long TTL with invalidation-on-publish beats short TTL with no invalidation every time.
4. **Enable HTTP/3 and advertise it via DNS.** Without HTTPS DNS records, the first request from every viewer still pays the H2-to-H3 upgrade round trip.
5. **Enable compression.** Brotli and gzip, negotiated per request.
6. **Match the logging tier to the visibility you need.** Real-time logs are expensive; use standard logs unless you actually require sub-minute latency.

## Cache hit ratio optimization

Cache hit ratio (CHR) is exposed as the `CacheHitRate` CloudWatch metric. Alarm on sustained degradation — a drop usually means someone added a header to the cache key, or the origin started returning `Cache-Control: no-store` for a response that used to be cacheable.

### Narrow the cache key

The cache key includes everything the viewer can vary and everything the distribution forwards. Audit:

- **Headers included in the cache key.** Use a cache policy that includes only headers that affect the response body. `Accept`, `Accept-Language`, and `Accept-Encoding` are common — anything else is usually wrong.
- **Cookies.** Default to none. If a specific cookie drives the response (`session`, `tenant`), include that cookie by name. Never forward `all`.
- **Query strings.** Include only the query strings that affect the response. Unknown query strings should not split the cache.

Each additional dimension multiplies cache variants. A distribution that includes `User-Agent` in the cache key effectively has no cache — every browser/OS/version combination gets its own entry.

### Normalize query strings at the edge

AI agents, analytics scripts, and ad platforms append tracking parameters that do not affect the response: `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `gclid`, `fbclid`, `mc_eid`, `msclkid`, `yclid`. Strip them in a CloudFront Function at viewer-request before the cache lookup.

```typescript
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';

const normalizeQuery = new cloudfront.Function(this, 'NormalizeQuery', {
  code: cloudfront.FunctionCode.fromInline(`
    function handler(event) {
      var req = event.request;
      var qs = req.querystring;
      var stripped = {};
      var drop = ['utm_source','utm_medium','utm_campaign','utm_term',
                  'utm_content','gclid','fbclid','mc_eid','msclkid','yclid'];
      for (var key in qs) {
        if (drop.indexOf(key.toLowerCase()) === -1) stripped[key] = qs[key];
      }
      req.querystring = stripped;
      return req;
    }
  `),
  runtime: cloudfront.FunctionRuntime.JS_2_0,
});
```

Attach to the default behavior at `FunctionEventType.VIEWER_REQUEST`. The strip happens before the cache lookup, so `/page?utm_source=email` and `/page` share a cache entry.

### Watch for origin `Vary`

Origins that emit `Vary: User-Agent` destroy CloudFront caching. Each User-Agent string becomes a separate cache entry. Strip `User-Agent` from the `Vary` header at the origin, or override in a response headers policy.

`Vary: Accept-Encoding` is fine — CloudFront handles compression negotiation and does not double-count encoding variants.

### TTL strategy

Two levers: the origin's `Cache-Control` header and the CloudFront cache policy's min/default/max TTL.

- **Origin-driven.** Set `Cache-Control: public, max-age=...` at the origin. CloudFront honors it bounded by the cache policy's min/max TTL. This is the pattern you want — origin owns freshness semantics.
- **Policy-driven.** Use only when you cannot modify the origin (e.g., third-party origin). The cache policy's default TTL applies when the origin omits `Cache-Control`.

### Stale-while-revalidate and stale-if-error

Include both directives in the origin's `Cache-Control` header:

- `stale-while-revalidate=<seconds>` — serve stale content while revalidating in the background. Viewer sees zero latency hit on expiry.
- `stale-if-error=<seconds>` — serve stale content if the origin returns 5xx. Insulates viewers from origin flaps.

### Long TTL + invalidation beats short TTL

A 1-hour TTL with no invalidation means every content update waits up to an hour to propagate. A 24-hour TTL with tag-based invalidation (see `cache-behaviors-and-policies.md`) propagates updates in seconds and achieves far higher CHR in steady state. Pick long TTL and invalidate on publish.

### Alarm on `CacheHitRate`

```typescript
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';

new cloudwatch.Alarm(this, 'ChrAlarm', {
  metric: new cloudwatch.Metric({
    namespace: 'AWS/CloudFront',
    metricName: 'CacheHitRate',
    dimensionsMap: { DistributionId: distribution.distributionId, Region: 'Global' },
    statistic: 'Average',
  }),
  threshold: 0.85,
  comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
  evaluationPeriods: 3,
});
```

Also track `BytesDownloaded` (origin load) and `TotalErrorRate` (which correlates with cache misses when origin is flaky).

## Compression: Brotli and gzip

Enable both. CloudFront negotiates the best available encoding per request via the viewer's `Accept-Encoding` header. Brotli is materially smaller than gzip for text (HTML, CSS, JS, JSON, SVG, XML, text-based fonts). Gzip is the fallback for clients that do not advertise Brotli.

- **Managed cache policies with compression.** Use `CachingOptimized` — it sets `EnableAcceptEncodingGzip` and `EnableAcceptEncodingBrotli` to true and includes `Accept-Encoding` in the cache key so compressed and uncompressed variants do not collide.
- **Pre-compressed origins.** If the origin already returns `Content-Encoding: br` or `gzip`, CloudFront serves it as-is rather than recompressing. Do not set `Content-Encoding: identity` on pre-compressed payloads — CloudFront will not know the content is compressed.
- **What not to compress.** Images (JPEG, PNG, WebP, AVIF), video (MP4, WebM), and archives (zip, gz, br) are already compressed. CloudFront skips compression for these content types by default.

Compression cuts egress bytes substantially for text-heavy sites. On a content-heavy site with 70%+ text payloads, Brotli reduces bandwidth on cacheable responses and reduces viewer TTLB.

## HTTP/3 and QUIC

Enable HTTP/3 alongside HTTP/2. Keep HTTP/2 enabled — HTTP/3 is negotiated via the `Alt-Svc` response header, and the first connection from a viewer to your distribution is still HTTP/2 unless the viewer has cached the advertisement from a previous visit.

```typescript
const distribution = new cloudfront.Distribution(this, 'Dist', {
  defaultBehavior: { origin },
  httpVersion: cloudfront.HttpVersion.HTTP3,
});
```

Benefits:

- **Connection migration.** QUIC binds the connection to a connection ID rather than the 4-tuple. Mobile clients switching between Wi-Fi and cellular do not drop the connection — meaningful for progressive web apps and streaming.
- **Zero-RTT resumption.** Returning clients skip the TLS handshake round trip.
- **Head-of-line blocking fix.** Packet loss in one stream does not stall the others.

The cold-start problem: the first request from a new viewer pays the H2-to-H3 upgrade round trip. Solve it with HTTPS DNS records.

## HTTPS DNS records (RFC 9460)

RFC 9460 (published 2023, broadly supported as of 2025) defines the `HTTPS` DNS record type. It advertises HTTP/3 support at DNS resolution time, before the first HTTP connection. Viewers that understand the record skip HTTP/2 entirely on the first request.

Route 53 supports the `HTTPS` record type with alias semantics — it can point at the CloudFront distribution domain. Link to the current [Route 53 supported DNS record types](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/ResourceRecordTypes.html) for the current configuration UI.

```typescript
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';

new route53.HttpsRecord(this, 'HttpsAdvert', {
  zone,
  recordName: 'www',
  values: [{
    priority: 1,
    targetName: '.',
    params: {
      alpn: ['h3', 'h2'],
    },
  }],
});

new route53.ARecord(this, 'AliasA', {
  zone,
  recordName: 'www',
  target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
});
```

**Client support.** Modern Chrome, Safari, and Firefox honor `HTTPS` records. Clients that do not understand the record simply ignore it and fall back to HTTP/2 upgrade via `Alt-Svc`. No downside to enabling.

**Enable unconditionally for public sites.** The record eliminates the first-visit upgrade round trip for supported clients and is transparent to everyone else.

## TTFB optimization

TTFB (time to first byte) at the edge has three components: viewer-to-POP RTT, POP processing, and POP-to-origin fetch latency on cache miss. Cache hits have no origin fetch — which is why CHR dominates TTFB. On cache miss:

- **Regional origin placement.** Place the origin in a region geographically near your CHR-weighted POP distribution. For global audiences with heavy POP spread, consider a single central region (us-east-1) and rely on Origin Shield.
- **Origin Shield.** An extra cache layer in a designated region. Every POP fetches through Origin Shield rather than directly from origin. Useful when (a) many POPs each fetch the same asset — Shield deduplicates, (b) origin is in a different continent from most viewers, (c) origin has limited connection capacity. Costs extra per-GB — see `pricing-and-plans.md`.
- **Keep-alive and connection pooling.** CloudFront pools origin connections by default. Verify the origin does not set aggressive `Keep-Alive: timeout=` values that close connections prematurely. On custom HTTP origins, configure keep-alive to match your expected idle period.
- **Origin response timeout.** Default is moderate. Lower it if your origin consistently responds fast — faster failure means faster retry or error surface. Raise it only for legitimately slow origins (e.g., on-demand video transcoding endpoints).

## Real-user monitoring

Do not try to measure client-perceived performance from server-side logs. Server logs tell you what CloudFront did; they do not tell you what the viewer's browser experienced. For that, use:

- **CloudWatch RUM.** First-party AWS RUM pipeline. Captures Core Web Vitals (LCP, CLS, INP, TTFB) per-page from real viewers. Ties into CloudWatch metrics and alarms.
- **Third-party RUM.** SpeedCurve, Calibre, Datadog RUM, New Relic Browser, Akamai mPulse. Pick whichever integrates with your observability stack.

Instrument both: server logs for infrastructure view, RUM for viewer view. They tell you different things.

## Logging: standard vs real-time

| | Standard logs | Real-time logs |
|---|---|---|
| Destination | S3 | Kinesis Data Streams |
| Latency | ~30–60 min delay | Sub-minute |
| Format | Parquet, hourly-partitioned (v2) | JSON per-record |
| Cost | Cheap per-request | Expensive per-record |
| Query model | Athena, Glue | Kinesis consumers, downstream ETL |
| Use case | Cost analytics, traffic reporting, forensics | Fraud/abuse real-time pipelines, active debugging |

**Default to standard logs in Parquet v2 format with hourly partitioning.** Query via Athena. Cost scales with request count, and Parquet partition pruning keeps query cost bounded.

**Enable real-time logs only when.**

- You are debugging an active incident and need sub-minute visibility.
- You have a fraud or abuse pipeline that must act on traffic patterns within seconds.
- You are feeding a security SIEM that requires near-real-time ingestion.

For fraud pipelines, sample aggressively (not every field, not every request) — real-time logs bill per-record.

See `pricing-and-plans.md` for the cost model.

## Price class

CloudFront exposes three price classes that restrict which POPs serve your viewers:

| Price class | POPs included | When to use |
|---|---|---|
| `PriceClass_All` | All POPs worldwide | Default. Global audience. Best TTFB everywhere. |
| `PriceClass_200` | All except the most expensive regions (some parts of South America, Australia, India, Middle East, Africa) | Audience concentrated in NA/EU/Asia core. |
| `PriceClass_100` | NA and EU only | Audience exclusively NA/EU and you need cost reduction. |

**Default to `PriceClass_All`.** Restricting price class saves money on data transfer in the excluded regions but worsens TTFB for viewers there. Restrict only when (a) you have explicit evidence your audience is regionally concentrated, (b) the savings are material relative to your bill, (c) you accept degraded performance for the excluded regions as a tradeoff.

Flat-rate pricing plans (see `pricing-and-plans.md`) generally bundle all POPs — price class becomes moot on flat-rate.

## Cost optimization

The cost levers on CloudFront, in order of impact:

1. **Increase cache hit ratio.** Every cache hit is bytes served from the edge at a much lower unit cost than bytes from origin. Every origin fetch is the full cost plus origin compute.
2. **Enable compression.** Brotli and gzip reduce egress bytes.
3. **Switch to flat-rate pricing if the economics fit.** Predictable monthly bill, bundled WAF and logs. See `pricing-and-plans.md` for the decision framework.
4. **Drop real-time logs when standard logs suffice.** The cost difference is large.
5. **Use `PriceClass_200` or `PriceClass_100` only when audience data justifies it.**
6. **Origin Shield if and only if it pays off.** Shield adds a per-GB fee. Worth it when you have high fan-out from many POPs to the same assets and the dedupe savings exceed the Shield fee. Not worth it for sites with naturally high CHR at the POPs.

Link to the [CloudFront pricing page](https://aws.amazon.com/cloudfront/pricing/) for current unit costs and tier details.

## Measuring the order: what to instrument

Instrument the optimization order directly. Do not optimize what you cannot measure.

### Cache hit ratio by behavior

CloudWatch's `CacheHitRate` is per-distribution. For multi-behavior distributions, slice by behavior using standard logs in Athena:

```sql
SELECT
  date_trunc('hour', cast("time" AS timestamp)) AS hour,
  regexp_extract(cs_uri_stem, '^/([^/]+)', 1) AS path_segment,
  SUM(CASE WHEN x_edge_result_type IN ('Hit', 'RefreshHit') THEN 1 ELSE 0 END) * 1.0
    / COUNT(*) AS chr
FROM cloudfront_standard_logs
WHERE date = date_format(current_date, '%Y-%m-%d')
GROUP BY 1, 2
ORDER BY 1 DESC, chr ASC;
```

Behaviors at the bottom of the CHR list are the high-leverage targets for tuning.

### Compression effectiveness

Log lines include `sc_bytes` (bytes to viewer) and the origin's original response size (if your origin emits `x-orig-size` or similar). Compression ratio per content type, per behavior. Text-heavy behaviors with compression ratios below 2x have origin-compression issues — the origin may be emitting already-compressed or badly-compressible content.

### TTFB distribution

`time_taken` in standard logs is total POP-side processing. Break down by `x_edge_result_type`:

- `Hit` / `RefreshHit` — edge-only. Low `time_taken` expected.
- `Miss` — includes origin fetch. Higher `time_taken`.

A wide TTFB distribution on `Hit` responses indicates POP contention or edge-function latency.

## Origin connection tuning

Persistent connections between POPs and origin reduce TTFB on cache miss. The default CloudFront-to-origin connection pool is sufficient for most workloads, but edge cases:

- **Origin with aggressive keep-alive timeout.** If the origin closes idle connections in seconds, CloudFront reopens connections frequently, costing a TCP/TLS handshake per reopen. Raise the origin's `Keep-Alive: timeout=` to at least a minute.
- **Origin with connection limit.** Origins with low `MaxClients` or equivalent settings queue requests during bursts. Raise the limit or add capacity.
- **Origin behind NAT.** NAT connection tracking tables can drop long-idle connections. Disable idle timeout on the NAT or use ALB/NLB origins that handle this correctly.

### VPC Origins

VPC Origins eliminate the public-internet hop between CloudFront and an internal origin. CloudFront establishes connections over AWS's internal backbone to an internal-only ALB or NLB, with no public exposure. Use VPC Origins instead of custom-header verification (header verification is a stale pattern — VPC Origins are the modern replacement).

```typescript
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elb from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';

const internalAlb = new elb.ApplicationLoadBalancer(this, 'InternalAlb', {
  vpc,
  internetFacing: false,
});

const vpcOrigin = new cloudfront.VpcOrigin(this, 'VpcOrigin', {
  endpoint: cloudfront.VpcOriginEndpoint.applicationLoadBalancer(internalAlb),
});

const distribution = new cloudfront.Distribution(this, 'Dist', {
  defaultBehavior: {
    origin: origins.VpcOriginArn.fromVpcOrigin(vpcOrigin),
    cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
  },
});
```

The TTFB improvement is most visible when the origin is in a region far from most POPs — the internal backbone is consistently faster than public internet.

## Response Headers Policies for security-header cost avoidance

Security headers (HSTS, X-Frame-Options, Content-Security-Policy, Referrer-Policy, Permissions-Policy) were historically set via Lambda@Edge at viewer-response. That pattern is stale and expensive — every response pays an L@E invocation.

Use Response Headers Policies instead. Configured on the distribution behavior, applied by CloudFront directly, zero per-request cost.

```typescript
const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
  securityHeadersBehavior: {
    strictTransportSecurity: {
      accessControlMaxAge: cdk.Duration.days(365),
      includeSubdomains: true,
      preload: true,
      override: true,
    },
    contentTypeOptions: { override: true },
    frameOptions: {
      frameOption: cloudfront.HeadersFrameOption.DENY,
      override: true,
    },
    referrerPolicy: {
      referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
      override: true,
    },
  },
  customHeadersBehavior: {
    customHeaders: [
      {
        header: 'Content-Security-Policy',
        value: "default-src 'self'; script-src 'self' 'unsafe-inline'",
        override: true,
      },
      {
        header: 'Permissions-Policy',
        value: 'geolocation=(), microphone=(), camera=()',
        override: true,
      },
    ],
  },
});
```

Attach to the behavior. The headers apply on every response, cache hit or miss, at no per-request compute cost.

## When Origin Shield pays for itself

Origin Shield is an additional cache layer in a designated region. Every POP fetches through Shield rather than directly from origin. It costs per-GB through the Shield layer.

Decision criteria:

| Condition | Shield decision |
|---|---|
| Content is requested from many POPs globally, each fetching the same assets | Yes — Shield deduplicates fetches |
| Origin is in a single region serving a global audience | Yes — Shield in the origin's region shortens the path from POPs |
| Origin has limited connection capacity or compute budget | Yes — Shield reduces origin load |
| CHR is already high (>90%) — most requests are POP cache hits | No — little dedupe value |
| Origin is geographically distributed (multi-region) | No — dedupe value is split across regions |
| Workload is mostly unique content per request (dynamic APIs) | No — nothing to dedupe |

Pick the Shield region nearest to the origin, not nearest to viewers. The viewer-to-POP path is unchanged; Shield only affects POP-to-origin.

## Measuring production impact

Performance tuning without measurement is guesswork. Capture the baseline before any change, and compare after.

### The four metrics to track

| Metric | Source | What it reveals |
|---|---|---|
| `CacheHitRate` | CloudWatch `AWS/CloudFront` | Effectiveness of caching strategy |
| P50/P95 TTFB | RUM or synthetic monitoring | User-perceived latency |
| Origin bytes downloaded | CloudWatch `BytesDownloaded` on origin | Origin load |
| Total error rate | CloudWatch `TotalErrorRate` | Availability |

A performance tuning effort should move at least one of these measurably and not regress the others.

### Weekly baseline review

Schedule a weekly review of the CHR and TTFB trends. Drift accumulates — caught early, each fix is small. Caught late, you have a month of compounded regressions to unwind.

## Related

- `cache-behaviors-and-policies.md` — cache policies, origin request policies, tag-based invalidation.
- `pricing-and-plans.md` — PAYG vs flat-rate, log cost comparison.
- `troubleshooting.md` — debugging cache miss, TTFB regressions, compression not applying.
- `edge-functions.md` — CloudFront Functions for query normalization, content negotiation.
- `distributions-and-origins.md` — Origin Shield, origin timeout tuning, VPC Origins.
- `security-and-access.md` — Response Headers Policies.
- `../aws-waf/references/rate-limiting.md` — why rate limiting lives at WAF, not at origin.
