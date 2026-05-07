# Cache Behaviors and Policies

How to configure what CloudFront caches, what it forwards to origin, and what it returns to the viewer. Three primitives drive every caching decision: the **cache policy** (what goes into the cache key and TTLs), the **origin request policy** (what gets forwarded to origin without affecting the cache key), and the **response headers policy** (what CloudFront adds or modifies on the way back). Start with AWS managed policies; write a custom policy only when no managed policy covers the case.

## Contents

- [The three policy primitives](#the-three-policy-primitives)
- [Managed cache policies](#managed-cache-policies)
- [Managed origin request policies](#managed-origin-request-policies)
- [Managed response headers policies](#managed-response-headers-policies)
- [Custom cache policies](#custom-cache-policies)
- [TTL strategy: origin-driven vs policy-driven](#ttl-strategy-origin-driven-vs-policy-driven)
- [Stale-while-revalidate and stale-if-error](#stale-while-revalidate-and-stale-if-error)
- [Path pattern precedence](#path-pattern-precedence)
- [Cache tag invalidation](#cache-tag-invalidation)
- [Path-based invalidation](#path-based-invalidation)
- [Query string and cookie normalization](#query-string-and-cookie-normalization)
- [Compression and the cache key](#compression-and-the-cache-key)
- [Cross-origin caching pitfalls](#cross-origin-caching-pitfalls)
- [Related](#related)

## The three policy primitives

CloudFront separates three concerns that older CDN mental models conflated:

| Primitive                 | Controls                                                             | Affects cache key | Affects origin request |
| ------------------------- | -------------------------------------------------------------------- | ----------------- | ---------------------- |
| Cache policy              | What goes into the cache key (headers, cookies, query strings, encoding) and TTLs (min, default, max, origin-driven) | Yes               | Yes, for anything keyed |
| Origin request policy     | What else is forwarded to origin but is NOT part of the cache key   | No                | Yes                    |
| Response headers policy   | What CloudFront adds, removes, or overrides on the response         | No                | No                     |

This separation lets you forward a request-scoped debug header to origin without fracturing the cache. It lets you add HSTS to every response without touching origin code or an edge function. Know which primitive owns each concern before reaching for any of them.

## Managed cache policies

AWS publishes a list of managed cache policies. Link: [managed cache policies](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-cache-policies.html). Pick one before writing a custom policy.

| Managed policy                                           | Use for                                                                                          |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `CachingOptimized`                                        | Static assets with a versioned URL (hashed filename). Aggressive caching; compression enabled.  |
| `CachingOptimizedForUncompressedObjects`                  | Pre-compressed origins where CloudFront should not re-compress. Image CDN, binary bundles.     |
| `CachingDisabled`                                         | APIs, auth flows, anything that must not cache. Cache key is minimal; TTL is zero.              |
| `UseOriginCacheControlHeaders`                            | Origin sets `Cache-Control` per object; policy honors it. Good for CMS output with proper headers. |
| `UseOriginCacheControlHeaders-QueryStrings`               | Same as above but query strings are part of the cache key. For search results, list endpoints.  |
| `Elemental-MediaPackage`                                  | MediaPackage video origins. Do not tune by hand.                                                  |
| `Amplify`                                                 | Amplify-hosted apps. Do not tune by hand.                                                         |

Pattern: use `CachingOptimized` for every SPA bundle (`index.html` gets a short TTL via origin headers; hashed JS/CSS gets long TTL from the filename). Use `CachingDisabled` for every `/api/*` behavior unless you have specifically designed the API for edge caching (idempotent GETs, cache-friendly URLs, explicit `Cache-Control`). Use `UseOriginCacheControlHeaders` when origin teams own TTL policy.

## Managed origin request policies

| Managed policy                         | Forwards to origin                                                                                  |
| -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `AllViewer`                            | All viewer headers, cookies, query strings. Use when the origin needs full fidelity.                |
| `AllViewerExceptHostHeader`            | Everything except `Host`. Use with ALB/ECS origins that set their own host expectations.            |
| `AllViewerAndCloudFrontHeaders-2022-06` | Viewer plus CloudFront's `CloudFront-*` headers (viewer country, device class, forwarded proto).   |
| `CORS-S3Origin`                        | Minimum headers S3 needs for CORS (origin, access-control-request-headers).                         |
| `CORS-CustomOrigin`                    | Same as above but for non-S3 origins. Use for API Gateway, ALB behind `/api/*`.                     |
| `UserAgentRefererHeaders`              | Only `User-Agent` and `Referer`. Tiny cache-friendly profile for static origins that log analytics.|

Rule of thumb: if the origin is an ALB, use `AllViewerExceptHostHeader` unless you have a reason to preserve the viewer Host. If the origin is S3 and you need CORS, use `CORS-S3Origin`. If the origin is API Gateway and you sign at edge, use `AllViewer` so the signature covers everything the origin expects.

## Managed response headers policies

| Managed policy                            | Adds                                                                                          |
| ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| `SecurityHeadersPolicy`                   | HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, an opinionated default CSP.   |
| `CORS-and-SecurityHeadersPolicy`          | Security headers plus CORS.                                                                    |
| `SimpleCORS`                              | Permissive CORS only. Not recommended in production; use for dev only.                         |
| `CORS-With-Preflight`                     | CORS with preflight support for credentialed requests.                                         |
| `CORS-With-Preflight-and-SecurityHeadersPolicy` | Combined. Use when the app needs CORS and security headers.                               |

`SecurityHeadersPolicy` is the right starting point for every distribution that serves HTML. The default CSP is restrictive; most real apps need a custom CSP, at which point write a custom response headers policy. See [`security-and-access.md`](security-and-access.md) for a custom CSP pattern.

## Custom cache policies

Write a custom cache policy when managed doesn't cover the case. Common triggers:

- Cache keyed on a specific cookie (A/B test bucket, tenant ID).
- Cache keyed on a subset of query strings (drop tracking params from the key but keep them in the origin request).
- Cache keyed on `Accept-Language` for localized static content.
- Cache keyed on a custom header set by a CloudFront Function (e.g., device class normalized from User-Agent).

```typescript
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';

const tenantCachePolicy = new cloudfront.CachePolicy(this, 'TenantCachePolicy', {
  cachePolicyName: 'TenantKeyed',
  comment: 'Cache keyed on tenant cookie and Accept-Language header',
  defaultTtl: cdk.Duration.hours(1),
  minTtl: cdk.Duration.seconds(0),
  maxTtl: cdk.Duration.days(1),
  cookieBehavior: cloudfront.CacheCookieBehavior.allowList('tenant_id'),
  headerBehavior: cloudfront.CacheHeaderBehavior.allowList('Accept-Language'),
  queryStringBehavior: cloudfront.CacheQueryStringBehavior.allowList('v', 'page'),
  enableAcceptEncodingGzip: true,
  enableAcceptEncodingBrotli: true,
});
```

Design principle: **narrow is better**. Every additional key dimension multiplies cache variants, lowering hit ratio. Allowlist the minimum; never forward `all` unless you have measured that the ratio penalty is acceptable.

Cache key dimensions you usually do NOT want in the key:

- Session cookies that change per request.
- `User-Agent` (high cardinality; use CloudFront's device-class headers instead).
- Tracking query strings (`utm_*`, `gclid`, `fbclid`, `msclkid`). Drop from the key; forward in the origin request policy if the origin needs them.

## TTL strategy: origin-driven vs policy-driven

Two models coexist, and picking the wrong one is a common misconfiguration.

**Origin-driven TTL**. The origin sets `Cache-Control: max-age=...` or `s-maxage=...` per object. CloudFront honors it within the policy's min/max bounds. Use this when origin teams own TTL policy and versioned URLs let them extend cache lifetimes per object.

- Set cache policy min TTL to 0 (honor the origin's `no-store` / `no-cache`).
- Set cache policy max TTL to a ceiling you trust (protects against a misconfigured origin sending a year-long TTL by accident).
- Set default TTL to something reasonable for when origin forgets the header.

**Policy-driven TTL**. CloudFront forces TTLs regardless of origin headers. Use when the origin is legacy, doesn't emit `Cache-Control`, or the app has no opinion and you want uniform behavior.

- Set min, default, max to the same value to fully override origin.
- Expect every origin `Cache-Control` header to be ignored for caching (they still reach the viewer).

Pick one model per behavior. Mixing them surprises everyone during incidents.

## Stale-while-revalidate and stale-if-error

CloudFront supports `stale-while-revalidate` and `stale-if-error` when the origin advertises them. `stale-while-revalidate=N` lets CloudFront serve a stale object for up to N seconds while fetching a fresh copy asynchronously. `stale-if-error=N` lets CloudFront serve stale when the origin returns an error.

Configure by setting `Cache-Control` at the origin:

```
Cache-Control: public, max-age=60, stale-while-revalidate=300, stale-if-error=86400
```

The cache policy must be one that honors origin cache control headers (e.g., `UseOriginCacheControlHeaders`). See the [stale content docs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/ServingStaleContent.html) for current behavior and interactions with origin errors.

Use aggressively for content that tolerates minor staleness (product catalogs, dashboards, blog posts). It converts origin slowness into a user-invisible refresh rather than a 504.

## Path pattern precedence

CloudFront evaluates behaviors in declared order. Most-specific first, default last. Wildcards:

- `/api/v2/users` matches exactly that path.
- `/api/v2/users/*` matches anything under the path.
- `/api/*` matches any path starting with `/api/`.
- `*.jpg` does not work; CloudFront path patterns are not glob patterns with suffix matching. Use behaviors keyed on path prefix; let the cache policy differentiate by extension via content-type if needed.
- `/*` is the default; last.

```
| Order | Path pattern         | Origin          | Cache policy        |
| ----- | -------------------- | --------------- | ------------------- |
| 1     | /api/v2/public/*     | ALB (public)    | CachingOptimized    |
| 2     | /api/*               | ALB (private)   | CachingDisabled     |
| 3     | /auth/*              | Lambda URL      | CachingDisabled     |
| 4     | /static/*            | S3              | CachingOptimized    |
| 5     | /*                   | S3 (SPA)        | CachingOptimized    |
```

Re-ordering behaviors changes matching. When adding a new behavior, always check that it slots in at the right precedence.

## Cache tag invalidation

Cache tag invalidation launched in 2026-04 and replaces path-based wildcard invalidation for most dynamic content use cases. The origin attaches tags to objects via a response header. CloudFront associates the tags with the cached object. A single API call invalidates every object with a given tag, across the whole distribution.

**Workflow**:

1. Origin emits a tag header on the response. Use the header name documented in the [cache tags docs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/invalidation-by-cache-tags.html).
2. CloudFront caches the object and records its tags.
3. On content change, the origin (or a workflow) calls the CloudFront invalidation API by tag.
4. CloudFront invalidates every object with the tag across POPs.

**Use cases**:

- CMS publishes article X, which appears on the homepage, the section page, and its own URL. Tag all three with `article-x`. Publish invalidates `article-x`, all three drop.
- E-commerce catalog: tag each cached product page with `product-<sku>` and `category-<id>`. Price change invalidates one SKU; category reorg invalidates a category.
- Feature flag rollout: tag dynamic pages with `variant-<bucket>` and invalidate when a variant is retired.

**CDK**:

```typescript
const dist = new cloudfront.Distribution(this, 'Dist', {
  defaultBehavior: {
    origin,
    cachePolicy: cloudfront.CachePolicy.USE_ORIGIN_CACHE_CONTROL_HEADERS,
    // Cache tags require the distribution to be configured to accept them.
    // Check the CDK L2 or use an Aspect if the property is on CfnDistribution.
  },
});
```

Check the current CDK surface; tag invalidation may be configured through `CfnDistribution` escape hatches if the L2 doesn't expose it yet. Link: [cache tags API](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/invalidation-by-cache-tags.html).

## Path-based invalidation

Path-based invalidation is still appropriate when:

- You know the exact paths to invalidate (deploy replaces `/static/abc-<hash>.js`; invalidate that path).
- The number of paths is small.
- There are no tags on the content yet.

Wildcards (`/*`) are a blunt instrument. They invalidate the entire distribution at every POP and incur per-path-charged behavior the [pricing docs](https://aws.amazon.com/cloudfront/pricing/) describe. Use only during incident response ("purge everything, figure it out later"). For dynamic content, prefer tag invalidation from the start.

```bash
aws cloudfront create-invalidation \
  --distribution-id E1ABCDEFG \
  --paths "/static/main.js" "/static/main.css"
```

Design content URLs so path-based invalidation is not needed most of the time:

- Versioned filenames (`main.a3f8b2.js`) never need invalidation.
- Content hashes on query string invalidate implicitly because the URL is different.
- `index.html` has a short TTL via origin `Cache-Control` so it picks up new hashed filenames naturally.

## Query string and cookie normalization

Cache efficiency depends on the cache key being as narrow as possible.

**Query strings**:

- Allowlist only the params that affect response content.
- Drop marketing/tracking params (`utm_*`, `gclid`, `fbclid`, `ref`, `source`) from the cache key.
- If the origin needs tracking params for analytics, include them in the origin request policy (forwarded but not keyed).

**Cookies**:

- Almost never include session cookies in the cache key; they make the cache per-user.
- Include a tenant cookie or an A/B bucket cookie if the response differs by its value.
- Consider setting the A/B bucket via a CloudFront Function that writes a cookie and keys on the result; see [`edge-functions.md`](edge-functions.md).

**Headers**:

- Prefer CloudFront-managed headers (`CloudFront-Viewer-Country`, `CloudFront-Viewer-Address`, `CloudFront-Is-Mobile-Viewer`, `CloudFront-Viewer-TLS`) over raw `User-Agent` or `X-Forwarded-For`. They are normalized, bounded cardinality, and stable.
- Client IP for rate-limiting or access decisions: `CloudFront-Viewer-Address` holds the real viewer IP:port at the edge. `X-Forwarded-For` is unreliable because it is a list and can include spoofed entries when CloudFront isn't the terminator.

## Compression and the cache key

CloudFront compresses responses per-encoding (gzip, brotli, identity). The variants live under the same cache key; you do not need to add `Accept-Encoding` to the cache policy manually. Managed policies enable compression for text types; check the policy before assuming.

If the origin pre-compresses (e.g., serves `.br` files), disable CloudFront compression for that behavior and use `CachingOptimizedForUncompressedObjects` so CloudFront doesn't double-process.

Do not add `Accept-Encoding` to the cache key allowlist. CloudFront handles this internally; explicitly keying on it fractures the cache by arbitrary client encoding strings.

## Cross-origin caching pitfalls

Caching responses that vary by origin/cookies across shared caches breaks in predictable ways. Avoid the following:

- **Forwarding `all` cookies on a cached behavior**. Every cookie change is a cache miss. Use allowlist.
- **`Vary: *` from origin**. Every header variant is a new cache entry; hit ratio collapses. Configure origin to emit specific `Vary` values (e.g., `Vary: Accept-Language, Accept-Encoding`) or none.
- **Responses with `Set-Cookie` cached as public**. CloudFront will refuse to cache responses with `Set-Cookie` unless the cache policy explicitly accepts it, but origin-driven TTL can bypass this in edge cases. Ensure auth-related endpoints are on `CachingDisabled` behaviors.
- **CORS with wildcard origin on authenticated endpoints**. `Access-Control-Allow-Origin: *` combined with `Access-Control-Allow-Credentials: true` is invalid and will be rejected by browsers. Use explicit origin reflection in a response headers policy or at the app layer.

When in doubt, start from `CachingDisabled` for a new dynamic endpoint, measure what it forwards, then graduate to a custom cache policy with the narrowest key that still gives the content you need.

## Negative caching

Cache 4xx and 5xx responses briefly to protect origin from thundering herds when content is missing or origin is degraded. CloudFront has built-in error caching controls:

- **Error TTL** per status code: 404, 403, 500, 502, 503, 504. Default error TTLs are short; tune per behavior.
- Too-long error TTLs cause users to see stale errors after origin recovery; too-short error TTLs let a sick origin get pummeled.
- Set error TTLs longer for predictable-missing content (user-generated 404s) and shorter for infrastructure errors (504s on a degraded origin).

```typescript
new cloudfront.Distribution(this, 'Dist', {
  defaultBehavior: { origin },
  errorResponses: [
    { httpStatus: 404, ttl: cdk.Duration.seconds(30) },
    { httpStatus: 500, ttl: cdk.Duration.seconds(5) },
    { httpStatus: 502, ttl: cdk.Duration.seconds(5) },
    { httpStatus: 503, ttl: cdk.Duration.seconds(5) },
    { httpStatus: 504, ttl: cdk.Duration.seconds(5) },
  ],
});
```

Combine with `stale-if-error` for best results: serve stale content during origin outages, fall back to error caching only when no stale content exists.

## Custom error pages

CloudFront can return a custom response for origin errors — either a different status code, a custom HTML body from S3, or both. Use for:

- Branded 404 and 5xx pages that match the app's design.
- Converting origin 403s (from an S3 OAC miss) into 404s for security (don't reveal that a key exists but is restricted).
- Returning a maintenance page during deployments.

```typescript
errorResponses: [
  {
    httpStatus: 404,
    responseHttpStatus: 404,
    responsePagePath: '/errors/404.html',
    ttl: cdk.Duration.seconds(30),
  },
  {
    httpStatus: 403,
    responseHttpStatus: 404, // translate 403 to 404
    responsePagePath: '/errors/404.html',
  },
];
```

The response page must be cacheable from an origin the distribution can reach. Point at a dedicated S3 bucket with the error pages; don't reuse the main app origin because the error page must be independently available.

## Edge-level origin offload metrics

Track cache hit ratio per behavior, not per distribution. A distribution with many behaviors can have a high aggregate hit ratio while one behavior (the expensive API) has zero hits. CloudWatch CloudFront metrics expose per-distribution; CloudFront access logs expose per-request and can be aggregated by behavior via Athena. See [`performance-tuning.md`](performance-tuning.md) for the measurement pipeline.

The metrics that matter:

- **Cache hit ratio** per behavior and overall.
- **Origin latency** (time from CloudFront POP to origin first byte).
- **Total request latency** (viewer to CloudFront to origin to CloudFront to viewer).
- **Bytes downloaded** per behavior (data transfer cost driver).
- **Error rate** by status family, per behavior.

Cache policies are the lever; metrics are the feedback loop. Tune policies only based on measured behavior.

## Cookie handling at the cache key

Cookies in the cache key are usually wrong. They fracture the cache by per-user state and are the number-one reason cache hit ratios collapse. Rules:

- **Session cookies** (`sessionid`, `JSESSIONID`, `connect.sid`): never in the cache key. Forward via origin request policy only.
- **Language/locale cookies** (`lang=en-US`): in the cache key if the response varies by language and you cannot serve a language-neutral page with client-side switching.
- **A/B bucket cookies** (`ab_bucket=variant-b`): in the cache key when the rendered page differs by bucket. See [`edge-functions.md`](edge-functions.md) for the CFF pattern that sets a bucket cookie and keys cache on it.
- **Tenant cookies** (`tenant=acme`): in the cache key when content differs per tenant. Prefer URL-based tenancy (`/acme/*`) over cookie-based because URLs are easier to reason about.
- **CSRF tokens, OAuth state**: never in cache key. Forward via origin request policy only.

When in doubt, remove the cookie from the cache key and measure the hit ratio difference. The cost of an incorrect cache key is cache corruption (one user's content served to another); the cost of a missing cache key is degraded hit ratio. Start narrow, widen if needed, measure continuously.

## Query-string canonicalization

Normalize query strings before they hit the cache key. Two viewers requesting `/search?q=hello&page=1` and `/search?page=1&q=hello` should hit the same cache entry. CloudFront sorts query string parameters alphabetically for the cache key when you configure query-string caching via allowlist. It does not deduplicate or normalize casing.

For apps that emit non-canonical query strings (legacy backends, third-party embeds adding tracking), use a CFF on viewer-request to:

1. Drop known tracking params (`utm_*`, `gclid`, `fbclid`, `msclkid`, `ref`).
2. Lowercase param names if the origin is case-insensitive.
3. Sort parameters.

The cache hit ratio improvement is measurable on any real app.

## Per-behavior vs per-path caching

A common anti-pattern is adding a new behavior for every slightly-different path. Behaviors are expensive (quota-bounded, increase evaluation cost per request). Use behaviors for genuinely different origin or policy combinations; use cache policies to differentiate by path characteristics within a behavior when possible.

Good behavior count: 3-8 per distribution. More than a dozen suggests behaviors are being used as routing, which should be the app's job at origin.

## Policy lifecycle and versioning

Cache policies, origin request policies, and response headers policies are versioned resources. Updating a managed policy is not possible (AWS owns them). Updating a custom policy affects every behavior that references it. Treat policies as immutable once production behaviors depend on them:

- Name policies descriptively. `TenantKeyed-v1`, `TenantKeyed-v2`. Do not edit `v1` in place; create `v2`.
- Migrate behaviors from `v1` to `v2` deliberately. Do a canary behavior first, measure, then roll.
- Delete unused policy versions on a schedule; CloudFront has quotas on total policies per account. Link: [quotas docs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html).

## Debugging cache behavior

The `X-Cache` response header tells you whether CloudFront served from cache:

- `Hit from cloudfront`: cache hit at the POP.
- `RefreshHit from cloudfront`: served from cache after a conditional origin revalidation.
- `Miss from cloudfront`: cache miss; fetched from origin.
- `Error from cloudfront`: error served.

The `Age` response header shows how long the object has been cached. `X-Amz-Cf-Pop` tells you which POP served the response. `X-Amz-Cf-Id` is the request ID, useful for AWS support cases.

For systematic cache diagnosis:

1. Check `X-Cache`; if consistent `Miss`, the cache policy is too narrow or TTLs are zero.
2. Check origin `Cache-Control` headers; if origin says `no-store` or `private`, CloudFront honors it.
3. Check the cache key inputs; a too-wide key (full cookies, full query strings) fractures the cache.
4. Check path pattern matching; the wrong behavior may be selected.
5. Run the same request from different POPs (different geographies or via a test harness) to rule out cold-POP warm-up.

See [`troubleshooting.md`](troubleshooting.md) for a deeper diagnostic flow.

## Cache warming

Warming the cache before a traffic spike (marketing event, product launch, reTvent keynote) avoids first-request latency hits. Two patterns:

- **Synthetic fan-out**: issue requests to every POP (via a distributed load generator with viewers in each major region) for the high-value URLs. This primes each POP's cache.
- **Origin Shield fan-in**: enable Origin Shield in the region near the origin. All POPs pull from the Shield, so warming the Shield is one request per URL instead of one-per-POP.

Use Origin Shield warming when the URL set is small and the Shield savings already justify the feature. Use synthetic fan-out when Shield is not enabled and the spike is time-critical. For most workloads, graceful ramp from normal traffic warms the cache without special work.

## Cross-behavior policy reuse

One policy can attach to many behaviors across many distributions. This is the right model for security headers (one `AppSecurityHeaders` RHP across every distribution the org owns). Less right for cache policies, where the cache key is behavior-specific. Default: share RHPs aggressively, cache policies sparingly.

## Bypassing the cache deliberately

Some paths need to bypass cache entirely: real-time APIs, auth endpoints, payment flows, live data feeds. Make the bypass explicit:

- Attach the `CachingDisabled` managed cache policy.
- Set origin `Cache-Control: no-store, private` as defense in depth.
- Keep the behavior on its own path pattern so a future refactor doesn't silently start caching auth responses.

Never set TTLs to zero on a behavior that otherwise looks cacheable; it invites future engineers to "fix" the zero. Use `CachingDisabled` explicitly.

## Related

- [`distributions-and-origins.md`](distributions-and-origins.md) - origin lockdown, VPC Origins, ALB migration runbook.
- [`security-and-access.md`](security-and-access.md) - response headers policies for HSTS/CSP/XFO.
- [`edge-functions.md`](edge-functions.md) - CloudFront Functions for cookie-based A/B keying, device class normalization.
- [`performance-tuning.md`](performance-tuning.md) - cache hit ratio optimization, compression tuning.
- [`troubleshooting.md`](troubleshooting.md) - diagnosing cache misses, `Cache-Control` not honored, invalidation delays.
- [`pricing-and-plans.md`](pricing-and-plans.md) - invalidation cost model, cache tag pricing.
