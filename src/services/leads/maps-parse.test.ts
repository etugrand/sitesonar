import { describe, it, expect } from 'vitest';
import { composeQuery } from './types.js';
import {
  extractPhone,
  extractAddress,
  pickWebsite,
  extractRating,
} from './maps-parse.js';

describe('composeQuery', () => {
  it('prefers a raw query', () => {
    expect(composeQuery({ query: 'plumbers nyc', industry: 'x', location: 'y' })).toBe('plumbers nyc');
  });
  it('composes industry + location', () => {
    expect(composeQuery({ industry: 'immigration lawyer', location: 'New York' })).toBe(
      'immigration lawyer New York',
    );
  });
  it('handles industry only', () => {
    expect(composeQuery({ industry: 'dentist' })).toBe('dentist');
  });
});

describe('extractPhone', () => {
  it('pulls a US phone from card text', () => {
    expect(extractPhone('Open now · (212) 555-0188 · 5 Main St')).toBe('(212) 555-0188');
  });
  it('returns empty when absent', () => {
    expect(extractPhone('Open now · 5 Main St')).toBe('');
  });
});

describe('extractAddress', () => {
  it('pulls a street address and strips status words', () => {
    expect(extractAddress('Law firm5 Main StreetOpen')).toContain('5 Main Street');
  });
});

describe('pickWebsite', () => {
  it('returns the first external non-Google link', () => {
    expect(
      pickWebsite([
        'https://www.google.com/maps/place/x',
        'https://lh3.googleusercontent.com/p',
        'https://acmelaw.com',
      ]),
    ).toBe('https://acmelaw.com');
  });
  it('returns empty when only google links', () => {
    expect(pickWebsite(['https://www.google.com/maps/place/x'])).toBe('');
  });
});

describe('extractRating', () => {
  it('parses stars + review count', () => {
    expect(extractRating('4.8 stars 312 Reviews')).toEqual({ rating: 4.8, reviewCount: 312 });
  });
  it('returns zeros when not a rating', () => {
    expect(extractRating('Photo of business')).toEqual({ rating: 0, reviewCount: 0 });
  });
});
