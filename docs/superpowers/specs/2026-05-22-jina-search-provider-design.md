# Jina Search Provider — Design

**Status:** Approved
**Date:** 2026-05-22
**Component:** `src/services/search.ts` — adds a new entry to the `SearchProvider` chain

## Summary

Add Jina AI's `s.jina.ai` as a new entry in the search provider fallback chain.
Jina is a keyless-friendly search API: it works without an API key at moderate
rate limits, and accepts `Authorization: Bearer <JINA_API_KEY>` for higher
limits. It slots between SearXNG (self-hosted free) and Brave (keyed free tier)
in the default chain to preserve the free-first ordering.

## Motivation

The current chain has one keyless option (`searxng`) which requires the user to
run their own instance. Every other provider needs a paid signup or has tight
free quotas:

| Provider | Free tier | Requires key |
|----------|-----------|--------------|
| searxng  | unlimited (self-hosted) | no |
| brave    | 2,000/mo  | yes |
| google   | 100/day   | yes |
| serpapi  | 100/mo    | yes |
| serper   | ~2,500 one-time credits | yes |
| tavily   | 1,000/mo  | yes |

Jina adds a second keyless option that does not require self-hosting. For users
who don't run SearXNG, it becomes the de-facto free primary.

## Non-Goals

- Do **not** use Jina's content-fetching mode (default `s.jina.ai` behavior).
  Pulling full page content of every result would be wasteful for SERP-style
  use, slow, and would burn rate limits faster.
- Do **not** add Jina Reader (`r.jina.ai`) for URL fetching. That's a separate
  potential integration; this spec covers search only.
- Do **not** add tests. Existing providers in `search.ts` have no unit tests
  (only `security-headers`, `robots`, `sitemap` services have tests). Match the
  existing convention.

## API Reference

**Endpoint:** `POST https://s.jina.ai/`

**Request headers:**
- `Content-Type: application/json`
- `Accept: application/json` — return structured JSON instead of markdown
- `X-Respond-With: no-content` — return result metadata only, skip fetching
  full page content of each result
- `Authorization: Bearer <JINA_API_KEY>` — optional; raises rate limits when set
- `X-Locale: <lang>` — optional locale hint (e.g. `en-US`)

**Request body:** `{ "q": "<query>", "num": <count> }`

**Response shape (JSON):**
```jsonc
{
  "code": 200,                    // 200 on success; non-200 is an error
  "status": 20000,
  "data": [
    {
      "title": "...",
      "url": "https://...",
      "description": "...",       // snippet equivalent
      "date": "..."               // optional, ignored
    }
  ]
}
```

Jina sometimes returns HTTP 200 with `code != 200` in the body for errors. The
provider must check `data.code` and throw if non-200.

## Design

### New `JinaProvider` class

Lives in `src/services/search.ts` between `SearxngProvider` and `BraveProvider`.
Follows the existing `SearchProvider` interface verbatim.

```typescript
class JinaProvider implements SearchProvider {
  readonly name = 'jina' as const;
  constructor(private apiKey?: string) {}

  // Keyless tier works — always configured.
  isConfigured(): boolean {
    return true;
  }

  async search(q: SearchQuery, signal: AbortSignal): Promise<SearchData> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Respond-With': 'no-content',
    };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    if (q.lang) headers['X-Locale'] = q.lang;

    const data = (await fetchJson(
      'https://s.jina.ai/',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ q: q.query, num: q.num }),
      },
      signal,
    )) as {
      code?: number;
      data?: Array<{ title?: string; url?: string; description?: string }>;
      message?: string;
    };

    if (data.code !== undefined && data.code !== 200) {
      throw new Error(`Jina: code ${data.code}${data.message ? ` — ${data.message}` : ''}`);
    }

    const organic: OrganicResult[] = (data.data ?? [])
      .slice(0, q.num)
      .map((r, i) => ({
        position: i + 1,
        title: r.title ?? '',
        link: r.url ?? '',
        snippet: r.description ?? '',
        displayLink: safeDisplayLink(r.url ?? ''),
      }));

    return {
      organic,
      paa: [],
      related: [],
      features: emptyFeatures(),
      totalResults: null,
    };
  }
}
```

### Response field mapping

| Jina field           | sitesonar field        |
|----------------------|------------------------|
| `data[].title`       | `organic[].title`      |
| `data[].url`         | `organic[].link`       |
| `data[].description` | `organic[].snippet`    |
| `hostname(url)`      | `organic[].displayLink`|
| —                    | `paa: []`              |
| —                    | `related: []`          |
| —                    | `features: empty`      |
| —                    | `totalResults: null`   |

No PAA, related searches, or knowledge panel — Jina's search endpoint doesn't
expose those. Same shape as the existing `SearxngProvider` and `TavilyProvider`.

### Country / language handling

- `q.lang` → `X-Locale` header
- `q.country` → ignored (Jina has no clean country parameter; consistent with
  how `SearxngProvider` handles country)

### Error handling

- Reuses the existing `fetchJson` helper — HTTP non-2xx throws with body
  preview, caught by `runSearch`'s chain loop
- Body-level errors (`code !== 200`) throw with `Jina: code <n>` message
- All errors propagate to the existing `AllProvidersFailedError` path

### Config changes

**`src/services/search.ts`**
- Add `'jina'` to the `ProviderName` union (between `'searxng'` and `'brave'`)
- Add the `JinaProvider` class between `SearxngProvider` and `BraveProvider`
- Add `jina: new JinaProvider(config.jinaApiKey)` to the `all` record in
  `buildProviders`

**`src/config.ts`**
- Add `'jina'` to the `searchProviders` zod enum (between `'searxng'` and
  `'brave'`)
- Add `jinaApiKey: z.string().optional()` to the config schema
- Add `jinaApiKey: process.env.JINA_API_KEY` to the loader
- Update the default `searchProviders` value to
  `searxng,jina,brave,google,serpapi,serper,tavily`

**`.env.example`**
- Update the `SEARCH_PROVIDERS=` line to the new default order
- Add a `JINA_API_KEY=` block with a comment noting the keyless behavior and
  that setting a key raises rate limits

**`src/routes/search.ts`**
- Update the description string mentioning the chain order to include Jina
- Update the `no_providers_configured` error hint string to mention
  `JINA_API_KEY` (or note that Jina works keyless)

## Risks / Edge Cases

- **Rate limits without a key:** keyless tier is rate-limited; under load the
  provider will start returning 429s. The chain handles this — it falls through
  to Brave. Document in `.env.example` that `JINA_API_KEY` is recommended for
  production traffic.
- **Body-level `code` errors:** Jina returns HTTP 200 with `code` in body on
  some errors. Provider explicitly checks `code !== 200` so these don't get
  silently treated as empty results.
- **`X-Respond-With: no-content` regression risk:** If Jina ever changes this
  header's semantics, we'd silently start fetching full page content (slow,
  rate-limit burn). Low-probability but worth a comment in code.
- **Always-configured pattern is new:** All existing providers gate on a key or
  URL. `JinaProvider.isConfigured()` returning `true` unconditionally is the
  first provider that's always "on". Means if a user explicitly removes `jina`
  from `SEARCH_PROVIDERS`, it stays off — but the default chain will always
  include it. This is the intended behavior.

## Out of scope / Future work

- Jina Reader (`r.jina.ai`) for URL fetching as a fallback to the browser pool
- Unit tests for all search providers (would be a broader cleanup, not
  Jina-specific)
- Site filter support via `X-Site` header (not used by other providers either)
