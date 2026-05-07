# CloudFront Troubleshooting

Always start with the CloudFront debug headers. Every CloudFront response identifies the POP that served it and carries a unique request ID you can grep in standard logs. Any troubleshooting that does not begin with `curl -I` against the distribution is wasted effort. Learn the four headers (`x-amz-cf-pop`, `x-amz-cf-id`, `x-cache`, `Age`), internalize the "error from cloudfront vs error from origin" distinction, and the majority of CloudFront issues resolve in minutes instead of hours.

## Contents

- [Debug headers](#debug-headers)
- [4xx and 5xx debugging flowchart](#4xx-and-5xx-debugging-flowchart)
- [Cache miss diagnosis](#cache-miss-diagnosis)
- [OAC permission errors](#oac-permission-errors)
- [Invalidation debugging](#invalidation-debugging)
- [Edge function errors](#edge-function-errors)
- [Client IP: CloudFront-Viewer-Address vs X-Forwarded-For](#client-ip-cloudfront-viewer-address-vs-x-forwarded-for)
- [Alternate domain name (CNAME) errors](#alternate-domain-name-cname-errors)
- [Viewer mTLS debugging](#viewer-mtls-debugging)
- [Real-time vs standard logs for debugging](#real-time-vs-standard-logs-for-debugging)
- [Common issues table](#common-issues-table)
- [Related](#related)

## Debug headers

Every CloudFront response includes diagnostic headers. Run `curl -I https://your-distribution.example.com/path` and inspect:

| Header | Meaning |
|---|---|
| `x-amz-cf-pop` | POP that served the response. Format: airport code + POP number (e.g., `IAD79-P3` = Dulles POP 79, phase 3). |
| `x-amz-cf-id` | Unique request ID. Grep standard logs for this value to pull the full request trace. |
| `x-cache` | Cache state. See table below. |
| `Age` | Seconds since this response was cached at this POP. NOT seconds since origin generated it. |
| `Server` | Normally `CloudFront`. |
| `Via` | Protocol and CloudFront version. |

### `x-cache` values

| Value | Meaning |
|---|---|
| `Hit from cloudfront` | Served from POP cache. Origin not contacted. |
| `Miss from cloudfront` | Cache miss. Request went to origin. |
| `RefreshHit from cloudfront` | Stale cache entry revalidated with origin (conditional GET) and was still fresh. |
| `Error from cloudfront` | CloudFront generated the error, NOT the origin. Configuration or connectivity issue. |
| `LimitExceeded from cloudfront` | Rate limited by CloudFront (usually due to per-distribution service limits). |
| `RedirectFromCloudFront from cloudfront` | CloudFront issued a redirect (e.g., HTTP-to-HTTPS). |

### Example

```
$ curl -I https://d111111abcdef8.cloudfront.net/index.html
HTTP/2 200
content-type: text/html
content-length: 1547
date: Wed, 06 May 2026 14:00:00 GMT
last-modified: Tue, 05 May 2026 09:00:00 GMT
etag: "a1b2c3d4"
age: 3421
x-cache: Hit from cloudfront
via: 1.1 abcdef0123456789.cloudfront.net (CloudFront)
x-amz-cf-pop: IAD79-P3
x-amz-cf-id: ABC123def456GHI789jkl012MNO345pqr==
```

Interpretation: served by IAD79 POP, cached 3421 seconds ago, cache hit. `x-amz-cf-id` is the grep key for logs.

## 4xx and 5xx debugging flowchart

The single most important question: did CloudFront generate the error, or did the origin? The `x-cache` header tells you immediately.

```
Response status is 4xx or 5xx?
|
+-- x-cache: "Error from cloudfront"
|   |
|   +-- Status 403 -> Check: matching cache behavior exists for the path?
|   |                        Distribution deployed (not InProgress)?
|   |                        Viewer protocol mismatch (HTTP to HTTPS-only behavior)?
|   |                        WAF block? Check WAF logs.
|   |
|   +-- Status 502 -> Origin TLS/cert mismatch.
|   |                 Origin does not support HTTP/2.
|   |                 Origin keep-alive misconfiguration.
|   |                 Check Origin Connection Attempts alarm.
|   |
|   +-- Status 504 -> Origin response timeout exceeded.
|                     Raise timeout or fix slow origin.
|                     Check origin CloudWatch metrics.
|
+-- x-cache: "Miss from cloudfront" with 4xx/5xx
    |
    +-- Origin returned the error.
    +-- Get x-amz-cf-id.
    +-- Check origin logs for matching request (if origin forwards the ID header).
    +-- Fix at origin.
```

### Specific patterns

**`403 Forbidden` from S3 via OAC.** Bucket policy, KMS policy, or object existence issue. See [OAC permission errors](#oac-permission-errors) below.

**`504 Gateway Timeout`.** Origin took longer than the configured origin response timeout. Two fixes: make the origin faster, or raise the timeout. Raising the timeout is usually wrong — it masks a real latency issue.

**`502 Bad Gateway`.** Origin returned something CloudFront could not parse, or the TLS handshake failed. Common causes:

- Origin's TLS certificate expired or does not cover the origin hostname.
- Origin does not support HTTP/2 but the distribution is configured for it (rare — CloudFront negotiates down).
- Origin keep-alive closes connections mid-response.
- Origin returns malformed HTTP (non-standard status line, bad headers).

Test origin directly with `curl --resolve origin.example.com:443:<origin-ip> https://origin.example.com/`. If `curl` works and CloudFront does not, it is a CloudFront-to-origin config issue.

## Cache miss diagnosis

Low `CacheHitRate` drains origin capacity and inflates bills. Diagnosis sequence:

### 1. Check cache key dimensions

Inspect the cache policy attached to the behavior. List every dimension included:

- Forwarded headers in cache key.
- Forwarded cookies in cache key.
- Forwarded query strings in cache key.

Every added dimension multiplies cache variants. `User-Agent` in the cache key means effectively no cache — every browser/OS version gets its own entry.

### 2. Check origin `Vary` headers

Origin responses with `Vary: User-Agent` or `Vary: *` destroy CloudFront's cache. Strip these at the origin or via a response headers policy override.

`Vary: Accept-Encoding` is fine — CloudFront handles compression negotiation separately.

### 3. Check for no-store origin responses

Origin returning `Cache-Control: no-store` or `Cache-Control: private` makes the response uncacheable regardless of cache policy. Audit origin response headers. If the origin is wrongly marking cacheable content as private, fix the origin.

### 4. Check query-string normalization

Historic behavior was order-sensitive for query strings. Modern CloudFront normalizes — link to the [current CloudFront cache key documentation](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cache-key-understand.html). If your origin is still on the legacy behavior for legacy reasons, `?a=1&b=2` and `?b=2&a=1` produce different cache entries.

### 5. Cookie forwarding set to all

If the behavior forwards all cookies, every unique cookie combination is a cache variant. Narrow to specific cookies by name, or forward none if cookies do not affect the response.

### 6. Baseline `CacheHitRate` and alarm on drift

A sustained CHR drop almost always means someone changed the cache key or the origin changed its Cache-Control. Alarm on `CacheHitRate` in CloudWatch — see `performance-tuning.md`.

## OAC permission errors

Origin Access Control (OAC) is the correct pattern for S3 origins. OAI is deprecated — if you are on OAI, migrate. See `security-and-access.md`.

### `403 AccessDenied` on S3

The bucket policy must allow the CloudFront service principal with an `aws:SourceArn` condition matching the distribution ARN. Correct policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowCloudFrontServicePrincipalReadOnly",
      "Effect": "Allow",
      "Principal": { "Service": "cloudfront.amazonaws.com" },
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::my-origin-bucket/*",
      "Condition": {
        "StringEquals": {
          "AWS:SourceArn": "arn:aws:cloudfront::123456789012:distribution/EXAMPLEID"
        }
      }
    }
  ]
}
```

Common mistakes:

- Missing the `aws:SourceArn` condition — the policy is valid but any CloudFront distribution could access the bucket. AWS requires the condition.
- Wrong `SourceArn` — distribution ID mismatch.
- Missing `s3:ListBucket` if you need to return `404` vs `403` correctly — this is optional but often desired.

### SSE-KMS on the origin bucket

If the bucket uses SSE-KMS, the KMS key policy must grant CloudFront service principal:

- `kms:Decrypt` — required to read encrypted objects.
- `kms:GenerateDataKey*` — required only if CloudFront writes to the bucket (e.g., streaming ingest scenarios). Read-only origins do not need this.

```json
{
  "Sid": "AllowCloudFrontToUseKey",
  "Effect": "Allow",
  "Principal": { "Service": "cloudfront.amazonaws.com" },
  "Action": [ "kms:Decrypt" ],
  "Resource": "*",
  "Condition": {
    "StringEquals": {
      "AWS:SourceArn": "arn:aws:cloudfront::123456789012:distribution/EXAMPLEID"
    }
  }
}
```

### Forgot to enable signing on the origin

OAC requires the distribution's origin config to set `signing_behavior` to `always` (or `no-override`) and `signing_protocol` to `sigv4`. In CDK, use `S3BucketOrigin.withOriginAccessControl(bucket)` — it handles this correctly.

## Invalidation debugging

### Propagation

Invalidations take time to propagate to all POPs. Link to the [CloudFront invalidation documentation](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/Invalidation.html) for the current propagation SLA. During propagation, different POPs may serve different versions of the content.

### Check status

```
aws cloudfront get-invalidation \
  --distribution-id EXAMPLEID \
  --id IEXAMPLEIDID
```

Status values:

- `InProgress` — still propagating.
- `Completed` — fully propagated to all POPs.

### Wildcard invalidation cost

`/*` invalidates everything and counts as a single invalidation path, but wildcard invalidations are rate-limited per tier. Prefer tag-based invalidation (link to `cache-behaviors-and-policies.md`) — it invalidates by cache tag header without path enumeration.

### Tag invalidation (2026-04)

Cache-tag invalidation requires the origin to return the tag header (typically `Cache-Tag` or the CloudFront-specific header name) on the cached response. If the tag is missing from the cached entry, tag invalidation does not apply to it.

Debug by inspecting the cached entry's headers via `curl -I`. If the tag header is absent, the origin did not emit it when the entry was cached, and tag invalidation will miss.

## Edge function errors

### CloudFront Functions (CFF)

CFF errors generally produce a `503` response to the viewer. CFF logs go to CloudWatch Logs in **us-east-1** regardless of which POP executed the function.

Common CFF errors:

- **Syntax error.** Caught at publish time. Deploy fails, the distribution keeps serving with the previous function version.
- **Runtime `TypeError` on event structure.** Usually because the code assumes a header is always present (e.g., `req.headers.cookie.value` when the request has no cookies). Log the full event and guard access.
- **CPU-time budget exceeded.** CFF has a strict CPU-time budget — link to the [CFF runtime documentation](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-functions.html). Heavy logic belongs in L@E, not CFF.
- **KVS lookup timeout.** KVS calls count against the budget. Cache hot keys in function memory across invocations if the language-runtime semantics allow.

Read logs:

```
aws logs tail /aws/cloudfront/function/<function-name> --region us-east-1 --follow
```

### Lambda@Edge (L@E)

L@E logs go to CloudWatch Logs in the **region where the function executed**, which is the nearest region to the POP. A global audience means logs spread across many regions. Check every region or use CloudWatch cross-region search.

Common L@E issues:

- **Throttling.** Per-region concurrent execution limits apply. A viral spike in one region can throttle L@E and cause origin-request failures. Link to [L@E quotas](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html).
- **Cold starts.** L@E has cold starts. For latency-sensitive paths, reconsider whether the logic belongs in CFF instead.
- **Async/await handlers.** Modern L@E uses async/await. Legacy callback-style handlers are deprecated — migrate.
- **Event signature changes.** L@E event shapes evolve; pin to a specific L@E feature version in the function configuration.

### When to pick CFF vs L@E

| Task | Use |
|---|---|
| Header rewrite, URL rewrite, simple auth check | CFF |
| KVS lookup, simple signature verification | CFF |
| HTTP outbound call to another service | L@E |
| Full JavaScript/Python runtime with libraries | L@E |
| Anything that must not cold-start | CFF |

Defaulting to CFF is correct for the vast majority of edge logic.

## Client IP: CloudFront-Viewer-Address vs X-Forwarded-For

**Use `CloudFront-Viewer-Address`. Not `X-Forwarded-For`.**

### `CloudFront-Viewer-Address`

Format: `IP:PORT`. Single value, always the real viewer's IP. Example: `203.0.113.42:54321`.

Enable by using an origin request policy that includes this header. The managed `AllViewer` policy includes it, as do `AllViewerAndCloudFrontHeaders-2022-06` and newer variants.

Parse:

```typescript
// Origin handler pseudocode
const headerValue = request.headers['cloudfront-viewer-address'];
const viewerIp = headerValue.split(':')[0];
```

### Why not `X-Forwarded-For`

CloudFront appends the viewer's IP to any existing `X-Forwarded-For` chain. If the viewer is behind a proxy that also sets `X-Forwarded-For`, your origin receives a comma-separated chain — not a single IP. Parsing the chain correctly is error-prone and security-relevant (attackers can forge upstream XFF entries).

`CloudFront-Viewer-Address` is authoritative: it is set by CloudFront itself based on the actual TCP connection from the viewer. There is no way for the viewer to forge it.

## Alternate domain name (CNAME) errors

### `The specified alias does not exist`

Checklist:

- **ACM certificate in us-east-1.** CloudFront requires certificates from ACM in us-east-1 only, regardless of where your origin lives.
- **Certificate covers the CNAME.** Subject or SAN must match the alternate domain name. Wildcard certs cover only one subdomain level.
- **Certificate is issued.** Check status is `ISSUED`, not `PENDING_VALIDATION`.
- **DNS validation CNAMEs in place.** If the cert is stuck pending, ACM's validation CNAMEs may not have propagated.

### DNS not propagated

After pointing the CNAME/ALIAS at the distribution domain, DNS propagation can take up to the TTL of the previous record. `dig +short www.example.com` to confirm.

### Distribution still deploying

Newly-created or newly-updated distributions have a `Deployed` state. Until the state flips to `Deployed`, some POPs still serve the old config. Wait or check via `aws cloudfront get-distribution`.

## Viewer mTLS debugging

Viewer mTLS (client certificate authentication) is a Business-tier+ feature. Common issues:

- **Client cert rejected.** The trust store attached to the distribution does not include the issuer CA. Add the issuing CA to the trust store (or the root if intermediate is attached to the client cert chain).
- **Client did not present a cert.** TLS handshake completed without the optional client certificate. Inspect via a TLS record capture (Wireshark, `openssl s_client -cert client.pem -key client.key -connect ...`). If the client does not support or was not configured to send a cert, the handshake completes without it.
- **Revocation.** If you configured OCSP or CRL checking, a revoked cert is rejected. Check the revocation log.

## Real-time vs standard logs for debugging

For active incident debugging, you need fast feedback. The tradeoff:

| Log tier | Latency | When to use |
|---|---|---|
| Standard logs (Parquet hourly) | ~30–60 min | Post-incident analysis, root-cause, periodic reports. |
| Real-time logs (Kinesis) | Sub-minute | Active debugging, attack-in-progress investigation. |

For normal troubleshooting, standard logs via Athena suffice. Enable real-time logs temporarily during incidents — then disable to control cost. See `pricing-and-plans.md` for cost detail.

## Common issues table

| Symptom | Likely cause | Fix |
|---|---|---|
| `403` with `x-cache: Error from cloudfront` | WAF blocked, no matching behavior, distribution not deployed | Check WAF logs, verify behavior patterns, wait for deploy |
| `403 AccessDenied` from S3 | OAC bucket policy missing or wrong `SourceArn` | Correct bucket policy (see OAC section) |
| `502 Bad Gateway` | Origin TLS mismatch, malformed response | Test origin directly; fix origin cert/config |
| `504 Gateway Timeout` | Origin too slow for timeout | Speed up origin or raise timeout (origin fix preferred) |
| Low `CacheHitRate` | Cache key too broad, origin `Vary` too aggressive, origin `no-store` | Narrow cache policy, strip `Vary`, fix origin cache headers |
| Invalidation not taking effect | Still `InProgress`; wildcard hit rate limit; tag not emitted by origin | Wait; switch to tag invalidation; verify tag header |
| `Alt-Svc` not upgrading to H3 | HTTPS DNS record missing, client does not support H3 | Add HTTPS DNS record (see `performance-tuning.md`) |
| CFF returns `503` | Runtime error in function | Check CloudWatch Logs in us-east-1 |
| L@E throttling | Regional concurrency limit hit | Raise limit or move logic to CFF |
| Alternate domain error | ACM cert not in us-east-1, cert doesn't cover CNAME | Request cert in us-east-1 with correct SAN |
| Wrong client IP at origin | Using `X-Forwarded-For` instead of `CloudFront-Viewer-Address` | Switch to `CloudFront-Viewer-Address` with `AllViewer` origin request policy |
| `Vary: User-Agent` destroying cache | Origin emits the header | Strip at origin or via response headers policy |
| OAI still in use | Legacy distribution | Migrate to OAC (see `security-and-access.md`) |

## Athena queries for log correlation

Standard logs in Parquet v2 format with hourly partitioning are queryable via Athena. Useful queries:

### Find a single request by ID

```sql
SELECT *
FROM cloudfront_standard_logs
WHERE date = '2026-05-06'
  AND hour = '14'
  AND x_edge_request_id = 'ABC123def456GHI789jkl012MNO345pqr=='
```

Partition-pruned to a single hour, returns immediately.

### Error-status breakdown by path

```sql
SELECT
  cs_uri_stem AS path,
  sc_status AS status,
  COUNT(*) AS count
FROM cloudfront_standard_logs
WHERE date = '2026-05-06'
  AND sc_status >= 400
GROUP BY 1, 2
ORDER BY count DESC
LIMIT 100;
```

Surfaces the top error paths for the day. Start investigation with the highest-count path.

### Cache hit ratio by behavior

```sql
SELECT
  regexp_extract(cs_uri_stem, '^(/[^/]+)', 1) AS top_path,
  SUM(CASE WHEN x_edge_result_type IN ('Hit', 'RefreshHit') THEN 1 ELSE 0 END) * 1.0
    / COUNT(*) AS chr,
  COUNT(*) AS total_requests
FROM cloudfront_standard_logs
WHERE date = '2026-05-06'
GROUP BY 1
HAVING COUNT(*) > 1000
ORDER BY chr ASC;
```

Low-CHR paths at the top are the tuning targets.

### POP distribution

```sql
SELECT
  x_edge_location AS pop,
  COUNT(*) AS requests,
  AVG(time_taken) AS avg_time_taken
FROM cloudfront_standard_logs
WHERE date = '2026-05-06'
GROUP BY 1
ORDER BY requests DESC;
```

Shows which POPs serve your audience. Informs price class decisions.

## Origin connectivity testing

Test origin independently of CloudFront to isolate which layer has the problem:

### Direct TLS handshake test

```
openssl s_client -connect origin.example.com:443 -servername origin.example.com < /dev/null
```

Verifies the origin's TLS cert, chain, and hostname. If this fails, CloudFront cannot reach the origin either.

### HTTP/2 support test

```
curl --http2 -I https://origin.example.com/
```

CloudFront prefers HTTP/2 to the origin when available. If the origin does not support H2, CloudFront falls back to H1 — usually fine, but if the origin has bugs on H1 that were masked by always receiving H2 from clients, the fallback can surface them.

### Origin from a specific region

```
curl --resolve origin.example.com:443:<origin-ip-in-target-region> -I https://origin.example.com/
```

Simulates a CloudFront POP in that region reaching the origin. Useful for diagnosing region-specific origin routing issues.

## Runbook: cache hit ratio regression

When `CacheHitRate` drops suddenly:

1. **Identify the change window.** Correlate the CHR drop time with recent deploys, cache policy changes, origin deploys.
2. **Check origin `Cache-Control` changes.** Sample a few responses: `curl -I https://origin.example.com/some-path`. Compare `Cache-Control` against what was being returned previously.
3. **Check cache policy dimensions.** Has a header been added to the cache key recently?
4. **Check `Vary` headers.** Did the origin start emitting `Vary: User-Agent` or similar?
5. **Check query-string normalization.** Is a new query string appearing in viewer traffic that varies by user (tracking pixel, A/B test, etc.)?
6. **Look at top cache-miss URLs.** Athena query on `x_edge_result_type = 'Miss'`. The top paths reveal what is missing.

## Runbook: TTFB regression

When TTFB spikes:

1. **Cache hit or miss?** `x_edge_result_type` in logs. If miss, origin is the issue. If hit, it's edge processing.
2. **Origin latency.** If miss, check origin CloudWatch metrics: `TargetResponseTime` on the ALB, function duration on Lambda, etc.
3. **Edge-function latency.** If hit with high TTFB, check for a viewer-request CFF or L@E that has regressed. CFF CPU-time metrics in CloudWatch Logs.
4. **POP saturation.** Unlikely but possible. Check `x_edge_location` distribution — are responses concentrated in one POP that might be experiencing a local issue? Open a support case.

## Runbook: origin 5xx surge

When origin 5xx surges:

1. **Is CloudFront returning stale via `stale-if-error`?** If yes, viewers see success — origin alarm fires but user impact is low. Prioritize origin fix, not emergency CloudFront change.
2. **Origin overload.** Check origin compute metrics. If saturated, the fix is origin scaling or cache tuning to reduce origin load.
3. **Origin deploy regression.** Roll back origin.
4. **Origin network issue.** Check VPC flow logs, NAT gateway metrics, egress connectivity to upstream dependencies.

## Related

- `distributions-and-origins.md` — origin config, failover, Origin Shield, VPC Origins.
- `cache-behaviors-and-policies.md` — cache policies, invalidation, tag-based invalidation.
- `edge-functions.md` — CFF and L@E runtime details.
- `security-and-access.md` — OAC, viewer mTLS, signed URLs.
- `performance-tuning.md` — `CacheHitRate` alarms, HTTPS DNS records, logging tier choice.
- `pricing-and-plans.md` — standard vs real-time log costs.
- `agentic-patterns.md` — edge-function patterns, content negotiation, KVS routing.
- `../aws-waf/references/troubleshooting.md` — WAF-block debugging when CloudFront shows `403 Error from cloudfront`.
