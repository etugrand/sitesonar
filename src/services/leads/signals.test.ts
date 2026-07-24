import { describe, it, expect } from 'vitest';
import { scoreLead, tagLeads, filterByReviews, SIGNAL_KEYS } from './signals.js';
import type { Lead } from './types.js';

const lead = (over: Partial<Lead>): Lead => ({ title: 'Acme', ...over });
const all = [...SIGNAL_KEYS];

describe('scoreLead', () => {
  it('surfaces no_website (strongest) with score 90', () => {
    expect(scoreLead(lead({ website: '' }), { signals: all })).toEqual({ signal: 'no_website', score: 90 });
  });

  it('scales low_rating by how far below threshold', () => {
    // rating 2.0, threshold 4.0 → 40 + (2/4)*50 = 65
    expect(scoreLead(lead({ website: 'x.com', rating: 2.0 }), { signals: ['low_rating'] })).toEqual({
      signal: 'low_rating',
      score: 65,
    });
  });

  it('scales new_business inverse to reviewCount', () => {
    // reviewCount 0 → 40 + (1-0)*40 = 80
    expect(scoreLead(lead({ website: 'x.com', reviewCount: 0 }), { signals: ['new_business'] })).toEqual({
      signal: 'new_business',
      score: 80,
    });
  });

  it('picks the highest-priority signal when several match', () => {
    const l = lead({ website: '', rating: 1.5 }); // both no_website and low_rating
    expect(scoreLead(l, { signals: all }).signal).toBe('no_website');
  });

  it('only considers enabled signals', () => {
    const l = lead({ website: '', rating: 4.5 }); // has no_website but caller asked only low_rating
    expect(scoreLead(l, { signals: ['low_rating'] })).toEqual({ signal: null, score: 40 });
  });

  it('rating exactly at threshold is not low', () => {
    expect(scoreLead(lead({ website: 'x.com', rating: 4.0 }), { signals: ['low_rating'] }).signal).toBeNull();
  });
});

describe('tagLeads', () => {
  it('returns input untouched when no signals requested', () => {
    const ls = [lead({ website: '' })];
    const out = tagLeads(ls, { signals: [] });
    expect(out).toBe(ls);
    expect(out[0]).not.toHaveProperty('signal');
  });

  it('stamps signal+score on each lead', () => {
    const out = tagLeads([lead({ website: '' })], { signals: all });
    expect(out[0]).toMatchObject({ signal: 'no_website', score: 90 });
  });
});

describe('filterByReviews', () => {
  const ls = [lead({ reviewCount: 3 }), lead({ reviewCount: 200 }), lead({})];
  it('keeps only in-band, unknown passes (fail-open)', () => {
    const out = filterByReviews(ls, 5, 100);
    expect(out).toHaveLength(1); // only the {} with unknown reviewCount
  });
  it('no-op when no bounds', () => {
    expect(filterByReviews(ls)).toBe(ls);
  });
});
