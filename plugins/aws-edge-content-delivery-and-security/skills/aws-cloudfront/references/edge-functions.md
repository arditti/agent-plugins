# Edge Functions

How to pick between CloudFront Functions and Lambda@Edge, and how to use each correctly. Default is CloudFront Functions. Lambda@Edge is the fallback for cases CloudFront Functions cannot express. The most common production mistakes are using Lambda@Edge for simple URL rewrites, using Lambda@Edge for security headers (a Response Headers Policy is the right tool), and using the legacy `callback`-style Lambda@Edge handler.

## Contents

- [Always Read the Current Edge Functions Docs First](#always-read-the-current-edge-functions-docs-first)
- [Decision framework: CFF vs Lambda@Edge](#decision-framework-cff-vs-lambdaedge)
- [JavaScript Runtime 2.0: Capabilities and Restrictions](#javascript-runtime-20-capabilities-and-restrictions)
- [CloudFront Functions runtime](#cloudfront-functions-runtime)
- [CloudFront Functions KV Store](#cloudfront-functions-kv-store)
- [CloudFront Functions with CBOR Web Tokens](#cloudfront-functions-with-cbor-web-tokens)
- [Host header rewriting for multi-tenant VPC Origins](#host-header-rewriting-for-multi-tenant-vpc-origins)
- [Origin-request modifications in CloudFront Functions](#origin-request-modifications-in-cloudfront-functions)
- [Lambda@Edge: async/await handler](#lambdaedge-asyncawait-handler)
- [Lambda@Edge event types](#lambdaedge-event-types)
- [Lambda@Edge restrictions](#lambdaedge-restrictions)
- [Lambda@Edge logging](#lambdaedge-logging)
- [Anti-patterns](#anti-patterns)
- [Recipes](#recipes)
- [Related](#related)

## Always Read the Current Edge Functions Docs First

CloudFront Functions AND Lambda@Edge are fast-evolving. AWS regularly adds JavaScript runtime capabilities to CFF (built-in modules, standard-library additions, new KVS methods, new event types like connection-request for mTLS), changes the list of Lambda features supported by L@E (runtimes, architectures, layers, container images, ephemeral storage size, body-size limits, etc.), and ships new integration points. Any snapshot embedded in this reference will drift.

**Before writing or modifying edge function code, ALWAYS fetch the current docs.** Use these pages as the source of truth. Prefer the `.md` version (swap `.html` → `.md` in the URL — see the SKILL.md section on this):

CloudFront Functions:

- Overview — <https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-functions.html>
- JavaScript runtime 2.0 features — <https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/functions-javascript-runtime-20.html>
- JavaScript runtime features index — <https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/functions-javascript-runtime-features.html>
- Writing function code — <https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/writing-function-code.html>
- KeyValueStore with CloudFront Functions — <https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/kvs-with-functions.html>

Lambda@Edge:

- **Restrictions on Lambda@Edge** — <https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-at-edge-function-restrictions.html> (the authoritative list of what Lambda features L@E does NOT support — updated regularly as AWS adds or removes feature support; read this page immediately before writing any L@E function)
- Requirements and restrictions overview — <https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-requirements-limits.html>
- Event structure — <https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-event-structure.html>
- L@E quotas — <https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html#limits-lambda-at-edge>
- Supported runtimes (via Lambda docs) — <https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html#runtimes-supported>

General:

- What's New for CloudFront — <https://aws.amazon.com/about-aws/whats-new/networking_and_content_delivery/?whats-new-content.sort-by=item.additionalFields.postDateTime&whats-new-content.sort-order=desc>

Agents using this skill with a live web-fetch capability (`WebFetch`, `mcp__awsknowledge__aws___read_documentation`, plain `curl`, or equivalent) should fetch these pages before committing to a design. The capability and restriction lists in later sections of this file are a guide to what to look for, NOT a promise of what's true today.

**Default to CFF runtime 2.0.** Only target runtime 1.0 when modifying an existing function already on 1.0; migrate to 2.0 at the next meaningful change.

**For L@E: re-read the restrictions page on every meaningful design.** The list of unsupported Lambda features shrinks and grows over time — provisioned concurrency, container images, `arm64`, larger ephemeral storage, customer-managed KMS keys have all shifted over the product's lifetime.

## Decision framework: CFF vs Lambda@Edge

Default to CloudFront Functions. Reach for Lambda@Edge only when CloudFront Functions cannot do the job.

| Use case                                                                | CloudFront Functions | Lambda@Edge |
| ----------------------------------------------------------------------- | -------------------- | ----------- |
| Viewer-request header rewriting                                          | Yes                  | Overkill    |
| Viewer-response header rewriting                                         | Use a Response Headers Policy first; CFF if dynamic | Overkill |
| URL rewrites (clean URLs, `/` → `/index.html`, lowercase paths)          | Yes                  | Overkill    |
| Simple auth at edge (JWT signature verify against a KV key, CBOR Web Token) | Yes               | Overkill    |
| A/B testing bucket assignment (cookie + KV lookup)                       | Yes                  | Overkill    |
| Geo-based redirects (`CloudFront-Viewer-Country`)                        | Yes                  | Overkill    |
| Canonicalizing or stripping query strings                                | Yes                  | Overkill    |
| Injecting request-id / tracking headers                                  | Yes                  | Overkill    |
| Simple bot gates (User-Agent and IP checks via KV allow/deny list)       | Yes                  | Overkill    |
| Host-header override to route to a multi-tenant VPC Origin               | Yes                  | Overkill    |
| Outbound HTTP call to a side-system mid-request                          | No                   | Yes         |
| Signing requests to origin with SigV4                                    | No                   | Yes         |
| Dynamic origin selection by custom logic that needs fetches              | Limited              | Yes         |
| Request-body inspection or rewriting                                     | No                   | Yes         |
| Response-body inspection or rewriting                                    | No                   | Yes         |
| Code > the CFF size limit                                                | No                   | Yes         |
| Node.js or Python runtime features                                       | No                   | Yes         |
| Cryptographic work beyond what the CFF runtime exposes                   | Depends on need      | Yes         |

State the rule explicitly: **CFF first, L@E only when forced**. Most "we use Lambda@Edge for header manipulation" stacks can move to CFF + a Response Headers Policy, cut per-request cost substantially, and drop execution latency to sub-millisecond.

## JavaScript Runtime 2.0: Capabilities and Restrictions

The CloudFront Functions JavaScript runtime is ECMAScript 5.1-compliant with selected ES 6–12 additions. This section is a summary — validate specifics against the docs linked in [Always Read the Current CloudFront Functions Docs First](#always-read-the-current-cloudfront-functions-docs-first).

### Core language features to rely on

- **Types**: all ES 5.1 types, plus ES 6 `let` / `const`, ES 6 arrow functions, ES 6 template literals, ES 6 rest parameters.
- **async / await**: supported. `await` is valid only inside `async` functions. Note: `async` arrow-function arguments and closures have limits — check the docs.
- **Strict mode**: always on. You do not and cannot `use strict` opt-out.
- **Recent additions** (runtime 2.0): `String.prototype.replaceAll()`, ES 12 numeric separators, `Promise.all()` / `allSettled()` / `any()` / `race()`, `atob()` / `btoa()` globals, full `DataView` prototype methods, `TypedArray.from()` / `of()` and expanded TypedArray prototype methods.

### Built-in objects of note

- `Math` (all ES 5.1 methods, selected ES 6 additions). `Math.random()` is seeded with the function start time — it is NOT cryptographically random. Use the Crypto module for entropy.
- `Date`: works normally, but **always returns the function's start time** during a single function run. You cannot measure elapsed time inside a function.
- Regular expressions: ES 5.1-compatible, Perl-compatible, plus ES 9 named capture groups.
- `JSON.parse` / `JSON.stringify`.
- `TextDecoder` / `TextEncoder`: available.
- `console.log`: supported, but **does NOT accept comma-separated arguments** (`console.log('a', 'b')` won't do what Node does). Concatenate manually: `console.log('a' + ' ' + 'b')`.

### Built-in modules

Runtime 2.0 exposes three built-in modules:

- **Buffer** — allocate, compare, concat, read/write byte data. Encodings: `utf8`, `hex`, `base64`, `base64url`. Use `Buffer.from(string, 'base64url')` to decode JWT segments. `Buffer.prototype.compare()` for constant-time-ish byte comparison. Full prototype method list in the live docs.
- **Query string** — `parse()` and `stringify()` helpers for URL query strings. Prefer over DIY parsing.
- **Crypto** — `createHash()` (`md5`, `sha1`, `sha256`) and `createHmac()` (`md5`, `sha1`, `sha256`). Use `createHmac('sha256', key)` for JWT HS256 verification. `hash.digest()` / `hmac.digest()` return a `Buffer` when no encoding is specified (runtime 2.0 behavior — runtime 1.0 returned different types).

Plus the CloudFront-specific `cloudfront` module exposing:

- `cloudfront.edgeLocation()` — the POP serving the request.
- `cloudfront.rawQueryString()` — unparsed query string.
- `cloudfront.kvs()` — access a KeyValueStore bound to the function. Methods to look for in live docs: `get`, `exists`, `meta`.

### KeyValueStore (KVS) use cases

- Feature flags / A/B bucket maps (tenant → variant).
- Short-URL redirect tables.
- Per-tenant backend routing tables (for `Host` header overrides to VPC origins).
- JWT signing-key rotations (store current + previous key; try both).
- Allowlists / denylists up to KVS size limits.

Link to <https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/kvs-with-functions.html> for current KVS limits and method signatures.

### Restricted features — what you cannot do

- **No network access**: no `fetch`, no `XMLHttpRequest`, no outbound HTTP/HTTPS. If you need an outbound call, use Lambda@Edge or originate the request through the origin.
- **No file system**.
- **No timers**: no `setTimeout`, `setImmediate`, `setInterval`.
- **No `require()`**: you cannot import npm packages. Only the built-in modules above.
- **No `eval()` or `Function()` constructor**.
- **No function constructors** (`new Function(...)`).
- **Non-standard String prototype methods from runtime 1.0** (`bytesFrom`, `fromBytes`, `fromUTF8`, `toBytes`, `toUTF8`) are removed in runtime 2.0 — migrate to `Buffer`.

### What you SHOULD use CFF for (abilities expand — verify in docs)

- Viewer-request header manipulation (add, remove, modify).
- Viewer-response header injection (security headers — but prefer Response Headers Policy).
- URL rewrites (clean URLs → indexfile, path canonicalization).
- Query-string normalization (drop `utm_*`, sort keys, remove sensitive values before cache key).
- Simple auth: JWT HS256 signature verification, CWT MAC0 verification, API-key lookups via KVS.
- A/B test bucket assignment via KVS.
- Geo-based redirects (using `cloudfront-viewer-country-*` headers CloudFront injects).
- Multi-tenant Host override to VPC Origin via KVS lookup.
- Request/response logging sampling or tagging.
- **Connection Functions (at TLS handshake time)** — currently supports mutual TLS (mTLS) connection requests. New event type; verify current availability and event-model structure in docs.

### What you SHOULD NOT use CFF for

- Anything requiring outbound network — use Lambda@Edge.
- Asymmetric JWT signature verification (RS256, ES256) — no RSA/ECDSA support in runtime; use Lambda@Edge with `jsonwebtoken` + `jwks-rsa`.
- JWKS fetching — no network.
- Code over the CFF size budget (see [Writing function code](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/writing-function-code.html)) — split or move to Lambda@Edge.
- Security headers that a Response Headers Policy handles natively (HSTS, CSP, X-Frame-Options, Referrer-Policy) — cheaper and no code to maintain.

### Migration: runtime 1.0 → 2.0

Compatibility differences:

- `hash.digest()` / `hmac.digest()` default return type changed to `Buffer` (was string/array in 1.0 depending on invocation).
- The non-standard `String.prototype.bytesFrom` / `fromBytes` / `fromUTF8` / `toBytes` / `toUTF8` methods are REMOVED. Replace with `Buffer` conversions.
- Many new library methods are added (see list above).

Migration is not automatic — re-test existing functions when switching. Review logs and sampled requests after the switch.

## CloudFront Functions runtime

CloudFront Functions is a JavaScript runtime (ECMAScript subset) that runs at every POP. Execution is synchronous, sub-millisecond, bounded on memory, CPU time, and function size. It supports viewer-request and viewer-response event types, plus (as of the 2025+ expansion) additional event types that extend what can be mutated at origin selection for VPC Origins. Check the [CloudFront Functions docs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-functions.html) for the current runtime version, event model, and limits.

Key runtime properties:

- Pure JavaScript; no `require` or `import`. Helpers are attached to the runtime's globals and a small standard library.
- No network calls. No environment variables. No persistent state inside the function.
- Per-invocation CPU time limit. Writing tight, allocation-free code matters for cost and execution.
- KV Store is the supported mechanism for "lookup this key at request time." See next section.

A minimal viewer-request function that rewrites clean URLs to an index file:

```javascript
function handler(event) {
  var request = event.request;
  var uri = request.uri;

  if (uri.endsWith('/')) {
    request.uri = uri + 'index.html';
  } else if (!uri.includes('.')) {
    request.uri = uri + '/index.html';
  }

  return request;
}
```

Publish via CDK:

```typescript
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';

const rewriteFn = new cloudfront.Function(this, 'RewriteFn', {
  code: cloudfront.FunctionCode.fromInline(/* the JS above */),
  runtime: cloudfront.FunctionRuntime.JS_2_0,
});

new cloudfront.Distribution(this, 'Dist', {
  defaultBehavior: {
    origin,
    functionAssociations: [{
      function: rewriteFn,
      eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
    }],
  },
});
```

## CloudFront Functions KV Store

KV Store (KVS) is a key-value lookup service accessible from CloudFront Functions. It is the right place for lookup tables used at the edge:

- Feature flag values.
- A/B test bucket weights.
- SaaS tenant → backend hostname mapping.
- Short URL redirect tables.
- Allow/deny lists (domains, user agents, token IDs).
- JWT/CBOR signing public keys.

Reads are fast and bounded. Writes propagate across the distribution's POPs; plan for eventual consistency on the order of seconds. Check the [KV Store docs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/kvs-with-functions.html) for current limits on keys, values, and throughput.

CDK binding a KVS to a function:

```typescript
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';

const kvs = new cloudfront.KeyValueStore(this, 'FlagsKvs', {
  keyValueStoreName: 'edge-flags',
});

const flagFn = new cloudfront.Function(this, 'FlagFn', {
  code: cloudfront.FunctionCode.fromInline(`
    import cf from 'cloudfront';
    const kvs = cf.kvs('<kvs-id>');
    async function handler(event) {
      const variant = await kvs.get('homepage_variant', { default: 'A' });
      event.request.headers['x-variant'] = { value: variant };
      return event.request;
    }
  `),
  runtime: cloudfront.FunctionRuntime.JS_2_0,
  keyValueStore: kvs,
});
```

The function imports `cloudfront` to access the KVS handle. The runtime supports `await`-style KVS reads in the 2.0 runtime.

## CloudFront Functions with CBOR Web Tokens

CBOR Web Tokens (CWT) are a compact binary alternative to JWT. Smaller on the wire, faster to parse at the edge, and a better fit for per-request verification in a latency-sensitive path. Use CWT when:

- The token is short-lived and re-issued often; smaller = less header overhead.
- The edge verifies millions of requests per second and JWT's JSON parse cost matters.
- The token embeds device or session state that would bloat a JSON token.

Verification pattern at the edge:

1. Extract the token from the request (cookie, `Authorization: Bearer ...`, custom header).
2. Look up the signing key in KVS by `kid`.
3. Verify the CWT signature with the CFF crypto API.
4. On failure, return a 401 from the function (no origin hit).
5. On success, pass the request through, optionally enriching headers with claims for the origin.

Check the [CFF crypto module docs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/functions-cloudfront-functions.html) for the exact signature-verification API.

Why not JWT with CFF? JWT works and is documented. CWT is an optimization for high-throughput paths; JWT is fine everywhere else. For traditional JWT, the same KVS pattern applies: store public keys by `kid`, look up, verify.

## Host header rewriting for multi-tenant VPC Origins

Multi-tenant apps often route `tenant-a.example.com` and `tenant-b.example.com` through the same distribution to the same VPC Origin (an internal ALB serving many tenants). The ALB routes to the right tenant based on `Host`. CloudFront's origin request policy `AllViewerExceptHostHeader` strips `Host` so the ALB needs something to route on.

The CFF pattern:

```javascript
async function handler(event) {
  var request = event.request;
  var host = request.headers.host.value; // tenant-a.example.com
  var tenant = host.split('.')[0];       // tenant-a

  // Rewrite Host to the internal ALB's expected hostname pattern.
  request.headers['x-tenant-id'] = { value: tenant };
  request.headers.host = { value: tenant + '.internal.example.com' };
  return request;
}
```

Attach as a viewer-request function. The origin request policy then forwards the rewritten `Host` (configure one that does not strip `Host`), and the ALB routes on the rewritten hostname.

For SNI on the TLS handshake to origin, CloudFront uses the configured origin hostname's SNI, not the header. Configure the VPC Origin hostname to match the tenant-agnostic internal name; do tenant routing via `Host` header at the ALB listener rules.

## Origin-request modifications in CloudFront Functions

The CFF event model includes event types beyond viewer-request/viewer-response for VPC Origin workflows. These let a function modify origin selection and outgoing request shape without a Lambda@Edge hop. Use for:

- Picking between two VPC Origins by path, header, or cookie.
- Rewriting the origin path (prefix strip, prefix add).
- Setting origin-specific headers not exposed to the viewer.

Check the [CFF event types docs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/functions-event-structure.html) for what is mutable in each event type; the set evolves.

## Lambda@Edge: async/await handler

Use the modern async/await handler. Do not use the legacy `callback(null, response)` pattern. The async handler is cleaner, integrates with async libraries, and matches every other Lambda runtime.

```typescript
import type { CloudFrontRequestEvent, CloudFrontRequestHandler } from 'aws-lambda';

export const handler: CloudFrontRequestHandler = async (event: CloudFrontRequestEvent) => {
  const request = event.Records[0].cf.request;

  // Example: fetch a signing secret from a side-system before forwarding.
  const signature = await signAtEdge(request);
  request.headers['x-signature'] = [{ key: 'X-Signature', value: signature }];

  return request;
};
```

Do NOT write this:

```typescript
// DO NOT USE - legacy callback-style handler
exports.handler = (event, context, callback) => {
  const request = event.Records[0].cf.request;
  callback(null, request); // legacy pattern; do not deploy new code like this
};
```

Both work, but the callback form is harder to compose with async I/O, leaks context across invocations if misused, and is not the pattern AWS docs and examples lead with anymore. Refactor any Lambda@Edge function you touch into async/await.

## Lambda@Edge event types

Four event types drive the choice of where to put logic.

| Event type        | Fires on                                  | Typical use                                                                  |
| ----------------- | ----------------------------------------- | ---------------------------------------------------------------------------- |
| `viewer-request`  | Every viewer request, pre-cache-lookup    | Auth, rewrites, redirects. CFF is usually the better tool here.              |
| `origin-request`  | Cache miss, before origin fetch           | SigV4 sign for API Gateway, dynamic origin selection, request-body transforms|
| `origin-response` | After origin responds, before caching     | Normalize response headers for consistent caching, strip sensitive headers.  |
| `viewer-response` | Every response to the viewer, post-cache  | Last-mile headers or logging. Response Headers Policies are usually better.  |

Rule: put logic at the event type closest to the concern. `origin-request` runs only on cache miss, so it is cheaper for work that should not run on every viewer request. `viewer-request` runs every time, which is what you want for auth decisions that must happen before cache lookup.

## Lambda@Edge restrictions

Lambda@Edge has real constraints that surprise teams migrating from regional Lambda.

**The authoritative list is at <https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-at-edge-function-restrictions.html> (fetch the `.md` version: <https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-at-edge-function-restrictions.md>) — AWS updates this page regularly as the service adds and removes support for Lambda features. ALWAYS read the current version before writing an L@E function. What's below is a snapshot of the load-bearing constraints; treat it as a guide to what to look for, not a promise of what's true today.**

### Region and versioning

- **Region**: Lambda function must be in `us-east-1` (US East, N. Virginia). CloudFront replicates to all POPs from there.
- **Version pinning**: associate a **numbered version** (e.g. `arn:...:function:my-fn:3`) with the distribution, NOT `$LATEST` and NOT an alias. Pinning is what lets CloudFront cache the replicated code per POP.
- **Deployment latency**: publishing a new version propagates across POPs over minutes; factor into rollback time.

### IAM execution role

The L@E function's execution role trust policy must allow BOTH service principals to assume it:

- `lambda.amazonaws.com`
- `edgelambda.amazonaws.com`

If only one is trusted, CloudFront cannot invoke the function at edge.

### Unsupported Lambda features (per the live docs at snapshot time)

The following regional Lambda features do NOT work for L@E — this list changes, re-check the live docs:

- **VPC attachment** — L@E runs outside VPC. No private-network calls without a public endpoint in between.
- **Environment variables** (except reserved ones like `AWS_REGION`, which are automatic) — bake config into code or fetch at invocation.
- **Lambda layers** — no layered dependencies; inline everything.
- **Dead letter queues**.
- **X-Ray tracing** (via the Lambda X-Ray integration).
- **Provisioned concurrency** — cannot pre-warm L@E. Cold starts at every POP.
- **Container images** — `.zip` only.
- **`arm64` architecture** — `x86_64` only.
- **Ephemeral storage > 512 MB** — `/tmp` is capped.
- **Customer-managed KMS keys for .zip encryption** — use AWS-managed only.
- **Runtime management** — auto-update only; cannot pin the runtime management mode.

Regional concurrency limits still apply across all your L@E functions — see the L@E quotas page.

### Supported runtimes

Lambda@Edge supports the latest Node.js and Python runtimes. Deprecated runtimes cannot be used for new or updated functions, though already-associated functions keep running. Always target the latest stable — check the [Lambda supported runtimes list](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html#runtimes-supported).

### HTTP status code on viewer response

Viewer-response L@E functions **cannot modify the HTTP status code** of the response, regardless of whether it came from origin or CloudFront cache. Modify headers and body only.

### CloudFront-added headers

Headers CloudFront adds (like `CloudFront-Viewer-Country`, `CloudFront-Viewer-Address`, etc.) are populated **after the viewer-request event**, so:

- `viewer-request` L@E functions do NOT see them.
- `origin-request` and `origin-response` L@E functions DO see them.

Also: a `viewer-request` function that tries to ADD `CloudFront-Viewer-Country` will fail validation with HTTP 502. Do not fake CloudFront-injected headers in viewer events.

Enable the headers via a **cache policy** or **origin request policy** — they aren't free.

### Request body (`include body` option)

When you enable "Include Body" so L@E can read/replace the request body, the following apply:

- Body is **base64-encoded** before exposure to L@E.
- **Truncation** if the body exceeds the limit:
  - `viewer-request`: 40 KB.
  - `origin-request`: 1 MB.
- If you read-only access the body, CloudFront still sends the full original body to origin.
- If your function REPLACES the body, return-size limits apply:
  - Plain text: same as truncation limits (40 KB viewer / 1 MB origin).
  - Base64-encoded text: 53.2 KB viewer / 1.33 MB origin.
- Exceeding the limit causes HTTP 502 (Lambda validation error).

### DNS resolution

For `origin-request` L@E, CloudFront resolves the origin domain **before** invoking the function. If DNS fails, the function never runs — CloudFront returns HTTP 502. If your function rewrites the origin domain, CloudFront performs a second DNS resolution after the function returns.

### Response timeout and keep-alive (custom origins)

L@E cannot override the distribution's origin response-timeout and keep-alive-timeout beyond what the origin itself supports. Align these across CloudFront and origin; CloudFront's value must be less than the origin idle timeout.

### What this means for design

- **No outbound API calls in `viewer-request`** if latency matters — you have ~5s max and cold-start overhead. Prefer `origin-request` for anything that fetches from a network.
- **Don't pass around large blobs** — the 40 KB viewer-request body limit kills patterns like "upload image, transform at edge". Push those to origin or Lambda Function URLs.
- **Reserved-concurrency settings don't apply the way they do in regional Lambda** — throttling is per-region-per-POP.
- **Logging lands in the regional CloudWatch Logs closest to the POP**, not in us-east-1. See the next section.
- **Config via environment variables is NOT an option on viewer events** — inject at build time, or fetch-and-cache from SSM Parameter Store / Secrets Manager in `origin-request`.

## Lambda@Edge logging

L@E writes CloudWatch Logs in the region where the function ran (the POP's closest region), not in `us-east-1`. To find logs for an errant request, use the `x-amz-cf-pop` header on the response to identify the POP and map to its region. Centralizing: use a CloudWatch Logs subscription filter to fan into a central account.

The L@E observability story has improved recently. Check [L@E logging docs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-edge-logs.html) for current log group conventions and sampling options. Use sampling for high-volume functions; full logging at edge scale is expensive and noisy.

## Anti-patterns

Stop doing these. Each has a correct replacement.

- **Lambda@Edge for security headers** (HSTS, CSP, X-Frame-Options, Referrer-Policy, Permissions-Policy). Use a Response Headers Policy. See [`security-and-access.md`](security-and-access.md).
- **Lambda@Edge for simple URL rewrites** (trailing slash, `/` → `/index.html`, lowercase paths). Use CloudFront Functions.
- **Callback-style L@E handlers** in new code. Use async/await.
- **Lambda@Edge for A/B flags with a static map**. Use CFF + KVS.
- **Regional Lambda with `fetch` to an origin via Function URL** when the work could run at the edge. The extra hop adds latency and cost.
- **Using `X-Forwarded-For` as the client IP**. Use `CloudFront-Viewer-Address` at the edge; it is unspoofable at the CloudFront boundary.
- **Bundling `aws-sdk` v2 in L@E**. Payload is too large and the SDK includes services you don't need. Use modular `@aws-sdk/client-*` imports.
- **Writing to DynamoDB on every viewer-request**. At edge scale you will hit WCU ceilings and cost will surprise. Asynchronize via SQS or batch via Kinesis; better, put the data in KVS if the shape fits.

## Recipes

### Clean-URL rewrite (CFF, viewer-request)

```javascript
function handler(event) {
  var request = event.request;
  if (request.uri.endsWith('/')) request.uri += 'index.html';
  else if (!request.uri.includes('.')) request.uri += '/index.html';
  return request;
}
```

### A/B test bucket via KVS + cookie (CFF, viewer-request)

```javascript
import cf from 'cloudfront';
const kvs = cf.kvs('<kvs-id>');

async function handler(event) {
  var req = event.request;
  var cookies = req.cookies;
  var bucket = cookies['ab_bucket'] && cookies['ab_bucket'].value;

  if (!bucket) {
    var weights = JSON.parse(await kvs.get('homepage_weights'));
    bucket = pickBucket(weights);
    req.headers['x-set-ab'] = { value: bucket };
  }
  req.headers['x-ab-bucket'] = { value: bucket };
  return req;
}
```

Set the cookie on the response with a viewer-response CFF that reads `x-set-ab` and emits `Set-Cookie: ab_bucket=...`.

### SigV4-sign to API Gateway origin (Lambda@Edge, origin-request)

```typescript
import { SignatureV4 } from '@aws-sdk/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';

const signer = new SignatureV4({
  service: 'execute-api',
  region: 'us-east-1',
  credentials: {
    // Credentials loaded from L@E execution role.
    accessKeyId: process.env.ACCESS_KEY!,
    secretAccessKey: process.env.SECRET!,
  },
  sha256: Sha256,
});

export const handler = async (event: any) => {
  const request = event.Records[0].cf.request;
  const signed = await signer.sign({
    method: request.method,
    hostname: request.origin.custom.domainName,
    path: request.uri,
    headers: flattenHeaders(request.headers),
    body: request.body?.data,
  });
  // Merge signed headers back into request.headers.
  return request;
};
```

Note: `origin-request` supports env vars (unlike `viewer-request`), so credentials from the execution role work. Origin-request runs on cache miss only.

### Inject request-scoped `x-request-id` (CFF, viewer-request)

```javascript
function handler(event) {
  var req = event.request;
  req.headers['x-request-id'] = { value: randomId() };
  return req;
}

function randomId() {
  // CFF runtime exposes crypto for this.
  var bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
```

Use it to correlate edge access logs, WAF logs, and origin access logs in a single trace.

### Multi-tenant Host override to VPC Origin (CFF, viewer-request)

See the [Host header rewriting section](#host-header-rewriting-for-multi-tenant-vpc-origins) above.

### Geo-based redirect (CFF, viewer-request)

```javascript
function handler(event) {
  var req = event.request;
  var country = req.headers['cloudfront-viewer-country'] &&
                req.headers['cloudfront-viewer-country'].value;

  if (country === 'DE' && !req.uri.startsWith('/de/')) {
    return {
      statusCode: 302,
      statusDescription: 'Found',
      headers: { 'location': { value: '/de' + req.uri } },
    };
  }
  return req;
}
```

Use `CloudFront-Viewer-Country` (populated by CloudFront) rather than inferring from IP. CloudFront's geo database is authoritative and maintained.

### IP-based access gate (CFF + KVS, viewer-request)

```javascript
import cf from 'cloudfront';
const kvs = cf.kvs('<kvs-id>');

async function handler(event) {
  var req = event.request;
  var viewerAddr = req.headers['cloudfront-viewer-address'].value;
  var ip = viewerAddr.split(':')[0];

  var allowed = await kvs.get('allow:' + ip, { default: null });
  if (!allowed) {
    return {
      statusCode: 403,
      statusDescription: 'Forbidden',
      body: 'IP not allowlisted',
    };
  }
  return req;
}
```

For simple corporate allowlists. For production security, use WAF IP sets; they compose better with the rest of the security stack. See [`../aws-waf/SKILL.md`](../aws-waf/SKILL.md).

### Canonical-host redirect (CFF, viewer-request)

```javascript
function handler(event) {
  var req = event.request;
  var host = req.headers.host.value;

  if (host !== 'www.example.com') {
    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: {
        'location': { value: 'https://www.example.com' + req.uri },
      },
    };
  }
  return req;
}
```

Replaces the need for an origin-side redirect layer. Zero origin cost.

### Origin selection by header (CFF, viewer-request)

```javascript
function handler(event) {
  var req = event.request;
  var variant = req.cookies['edge_variant'] && req.cookies['edge_variant'].value;

  // CFF origin selection is available in the origin-request-like event types
  // on supporting distribution configurations. Check current event model.
  if (variant === 'beta') {
    req.origin = {
      vpc: {
        vpcOriginId: 'beta-origin-id',
      },
    };
  }
  return req;
}
```

Check [CFF event structure docs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/functions-event-structure.html) for the current supported origin-selection surface; the capability is expanding.

## Testing and deployment

CFF has a `TestFunction` API that runs a function against a synthetic event and returns output. Use it in CI before promoting from `DEVELOPMENT` to `LIVE` stage.

```bash
aws cloudfront test-function \
  --name my-function \
  --if-match <etag> \
  --stage DEVELOPMENT \
  --event-object file://test-event.json
```

L@E has no equivalent edge-level test, but the function can be invoked as a regular Lambda (in `us-east-1`) with a CloudFront-shaped event payload for unit testing. Integrate into CI; never rely on "deploy and check CloudWatch" as the only test loop.

Deployment pattern:

1. CFF: publish new version to `DEVELOPMENT` stage, run `TestFunction` with representative events, publish to `LIVE`, associate with distribution.
2. L@E: publish new version in `us-east-1`, update distribution behavior to reference the new version ARN, CloudFront propagates.

Both are fast but not instant. Factor propagation time into rollback planning.

## Observability

- **CFF**: logs via `console.log` go to CloudWatch Logs in the region closest to the POP. Lag is short but non-zero. Sample logging for high-throughput functions.
- **L@E**: same model; logs are per-POP-region. Use the `x-amz-cf-pop` response header to locate the POP; map to the region; query logs there.
- **Metrics**: CloudFront publishes per-distribution and per-function metrics. Track invocation counts, error rates, execution time percentiles. Alert on error rate spikes, not absolute counts.
- **Tracing**: correlate edge logs with WAF logs and origin access logs via a request-id header injected on viewer-request (see the recipe above).

### Signed URL augmentation at origin (Lambda@Edge, origin-request)

```typescript
export const handler = async (event: any) => {
  const request = event.Records[0].cf.request;
  // Only augment requests to the private S3 origin.
  if (!request.origin.s3) return request;

  const policy = generateSignedPolicy(request.uri);
  request.querystring = `${request.querystring}&Policy=${encodeURIComponent(policy)}`;
  return request;
};
```

Runs on cache miss; origin gets a signed request; viewer sees clean URLs.

## Related

- [`distributions-and-origins.md`](distributions-and-origins.md) - VPC Origins and why Host rewriting matters.
- [`cache-behaviors-and-policies.md`](cache-behaviors-and-policies.md) - Response Headers Policies as the right home for security headers.
- [`security-and-access.md`](security-and-access.md) - Response Headers Policies, viewer mTLS, signing.
- [`performance-tuning.md`](performance-tuning.md) - when CFF vs L@E matters for latency.
- [`agentic-patterns.md`](agentic-patterns.md) - CFF patterns for agent workloads (auth, routing, rate-gating).
- [`troubleshooting.md`](troubleshooting.md) - debugging CFF errors, L@E log discovery, 5xx triage.
