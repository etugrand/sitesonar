import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';

export interface PageMetadata {
  title: string | null;
  description: string | null;
  canonical: string | null;
  language: string | null;
  robots: string | null;
  viewport: string | null;
  openGraph: Record<string, string>;
  twitterCard: Record<string, string>;
  headings: {
    h1: string[];
    h2: string[];
    h3: string[];
  };
  links: {
    internal: number;
    external: number;
    nofollow: number;
  };
  images: {
    total: number;
    missingAlt: number;
  };
}

export function extractMetadata(html: string, pageUrl: string): PageMetadata {
  const $ = cheerio.load(html);
  const origin = (() => {
    try {
      return new URL(pageUrl).origin;
    } catch {
      return '';
    }
  })();

  const og: Record<string, string> = {};
  $('meta[property^="og:"]').each((_, el) => {
    const prop = $(el).attr('property');
    const content = $(el).attr('content');
    if (prop && content) og[prop.slice(3)] = content;
  });

  const tw: Record<string, string> = {};
  $('meta[name^="twitter:"]').each((_, el) => {
    const name = $(el).attr('name');
    const content = $(el).attr('content');
    if (name && content) tw[name.slice(8)] = content;
  });

  const collectHeadings = (selector: string): string[] =>
    $(selector)
      .map((_, el) => $(el).text().trim())
      .get()
      .filter(Boolean);

  let internal = 0;
  let external = 0;
  let nofollow = 0;
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    if (($(el).attr('rel') ?? '').includes('nofollow')) nofollow += 1;
    try {
      const abs = new URL(href, pageUrl);
      if (origin && abs.origin === origin) internal += 1;
      else external += 1;
    } catch {
      // ignore invalid hrefs (mailto:, tel:, anchors)
    }
  });

  const imgs = $('img');
  const missingAlt = imgs.filter((_, el) => !($(el).attr('alt') ?? '').trim()).length;

  return {
    title: $('title').first().text().trim() || null,
    description: $('meta[name="description"]').attr('content')?.trim() ?? null,
    canonical: $('link[rel="canonical"]').attr('href') ?? null,
    language: $('html').attr('lang') ?? null,
    robots: $('meta[name="robots"]').attr('content') ?? null,
    viewport: $('meta[name="viewport"]').attr('content') ?? null,
    openGraph: og,
    twitterCard: tw,
    headings: {
      h1: collectHeadings('h1'),
      h2: collectHeadings('h2'),
      h3: collectHeadings('h3'),
    },
    links: { internal, external, nofollow },
    images: { total: imgs.length, missingAlt },
  };
}

/**
 * Convert HTML to LLM-friendly markdown-lite. Strips scripts, styles, and
 * navigation chrome; preserves headings and paragraph structure.
 *
 * Lightweight (no remark/turndown) — good enough for agent context. If you
 * need fidelity, swap in turndown later.
 */
export function htmlToMarkdownLite(html: string): string {
  const $ = cheerio.load(html);
  $('script, style, noscript, iframe, svg').remove();

  const lines: string[] = [];
  const walk = (node: AnyNode, depth = 0): void => {
    if (node.type === 'text') {
      const text = (node.data ?? '').replace(/\s+/g, ' ').trim();
      if (text) lines.push(text);
      return;
    }
    if (node.type !== 'tag') return;
    const tag = node.tagName.toLowerCase();

    const passThrough = (): void => {
      for (const child of node.children) walk(child, depth);
    };

    switch (tag) {
      case 'h1':
        lines.push(`\n# ${$(node).text().trim()}\n`);
        break;
      case 'h2':
        lines.push(`\n## ${$(node).text().trim()}\n`);
        break;
      case 'h3':
        lines.push(`\n### ${$(node).text().trim()}\n`);
        break;
      case 'h4':
        lines.push(`\n#### ${$(node).text().trim()}\n`);
        break;
      case 'p':
      case 'div':
      case 'section':
      case 'article':
      case 'main':
        lines.push('');
        passThrough();
        lines.push('');
        break;
      case 'li':
        lines.push(`- ${$(node).text().trim()}`);
        break;
      case 'a': {
        const href = $(node).attr('href');
        const text = $(node).text().trim();
        if (href && text) lines.push(`[${text}](${href})`);
        else passThrough();
        break;
      }
      case 'br':
        lines.push('');
        break;
      default:
        passThrough();
    }
  };

  const body = $('body')[0];
  if (body) {
    for (const child of body.children) walk(child);
  }

  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
