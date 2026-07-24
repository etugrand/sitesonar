# SiteSonar ICP + Intent Signals + Relevance Score — Implementation Plan

Bring Gojiberry-style lead intelligence to the **SiteSonar side** of the prospecting
pipeline. SiteSonar already sources leads (scrape + enrich); this adds **intent
signals** and a **relevance score** to what it returns, and carries both through
Perbene's existing mapping onto the campaign contact. Perbene's outreach side barely
changes — it already has sequences, DRAFT-as-review, contacts, and stats.

## What is NOT in scope (deliberate)

- **LinkedIn automation** (invites/DMs/profile visits). Not scraping (not SiteSonar's
  job), not telephony (not Perbene's spine), and carries LinkedIn-ToS/account-ban risk.
  If wanted, it's a standalone channel connector later — never grafted onto either service.
- **Gojiberry's B2B-SaaS signals** (job change, topic engagement, lookalikes). They rely
  on a LinkedIn/person graph SiteSonar does not have. We spec **local-business signals**
  SiteSonar can derive from what it already scrapes (Google Maps + the business website).
- **A "copilot" queue.** Prospecting campaigns already land as `DRAFT` and the owner
  reviews/activates them — that IS the human-in-the-loop gate. Build nothing here.
- **`company_size` ICP filter.** Google-Maps scraping does not give reliable headcount.
  YAGNI — add only if SiteSonar later exposes a trustworthy size field.

## Global Constraints

- **Tenant-neutral.** Signal *definitions* are a fixed enum in code (same for every org);
  each org enables which signals + sets `min_score` as per-org **data** in
  `ProspectingConfig`. No Perbene-specific content anywhere.
- **Backward compatible.** SiteSonar without the new fields → Perbene sees no `signal`/
  `score`, `min_score` filter no-ops, pipeline behaves exactly as today. Ship Perbene and
  SiteSonar independently, in either order.
- **No new columns on hot tables.** Carry `signal` + `score` in the existing
  `CampaignContact.contact_metadata` / `Lead.lead_metadata` JSONB. One migration, and only
  on `prospecting_configs`.
- Custom SQL migration, timestamped `migrations/20260724000000_*.sql`, `IF EXISTS`/`IF NOT
  EXISTS` guards. NOT Alembic.
- Never leak `str(e)` in HTTP responses. API config comparisons unaffected.
- Test-first per task (pytest, no new frameworks/fixtures).

## The seam (already exists — this plan only enriches the payload flowing through it)

```
SiteSonar /v1/leads/scrape ──▶ scrape_leads()           # + optional ICP/signal params
      + /v1/leads/enrich   ──▶ enrich_leads()
                              merge_scrape_into_enriched  # unchanged (positional overlay)
                              normalize_enriched          # PRESERVE signal + score
                              dedupe_batch                # unchanged
                              apply_suppression           # unchanged
   prospecting_poller.py    ──▶ min_score filter (new) ──▶ CampaignContact.contact_metadata
                                                            {signal, score}
```

---

## Task 1: SiteSonar API contract (spec only — separate repo)

SiteSonar is a separate service (`sitesonar:8080`, own `/v1` API); its code is not in
this repo. This task defines the **contract** Perbene will consume. Implementation lives
in the SiteSonar repo. All additions are optional/additive — old clients unaffected.

### `POST /v1/leads/scrape` — new optional request fields

```jsonc
{
  "industry": "plumber",
  "query": "...", "location": "...", "max": 20,
  // NEW — all optional:
  "signals": ["no_website", "low_rating", "new_business", "high_review_velocity", "hiring"],
  "minReviews": 0,          // ICP floor, optional
  "maxReviews": null
}
```

### Response — each result gains `signal` + `score`

```jsonc
{
  "results": [
    {
      "name": "Acme Plumbing", "website": "acme.com", "phone": "+1...",
      "rating": 3.4, "reviewCount": 82, "openedAt": "2026-01-10",
      // NEW:
      "signal": "low_rating",        // the ONE signal that surfaced this lead (or null)
      "score": 78                    // 0-100 relevance; ICP fit + signal strength (or null)
    }
  ]
}
```

**Signal catalogue** (SiteSonar-derived, from Maps + site scrape — the honest set):

| key | meaning | data source |
|---|---|---|
| `no_website` | business has no/broken website | Maps listing / site fetch fails |
| `low_rating` | rating below threshold (reputation-repair angle) | Maps rating |
| `new_business` | recently opened / few reviews | Maps `openedAt` / low reviewCount |
| `high_review_velocity` | growing fast (expansion angle) | review timestamps |
| `hiring` | careers/"we're hiring" on site | site scrape |

`score` = SiteSonar's blend of ICP fit (industry/location match) + signal strength. Perbene
treats it as an opaque 0-100 int; SiteSonar owns the formula. If SiteSonar cannot compute
one, it returns `null` (Perbene defaults such leads to pass any `min_score` — fail-open).

**Deliverable:** this section, plus a ticket in the SiteSonar repo. No Perbene code.

---

## Task 2: `ProspectingConfig` — ICP/signal knobs + migration

`ProspectingConfig` already has `industries`/`keywords`/`location`/`radius` (the ICP
filters). Add only what's new:

```python
# app/db/models.py — ProspectingConfig, near the "Targeting" block
signals: Mapped[Optional[Dict[str, Any]]] = mapped_column(JSONB, nullable=True)   # enabled keys
min_score: Mapped[int] = mapped_column(Integer, default=0, nullable=False)        # 0 = keep all
```

```sql
-- migrations/20260724000000_prospecting_signals.sql
ALTER TABLE prospecting_configs ADD COLUMN IF NOT EXISTS signals JSONB;
ALTER TABLE prospecting_configs ADD COLUMN IF NOT EXISTS min_score INTEGER NOT NULL DEFAULT 0;
```

**Test** (`tests/test_prospecting_models.py`): construct a config with `signals=["no_website"]`,
`min_score=60`; assert round-trip + defaults (`signals=None`, `min_score=0`).

---

## Task 3: `sitesonar_client.scrape_leads` — pass ICP/signal params through

```python
# app/services/sitesonar_client.py — scrape_leads signature + payload
async def scrape_leads(self, *, industry=None, query=None, location=None, max=20,
                       signals: Optional[list[str]] = None,
                       min_reviews: Optional[int] = None) -> list[dict]:
    payload: dict[str, Any] = {"max": max}
    if industry: payload["industry"] = industry
    if query: payload["query"] = query
    if location: payload["location"] = location
    if signals: payload["signals"] = signals
    if min_reviews is not None: payload["minReviews"] = min_reviews
    data = await self._post("/v1/leads/scrape", payload)
    return self._as_list(data, "results", "leads")
```

**Test** (`tests/test_sitesonar_client.py`): mock transport asserts `signals` is in the
posted body when passed, absent when `None`; result rows with `signal`/`score` pass through
untouched (client is a dumb pipe — it returns whatever SiteSonar sends).

---

## Task 4: Preserve `signal` + `score` through the mapping, filter by `min_score`

`normalize_enriched` currently keeps only `name`/`phone`/`email`/`notes` — it **drops**
`signal`/`score`. Preserve them:

```python
# app/services/prospecting_mapping.py — normalize_enriched, add to the returned dict:
    score = raw.get("score")
    return {
        "name": ..., "phone": ..., "email": ..., "notes": ...,
        "signal": (raw.get("signal") or None),
        "score": int(score) if isinstance(score, (int, float)) else None,
    }
```

`merge_scrape_into_enriched` / `dedupe_batch` / `apply_suppression` are unchanged (they
carry the full candidate dict, so the new keys ride along).

In `prospecting_poller.py`, after `apply_suppression` (and email verify), before assembling
the campaign — apply the score floor and stamp the metadata:

```python
# min_score floor — fail-open: a null score (SiteSonar didn't compute one) always passes.
if cfg.min_score:
    kept = [c for c in kept if c.get("score") is None or c["score"] >= cfg.min_score]

# When creating each CampaignContact, carry signal+score in the existing JSONB:
contact_metadata={"sourcing_signal": c.get("signal"), "relevance_score": c.get("score")}
```

(Also stamp `Lead.lead_metadata` at `create_linked_lead` if it takes metadata — optional,
same two keys. Skip if it doesn't; the campaign contact is the one the UI reads.)

**Test** (`tests/test_prospecting_mapping.py`): `normalize_enriched` keeps `signal`/`score`;
coerces float score to int; `None` when absent. Poller test: leads below `min_score` dropped,
`score=None` leads kept, `contact_metadata` populated.

---

## Task 5: Prospecting router — expose `signals` + `min_score`

Add the two fields to the config GET/PUT schema in `app/api/routers/prospecting.py`.
Validate: `signals` ⊆ the known catalogue (reject unknown keys with a generic 422),
`0 <= min_score <= 100`.

**Test** (`tests/test_prospecting_router.py`): PUT with valid `signals`/`min_score`
round-trips; unknown signal key → 422; out-of-range score → 422.

---

## Task 6: Dashboard — ICP/signal controls + signal/score badge

- **Prospecting settings page** (`dashboard/src/app/(dashboard)/…/prospecting`): add a
  signal multi-select (checkboxes from the catalogue) + a `min_score` slider (0-100). Wire
  through the existing `api.put("/prospecting/config", …)`.
- **Campaign contacts view**: show `contact_metadata.sourcing_signal` as a tag and
  `relevance_score` as a badge (mirrors Gojiberry's "signal + AI score" on the contact row).
  Read-only; no new endpoint (the fields ride the existing campaign-contacts payload —
  confirm the serializer includes `contact_metadata`; add it if omitted).

**Test:** none required beyond `npm run lint` / `build` (UI wiring, no business logic).

---

## Final verification (after all tasks)

```bash
make db-migrate
pytest tests/test_prospecting_models.py tests/test_sitesonar_client.py \
       tests/test_prospecting_mapping.py tests/test_prospecting_poller.py \
       tests/test_prospecting_router.py -v
make lint
cd dashboard && npm run build
```

Manual: set an org's `signals=["no_website","low_rating"]`, `min_score=60`; run the sweep
(`run-now`); confirm the DRAFT campaign's contacts carry `sourcing_signal`/`relevance_score`
and that sub-60 leads were dropped. With a SiteSonar that predates Task 1, confirm the sweep
still produces a campaign (fail-open path).

## Deployment note (not part of the build)

Perbene and SiteSonar deploy independently. Ship Perbene first (Tasks 2-6) — it's inert
until SiteSonar starts returning `signal`/`score`. Then ship SiteSonar (Task 1). No env
changes. Standard prod flow (commit → push → `git pull` + `up -d --build api` on Contabo) —
only after an explicit per-deploy go.
