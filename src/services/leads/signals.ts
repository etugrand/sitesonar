import { Lead } from './types.js';

/**
 * Intent signals + relevance score for scraped leads (Task 1 of the ICP plan).
 *
 * The honest set: only signals derivable from what /scrape already collects
 * (Google Maps listing + detail panel). Deliberately excludes:
 *  - high_review_velocity — needs per-review timestamps we don't scrape
 *  - hiring — needs a careers-page fetch (belongs in /enrich, added later)
 *
 * `signal` = the ONE (highest-priority) enabled signal a lead exhibits, or null.
 * `score`  = 0-100 blend of ICP fit (in-ICP by construction: it matched the
 * industry+location search) + the surfaced signal's strength. SiteSonar owns
 * this formula; downstream treats it as an opaque int.
 */
export const SIGNAL_KEYS = ['no_website', 'low_rating', 'new_business'] as const;
export type SignalKey = (typeof SIGNAL_KEYS)[number];

export interface SignalOpts {
  /** Signals to evaluate. `signal` is the first of these (in SIGNAL_KEYS order) that matches. */
  signals: SignalKey[];
  /** rating strictly below this → low_rating. ponytail: tune per pitch angle. */
  lowRatingThreshold?: number;
  /** reviewCount at or below this → new_business. */
  newBusinessMaxReviews?: number;
}

const BASE_ICP = 40; // matched the search → already in the ICP, before any signal
const DEFAULT_LOW_RATING = 4.0;
const DEFAULT_NEW_MAX_REVIEWS = 10;

const clamp = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));
const hasWebsite = (l: Lead): boolean => Boolean(l.website && l.website.trim());

interface Resolved {
  lowRatingThreshold: number;
  newBusinessMaxReviews: number;
}

function matches(key: SignalKey, l: Lead, o: Resolved): boolean {
  switch (key) {
    case 'no_website':
      return !hasWebsite(l);
    case 'low_rating':
      return typeof l.rating === 'number' && l.rating < o.lowRatingThreshold;
    case 'new_business':
      return typeof l.reviewCount === 'number' && l.reviewCount <= o.newBusinessMaxReviews;
  }
}

/** Signal-strength bonus on top of BASE_ICP; the surfaced signal alone drives it. */
function strength(key: SignalKey, l: Lead, o: Resolved): number {
  switch (key) {
    case 'no_website':
      return 50;
    case 'low_rating':
      return ((o.lowRatingThreshold - (l.rating as number)) / o.lowRatingThreshold) * 50;
    case 'new_business':
      return (1 - (l.reviewCount as number) / o.newBusinessMaxReviews) * 40;
  }
}

export function scoreLead(lead: Lead, opts: SignalOpts): { signal: SignalKey | null; score: number } {
  const o: Resolved = {
    lowRatingThreshold: opts.lowRatingThreshold ?? DEFAULT_LOW_RATING,
    newBusinessMaxReviews: opts.newBusinessMaxReviews ?? DEFAULT_NEW_MAX_REVIEWS,
  };
  // Catalogue priority order, but only signals the caller enabled.
  const surfaced = SIGNAL_KEYS.filter((k) => opts.signals.includes(k)).find((k) => matches(k, lead, o)) ?? null;
  return { signal: surfaced, score: clamp(BASE_ICP + (surfaced ? strength(surfaced, lead, o) : 0)) };
}

/** Tag each lead with signal+score. No-op (returns input) when no signals requested. */
export function tagLeads(leads: Lead[], opts: SignalOpts): Lead[] {
  if (!opts.signals.length) return leads;
  return leads.map((l) => ({ ...l, ...scoreLead(l, opts) }));
}

/** ICP band on reviewCount. Unknown reviewCount passes (fail-open). */
export function filterByReviews(leads: Lead[], minReviews?: number, maxReviews?: number): Lead[] {
  if (minReviews == null && maxReviews == null) return leads;
  return leads.filter((l) => {
    if (typeof l.reviewCount !== 'number') return true;
    if (minReviews != null && l.reviewCount < minReviews) return false;
    if (maxReviews != null && l.reviewCount > maxReviews) return false;
    return true;
  });
}
