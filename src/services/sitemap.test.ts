import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSitemapXml, resolveSitemap } from './sitemap.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string =>
  readFileSync(resolve(here, '../../test/fixtures/sitemap', name), 'utf8');

describe('parseSitemapXml', () => {
  it('parses a urlset', () => {
    const result = parseSitemapXml(fixture('urlset.xml'));
    expect(result.kind).toBe('urlset');
    expect(result.urls).toHaveLength(2);
    expect(result.urls[0]).toEqual({
      loc: 'https://example.com/page-1',
      lastmod: '2026-05-01T00:00:00Z',
      changefreq: 'monthly',
      priority: 0.8,
    });
    expect(result.urls[1]!.changefreq).toBeNull();
    expect(result.urls[1]!.priority).toBeNull();
  });

  it('parses a sitemap index', () => {
    const result = parseSitemapXml(fixture('sitemapindex.xml'));
    expect(result.kind).toBe('sitemapindex');
    expect(result.sitemaps).toEqual([
      { loc: 'https://example.com/sitemap-a.xml', lastmod: '2026-05-01' },
      { loc: 'https://example.com/sitemap-b.xml', lastmod: null },
    ]);
  });
});

describe('resolveSitemap', () => {
  const fixtureFetcher = async (url: string): Promise<string> => {
    if (url.endsWith('sitemapindex.xml')) return fixture('sitemapindex.xml');
    if (url.endsWith('sitemap-a.xml')) return fixture('child-a.xml');
    if (url.endsWith('sitemap-b.xml')) return fixture('child-b.xml');
    if (url.endsWith('urlset.xml')) return fixture('urlset.xml');
    throw new Error(`unexpected url ${url}`);
  };

  it('returns urls directly when root is a urlset', async () => {
    const result = await resolveSitemap('https://example.com/urlset.xml', fixtureFetcher, {
      limit: 50_000,
      followIndex: true,
    });
    expect(result.isSitemapIndex).toBe(false);
    expect(result.urlCount).toBe(2);
  });

  it('follows a sitemap-index when followIndex=true', async () => {
    const result = await resolveSitemap(
      'https://example.com/sitemapindex.xml',
      fixtureFetcher,
      { limit: 50_000, followIndex: true },
    );
    expect(result.isSitemapIndex).toBe(true);
    expect(result.sitemapsResolved).toBe(2);
    expect(result.urlCount).toBe(3);
  });

  it('respects the limit and sets truncated=true', async () => {
    const result = await resolveSitemap(
      'https://example.com/sitemapindex.xml',
      fixtureFetcher,
      { limit: 2, followIndex: true },
    );
    expect(result.truncated).toBe(true);
    expect(result.urlCount).toBe(2);
  });

  it('returns raw sitemap entries when followIndex=false', async () => {
    const result = await resolveSitemap(
      'https://example.com/sitemapindex.xml',
      fixtureFetcher,
      { limit: 50_000, followIndex: false },
    );
    expect(result.isSitemapIndex).toBe(true);
    expect(result.sitemapsResolved).toBe(0);
    expect(result.urls.map((u) => u.loc)).toEqual([
      'https://example.com/sitemap-a.xml',
      'https://example.com/sitemap-b.xml',
    ]);
  });
});
