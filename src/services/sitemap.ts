import { XMLParser } from 'fast-xml-parser';

export interface SitemapUrl {
  loc: string;
  lastmod: string | null;
  changefreq: string | null;
  priority: number | null;
}

export interface SitemapIndexEntry {
  loc: string;
  lastmod: string | null;
}

export interface ParsedUrlset {
  kind: 'urlset';
  urls: SitemapUrl[];
  sitemaps: never[];
}

export interface ParsedSitemapIndex {
  kind: 'sitemapindex';
  urls: never[];
  sitemaps: SitemapIndexEntry[];
}

export type ParsedSitemap = ParsedUrlset | ParsedSitemapIndex;

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
});

export function parseSitemapXml(xml: string): ParsedSitemap {
  const doc = parser.parse(xml) as Record<string, unknown>;

  if (doc.sitemapindex && typeof doc.sitemapindex === 'object') {
    const block = doc.sitemapindex as { sitemap?: unknown };
    const entries = arrayify(block.sitemap);
    const sitemaps: SitemapIndexEntry[] = entries.map((e) => {
      const obj = e as { loc?: string; lastmod?: string };
      return { loc: obj.loc ?? '', lastmod: obj.lastmod ?? null };
    });
    return { kind: 'sitemapindex', urls: [] as never[], sitemaps };
  }

  if (doc.urlset && typeof doc.urlset === 'object') {
    const block = doc.urlset as { url?: unknown };
    const entries = arrayify(block.url);
    const urls: SitemapUrl[] = entries.map((e) => {
      const obj = e as {
        loc?: string;
        lastmod?: string;
        changefreq?: string;
        priority?: string;
      };
      const priorityNum = obj.priority != null ? Number(obj.priority) : null;
      return {
        loc: obj.loc ?? '',
        lastmod: obj.lastmod ?? null,
        changefreq: obj.changefreq ?? null,
        priority: priorityNum != null && !Number.isNaN(priorityNum) ? priorityNum : null,
      };
    });
    return { kind: 'urlset', urls, sitemaps: [] as never[] };
  }

  return { kind: 'urlset', urls: [], sitemaps: [] as never[] };
}

function arrayify<T>(v: T | T[] | undefined): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

export interface ResolvedSitemap {
  isSitemapIndex: boolean;
  sitemapsResolved: number;
  urls: SitemapUrl[];
  urlCount: number;
  truncated: boolean;
}

export interface SitemapFetcher {
  (url: string): Promise<string>;
}

export async function resolveSitemap(
  rootUrl: string,
  fetcher: SitemapFetcher,
  options: { limit: number; followIndex: boolean },
): Promise<ResolvedSitemap> {
  const rootXml = await fetcher(rootUrl);
  const rootParsed = parseSitemapXml(rootXml);

  if (rootParsed.kind === 'urlset') {
    const truncated = rootParsed.urls.length > options.limit;
    const urls = truncated ? rootParsed.urls.slice(0, options.limit) : rootParsed.urls;
    return {
      isSitemapIndex: false,
      sitemapsResolved: 1,
      urls,
      urlCount: urls.length,
      truncated,
    };
  }

  // sitemap-index case
  if (!options.followIndex) {
    const urls: SitemapUrl[] = rootParsed.sitemaps.map((s) => ({
      loc: s.loc,
      lastmod: s.lastmod,
      changefreq: null,
      priority: null,
    }));
    return {
      isSitemapIndex: true,
      sitemapsResolved: 0,
      urls,
      urlCount: urls.length,
      truncated: false,
    };
  }

  const children = rootParsed.sitemaps.map((s) => s.loc);
  const merged: SitemapUrl[] = [];
  let truncated = false;
  let resolved = 0;
  for (let i = 0; i < children.length; i += 5) {
    if (merged.length >= options.limit) {
      truncated = true;
      break;
    }
    const chunk = children.slice(i, i + 5);
    const xmls = await Promise.all(chunk.map((u) => fetcher(u).catch(() => null)));
    for (const xml of xmls) {
      if (xml === null) continue;
      resolved += 1;
      const parsed = parseSitemapXml(xml);
      // Depth cap: only one level deep. Nested indexes are not recursed.
      if (parsed.kind === 'urlset') {
        for (const u of parsed.urls) {
          if (merged.length >= options.limit) {
            truncated = true;
            break;
          }
          merged.push(u);
        }
      }
      if (truncated) break;
    }
  }
  return {
    isSitemapIndex: true,
    sitemapsResolved: resolved,
    urls: merged,
    urlCount: merged.length,
    truncated,
  };
}
