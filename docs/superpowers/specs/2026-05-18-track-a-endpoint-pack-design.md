# Track A — Endpoint Pack Design

**Date:** 2026-05-18
**Status:** Approved for planning
**Tracks remaining:** B (platform infrastructure: rate-limit/metering → webhooks → diffing)

## Scope

Add four read-only analysis endpoints under `/v1`, all synchronous (no jobs), all bearer-auth, all following the existing `routes/<name>.ts` + `services/<name>.ts` split established by `/v1/scrape` and `services/extract.ts`.

- `POST /v1/extract` — readability-extracted article body + reader signals
- `POST /v1/tech` — technology stack fingerprinting
- `POST /v1/sitemap` — XML sitemap fetch + parse (follows sitemap-index one level)
- `POST /v1/robots` — `robots.txt` fetch + parse
- `POST /v1/security` — security-headers grade (also exposed inside `/v1/audit-page`)

Five new endpoints across five new route files. `/v1/security`'s service is *additionally* reused inside `/v1/audit-page`'s response (no new route there, just an extra response block).

## Out of scope (YAGNI)

- Result caching (deferred to Track B diffing work).
- Batch endpoints — users compose via N calls; rate limiting work in Track B handles abuse.
- Auto-generating JSON-LD article schema in `/v1/extract`.
- A combined `/v1/discovery` endpoint that bundles sitemap+robots+tech — designed against for clarity of contracts.

## Architecture

```
src/
├── routes/
│   ├── extract.ts       # POST /v1/extract
│   ├── tech.ts          # POST /v1/tech
│   ├── sitemap.ts       # POST /v1/sitemap
│   ├── robots.ts        # POST /v1/robots
│   ├── security.ts      # POST /v1/security
│   └── audit-page.ts    # (modified) add security block to response
├── services/
│   ├── readability.ts   # browser-side @mozilla/readability runner
│   ├── tech.ts          # webappanalyzer fingerprint matcher
│   ├── sitemap.ts       # XML parser + sitemap-index traversal
│   ├── robots.ts        # robots.txt parser
│   └── security-headers.ts  # grading rubric, used by /v1/security AND /v1/audit-page
├── server.ts            # (modified) register new routes, add OpenAPI tags
└── config.ts            # (modified) add timeout knobs for new endpoints
```

**Dependency split:**
- `extract` and `tech` consume `BrowserPool` (need rendered DOM for JS-heavy sites and dynamic globals).
- `sitemap`, `robots`, `security` consume only `Config` + plain `fetch` (text files / HEAD requests; rendering is wasted cost).

## Endpoint specs

### 1. `POST /v1/extract`

Strip page chrome (nav/footer/sidebars/ads) via Mozilla Readability and return the main article only, plus reader signals.

**Request body:**

| field | type | default | notes |
|---|---|---|---|
| `url` | string (uri) | required | |
| `waitUntil` | `'load' \| 'domcontentloaded' \| 'networkidle' \| 'commit'` | `'networkidle'` | matches scrape |
| `waitForSelector` | string | — | optional |
| `userAgent` | string | — | optional |
| `timeoutMs` | int (1..120000) | `config.extractTimeoutMs` (30000) | |
| `includeHtml` | bool | `false` | include cleaned article HTML |
| `includeMarkdown` | bool | `true` | include turndown'd markdown |

**Response 200:**
```json
{
  "url": "...",
  "finalUrl": "...",
  "status": 200,
  "article": {
    "title": "...",
    "byline": "...",
    "excerpt": "...",
    "siteName": "...",
    "lang": "en",
    "publishedTime": "2026-05-17T12:00:00Z",
    "readingTimeMinutes": 4,
    "wordCount": 812,
    "leadImage": "https://...",
    "contentHtml": "<p>...</p>",
    "contentMarkdown": "..."
  },
  "fetchedAt": "2026-05-18T14:00:00Z"
}
```

When Readability returns `null` (no article detected — e.g. homepage, listing page), return `200` with `article: null` and an `extractionFailed: true` flag, NOT a 4xx. Callers commonly hit non-article pages by accident and should not be made to think their request was malformed.

**Implementation notes:**
- Add dep `@mozilla/readability` (Apache 2.0).
- Readability needs a real DOM. Run it inside the Playwright page context via `page.addScriptTag({ path: require.resolve('@mozilla/readability/Readability.js') })` then `page.evaluate(() => new Readability(document.cloneNode(true)).parse())`. Avoids a server-side JSDOM dep.
- `readingTimeMinutes = Math.max(1, Math.round(wordCount / 200))`.
- `publishedTime`: best-effort from `<meta property="article:published_time">`, `<time datetime>`, then JSON-LD `datePublished`. Null if none.
- `contentMarkdown`: reuse the existing `turndown` instance from `services/extract.ts`. Export it or move it to a shared module.

### 2. `POST /v1/tech`

Fingerprint the technology stack: CMS, frameworks, analytics, CDN, ecommerce platform, JS libraries, fonts, etc.

**Request body:**

| field | type | default | notes |
|---|---|---|---|
| `url` | string (uri) | required | |
| `waitUntil` | string | `'networkidle'` | |
| `timeoutMs` | int | `config.techTimeoutMs` (30000) | |
| `userAgent` | string | — | optional |
| `categories` | string[] | — | optional filter, e.g. `["CMS","Analytics"]` |

**Response 200:**
```json
{
  "url": "...",
  "finalUrl": "...",
  "status": 200,
  "technologies": [
    {
      "name": "WordPress",
      "version": "6.4.2",
      "categories": ["CMS"],
      "confidence": 100,
      "website": "https://wordpress.org",
      "icon": "WordPress.svg"
    }
  ],
  "fetchedAt": "..."
}
```

**Implementation notes:**
- Use the `webappanalyzer` MIT fork of the Wappalyzer fingerprint DB. Wappalyzer's own repo went closed-source in 2023.
- Detection inputs: response headers, rendered HTML, cookies, scripts list (`page.evaluate(() => Array.from(document.scripts).map(s => s.src))`), meta tags, and a `page.evaluate` checking for known window globals (e.g. `window.React`, `window.shopify`, `window.dataLayer`).
- Confidence comes from the fingerprint DB (0–100, sum-clamped). Filter `categories` is applied post-match.
- Fail open: if the fingerprint DB load fails at startup, log warn and return `503` from the endpoint with `error: 'tech_unavailable'` — don't crash the server.

### 3. `POST /v1/sitemap`

Fetch and parse an XML sitemap. Follow a sitemap-index one level deep (don't recurse infinitely).

**Request body:**

| field | type | default | notes |
|---|---|---|---|
| `url` | string (uri) | required | sitemap URL OR site root (in which case `/sitemap.xml` is tried) |
| `limit` | int (1..50000) | `50000` | XML sitemap spec hard cap |
| `followIndex` | bool | `true` | if false, return raw sitemap-index entries instead of resolving |
| `timeoutMs` | int | `config.sitemapTimeoutMs` (15000) | applied per-fetch, not total |

**Response 200:**
```json
{
  "url": "https://example.com/sitemap.xml",
  "finalUrl": "...",
  "isSitemapIndex": false,
  "sitemapsResolved": 1,
  "urls": [
    {
      "loc": "https://example.com/foo",
      "lastmod": "2026-05-01T00:00:00Z",
      "changefreq": "monthly",
      "priority": 0.8
    }
  ],
  "urlCount": 1234,
  "truncated": false,
  "fetchedAt": "..."
}
```

**Implementation notes:**
- Add dep `fast-xml-parser` (MIT, well-maintained, no transitive bloat). Native `xml2js` is older and slower.
- If `url` has no path or ends with `/`, try `<url>/sitemap.xml` then `<url>/sitemap_index.xml` then check `robots.txt` for `Sitemap:` lines. First hit wins. If all three fail, 404 with `error: 'no_sitemap_found'`.
- When `followIndex=true` and the fetched file is a sitemap-index: fetch each child sitemap in parallel (bounded concurrency = 5), merge URLs, stop at `limit`. Cap depth at 1 level — child sitemaps that themselves are indexes are NOT recursed (rare in practice; defends against malicious infinite-index loops).
- `truncated: true` if more URLs existed than `limit`.

### 4. `POST /v1/robots`

Fetch and parse `robots.txt`. Return structured rules + sitemap URLs.

**Request body:**

| field | type | default | notes |
|---|---|---|---|
| `url` | string (uri) | required | site root OR explicit robots.txt URL |
| `userAgent` | string | — | if given, also return `effectiveRules` filtered to this UA |
| `timeoutMs` | int | `config.robotsTimeoutMs` (10000) | |

**Response 200:**
```json
{
  "url": "https://example.com/robots.txt",
  "finalUrl": "...",
  "status": 200,
  "rules": [
    {
      "userAgent": "*",
      "allow": ["/blog/"],
      "disallow": ["/admin/", "/api/"],
      "crawlDelay": 1
    }
  ],
  "sitemaps": ["https://example.com/sitemap.xml"],
  "effectiveRules": {
    "userAgent": "Googlebot",
    "allow": [...],
    "disallow": [...],
    "crawlDelay": null
  },
  "raw": "...",
  "fetchedAt": "..."
}
```

**Implementation notes:**
- Add dep `robots-parser` (MIT) OR hand-roll (~80 lines). Lean toward `robots-parser` for the edge cases (Allow vs Disallow precedence, wildcard `*` and `$` anchors).
- If `url` has no `/robots.txt` suffix, append it.
- `effectiveRules` only present when request supplied `userAgent`. Implements UA matching per RFC 9309 (longest matching user-agent block wins; falls back to `*`).
- Always include `raw` (capped at 100KB — robots.txt has no formal size limit but truly huge files are pathological).
- Return `200` with `status: 404` and empty rules if the site has no robots.txt — many sites legitimately don't.

### 5. `POST /v1/security` + augmentation of `/v1/audit-page`

Grade a URL's HTTP security headers. Exposed two ways from one service:

- **`POST /v1/security`** — thin endpoint, HEAD request only, no browser. ~100ms.
- **`/v1/audit-page` response gains a `security` block** — uses the headers already captured during the Lighthouse pass, free.

**Request body for `/v1/security`:**

| field | type | default | notes |
|---|---|---|---|
| `url` | string (uri) | required | |
| `timeoutMs` | int | `config.securityTimeoutMs` (10000) | |

**Response 200:**
```json
{
  "url": "...",
  "finalUrl": "...",
  "status": 200,
  "grade": "B",
  "score": 75,
  "headers": {
    "strict-transport-security": {
      "present": true,
      "value": "max-age=31536000; includeSubDomains",
      "status": "pass",
      "note": null
    },
    "content-security-policy": {
      "present": false,
      "value": null,
      "status": "fail",
      "note": "No CSP header. Recommend at minimum: `default-src 'self'`."
    }
  },
  "recommendations": [
    "Add Content-Security-Policy header",
    "Add Permissions-Policy header"
  ],
  "fetchedAt": "..."
}
```

**Grading rubric (deterministic, no LLM):**

Each of 9 headers carries a weight. Sum the awarded weights to get `score` (0..100). Letter grade:
- `A`: 90–100
- `B`: 75–89
- `C`: 60–74
- `D`: 40–59
- `F`: <40

| Header | Weight | Pass rule |
|---|---|---|
| Strict-Transport-Security | 20 | `max-age` ≥ 6 months. `includeSubDomains` = +0 (warn if missing on `2nd-level.tld`). |
| Content-Security-Policy | 25 | Present, has `default-src` OR `script-src`, NO `unsafe-inline` in script-src (warn → half credit). |
| X-Frame-Options | 10 | `DENY` or `SAMEORIGIN`, OR CSP has `frame-ancestors`. |
| X-Content-Type-Options | 10 | `nosniff`. |
| Referrer-Policy | 10 | Present, not `unsafe-url`. |
| Permissions-Policy | 10 | Present (any value). |
| Cross-Origin-Opener-Policy | 5 | `same-origin`. |
| Cross-Origin-Resource-Policy | 5 | `same-origin` or `same-site`. |
| Server / X-Powered-By | 5 | Absent (info-leak). Both present = 0; either present = 2; neither = 5. |

Total weight = 100. `recommendations` is ordered by largest unawarded weight first.

**Implementation notes:**
- All header inspection is on lowercased keys.
- `services/security-headers.ts` exports `gradeHeaders(headers: Record<string,string>): SecurityGrade`. `/v1/security` does the HEAD itself; `/v1/audit-page` passes in the headers it already has.
- `/v1/audit-page` response gains `security: SecurityGrade` next to its existing `lighthouse` and `structuredData` blocks. No new fields in the request body.

## Cross-cutting

### Errors

Match existing shape `{ error: '<code>', message: '<text>' }`. HTTP codes:
- `400` — Zod validation failure (`error: 'bad_request', issues: [...]`).
- `401` — bearer auth (handled by `authPlugin`).
- `404` — `no_sitemap_found` only.
- `502` — upstream fetch / browser failed.
- `503` — `tech_unavailable` if fingerprint DB unloadable.
- `504` — explicit timeout.

### Schemas

Zod runtime parse + hand-written JSON Schema for swagger, matching `routes/scrape.ts` exactly. No `zod-to-json-schema` — known to drift across Zod versions.

### OpenAPI

`server.ts` tags list gains:
```ts
{ name: 'extract', description: 'Readability article extraction' },
{ name: 'tech', description: 'Technology stack fingerprinting' },
{ name: 'discovery', description: 'Sitemap and robots.txt parsing' },
{ name: 'security', description: 'HTTP security headers grading' },
```

### Config

Add to `config.ts`:
```ts
extractTimeoutMs: number;     // default 30000
techTimeoutMs: number;        // default 30000
sitemapTimeoutMs: number;     // default 15000 (per-fetch when resolving index)
robotsTimeoutMs: number;      // default 10000
securityTimeoutMs: number;    // default 10000
```

Read from `EXTRACT_TIMEOUT_MS`, etc., with the defaults above.

### Dependencies to add

| Package | License | Purpose |
|---|---|---|
| `@mozilla/readability` | Apache 2.0 | `/v1/extract` |
| `webappanalyzer` | MIT | `/v1/tech` — open fork of the Wappalyzer fingerprint DB. If pre-impl audit shows the package is unmaintained, fall back to `simple-wappalyzer` (also MIT). Decision recorded in the implementation plan, not the design. |
| `fast-xml-parser` | MIT | `/v1/sitemap` |
| `robots-parser` | MIT | `/v1/robots` |

No new dep for `/v1/security` — pure logic on existing header captures.

## Testing strategy

- **Unit (services):** golden HTML/XML/robots fixtures committed under `test/fixtures/`. Each service module tested in isolation against fixtures. No network.
- **Integration (routes):** spin up Fastify with a stubbed `BrowserPool` for browser routes, real `fetch` against a local fixture server for HTTP-only routes.
- **Smoke (manual, post-deploy):** hit each new endpoint against a known URL in production. Add a smoke script under `scripts/smoke-track-a.sh` mirroring the multi-provider search smoke test pattern.

## Sequencing within Track A

Recommend implementing in this order — each step independently shippable, smallest blast radius first:

1. `services/security-headers.ts` + `/v1/security` + augment `/v1/audit-page`. No new heavy deps.
2. `/v1/robots` + `/v1/sitemap`. Both HTTP-only, ship together (share XML/text-parsing patterns).
3. `/v1/extract`. New `@mozilla/readability` dep, browser-side script injection — newer pattern, isolate.
4. `/v1/tech`. Largest fingerprint DB, most chance of surprise. Ship last.

Each gets a separate commit and can be reverted independently.
