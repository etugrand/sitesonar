# Sitesonar

Self-hosted scraping + SEO-audit HTTP API. Real Chromium via Playwright,
multi-page crawls via Crawlee, performance + accessibility scores via
Lighthouse. One ping, full picture of any URL — designed to be a permanent
piece of infrastructure that any project can call.

```
POST /v1/scrape       → render a URL, return metadata + markdown (+ optional HTML)
POST /v1/screenshot   → page screenshot (mobile / desktop / tablet, full or above-fold)
POST /v1/audit-page   → SEO audit: metadata + structured data + Lighthouse scores/metrics
POST /v1/crawl        → multi-page crawl with link graph (async; returns a job id)
GET  /v1/jobs/{id}    → poll a crawl job
GET  /health          → liveness probe (public, no auth)
GET  /docs            → Swagger UI (OpenAPI 3.0 spec at /docs/json)
```

All `/v1/*` endpoints require `Authorization: Bearer <api-key>`. Define keys
via the `API_KEYS` env var (comma-separated).

## Stack

- **Fastify 5** – HTTP server
- **Playwright** – real Chromium with browser-pool reuse
- **Crawlee 3** – queue, dedup, retries, link enqueuing for `/crawl`
- **Lighthouse 12** – performance / accessibility / SEO / best-practices audits
- **Cheerio** – HTML parsing for metadata + JSON-LD extraction
- **Zod** – request validation
- **TypeScript** – built with `tsc`, runs on Node 20+

## Local development

Requires Node 20+ and ~1 GB of disk for Chromium.

```bash
cp .env.example .env
# generate a real API key:
#   echo "ss_live_$(openssl rand -hex 32)"
# and put it in API_KEYS

npm install
npx playwright install chromium       # downloads the browser binary
npm run dev                            # tsx watch on src/server.ts
```

Then hit it:

```bash
curl -X POST http://localhost:8080/v1/scrape \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'
```

Browse `http://localhost:8080/docs` for live API docs.

## Deploy on Coolify

1. **Push to a git remote** Coolify can pull from.
2. **Create an Application** in Coolify:
   - Build Pack: **Dockerfile**
   - Source: this repo
   - Port: `8080`
   - Health check path: `/health`
3. **Set env vars on the app:**
   ```
   API_KEYS=ss_live_<openssl rand -hex 32 output>,<more keys if you need>
   CORS_ORIGINS=https://your-frontend.example.com
   LOG_LEVEL=info
   ```
4. **Resources:** allocate at least **2 GB RAM, 1 vCPU**. Lighthouse pushes
   memory above 1 GB while running. If you're sharing the box with other
   apps, give it its own VPS — the plan called for separation, and it's right.
5. Deploy. Coolify mints an HTTPS URL via Traefik.

## Usage from your other projects

```ts
const res = await fetch(`${SITESONAR_URL}/v1/audit-page`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${process.env.SITESONAR_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ url: 'https://example.com', preset: 'mobile' }),
});
const audit = await res.json();
```

Plain HTTP — drop-in for any language, any framework.

## Architecture notes / honest limits

- **One Chromium for browser pool, separate Chrome per Lighthouse run.**
  The pool serves `/scrape`, `/screenshot`, and the rendering step of
  `/audit-page`. Lighthouse spawns its own short-lived Chrome via
  `chrome-launcher` so it doesn't trample the pool. The trade-off is that
  audits don't share state with scrapes — same target gets fetched twice.
- **Jobs are in-memory.** `/crawl` results live in a `Map` and disappear on
  restart. Fine for single-instance, low-volume use. Swap for Redis +
  BullMQ when you need multi-replica or want jobs to survive deploys.
- **Crawlee storage is on `/tmp`.** Request-queue state for `/crawl` is
  ephemeral by design (each call uses a fresh queue, dropped on completion).
  No volume needed.
- **No proxy / session rotation built in.** If targets start rate-limiting
  you, add `crawlee` proxy configuration in `src/services/crawler.ts` and
  Playwright `proxy` options in `src/browser.ts`.
- **`htmlToMarkdownLite` is intentionally light.** It strips scripts/styles
  and preserves headings/links/paragraphs. Replace with `turndown` if you
  need fidelity.
- **Schema validation is shallow.** It parses JSON-LD blocks and counts
  microdata/RDFa nodes. For real schema.org compliance, post the HTML to
  `validator.schema.org` or run `structured-data-testing-tool` programmatically.

## What's missing (v2 candidates)

- API-key-scoped rate limits (`@fastify/rate-limit`)
- Redis-backed job store + multi-replica deploys
- Per-domain proxy / session pooling
- Webhook notifications on job completion
- Cache layer (Redis or pg) so repeat scrapes don't re-fetch
- Custom Lighthouse configs (audit only specific categories, custom budgets)
- Endpoint metrics (Prometheus exporter)
