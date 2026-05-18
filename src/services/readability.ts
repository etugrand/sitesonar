import { createRequire } from 'node:module';
import type { Page } from 'playwright';
import { turndown } from './extract.js';

const require_ = createRequire(import.meta.url);

// Resolve once at module load. The script is injected into the Playwright page.
const READABILITY_SCRIPT_PATH: string = require_.resolve(
  '@mozilla/readability/Readability.js',
);

export interface ExtractedArticle {
  title: string | null;
  byline: string | null;
  excerpt: string | null;
  siteName: string | null;
  lang: string | null;
  publishedTime: string | null;
  readingTimeMinutes: number;
  wordCount: number;
  leadImage: string | null;
  contentHtml: string;
  contentMarkdown: string;
}

export interface ExtractResult {
  article: ExtractedArticle | null;
  extractionFailed: boolean;
}

interface RawReadability {
  title: string | null;
  byline: string | null;
  excerpt: string | null;
  siteName: string | null;
  lang: string | null;
  content: string;
  textContent: string;
  length: number;
  publishedTime: string | null;
  leadImage: string | null;
}

export async function extractArticle(page: Page): Promise<ExtractResult> {
  await page.addScriptTag({ path: READABILITY_SCRIPT_PATH });

  const raw = await page.evaluate((): RawReadability | null => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    const cloned = document.cloneNode(true) as Document;
    const article = new w.Readability(cloned).parse();
    if (!article) return null;

    const publishedTime =
      document
        .querySelector('meta[property="article:published_time"]')
        ?.getAttribute('content') ??
      document.querySelector('time[datetime]')?.getAttribute('datetime') ??
      (() => {
        const ld = document.querySelector('script[type="application/ld+json"]');
        if (!ld?.textContent) return null;
        try {
          const data = JSON.parse(ld.textContent);
          const arr = Array.isArray(data) ? data : [data];
          for (const item of arr) {
            if (item?.datePublished) return item.datePublished as string;
          }
        } catch {
          // ignore malformed JSON-LD
        }
        return null;
      })() ??
      null;

    const og = document
      .querySelector('meta[property="og:image"]')
      ?.getAttribute('content');
    const leadImage =
      og ??
      (() => {
        const firstImg = document.querySelector('article img, main img, img');
        return firstImg?.getAttribute('src') ?? null;
      })();

    return {
      title: article.title ?? null,
      byline: article.byline ?? null,
      excerpt: article.excerpt ?? null,
      siteName: article.siteName ?? null,
      lang: article.lang ?? null,
      content: article.content ?? '',
      textContent: article.textContent ?? '',
      length: article.length ?? 0,
      publishedTime,
      leadImage,
    };
  });

  if (!raw) {
    return { article: null, extractionFailed: true };
  }

  const wordCount = countWords(raw.textContent);
  const readingTimeMinutes = Math.max(1, Math.round(wordCount / 200));
  const contentMarkdown = turndown.turndown(raw.content);

  return {
    article: {
      title: raw.title,
      byline: raw.byline,
      excerpt: raw.excerpt,
      siteName: raw.siteName,
      lang: raw.lang,
      publishedTime: raw.publishedTime,
      readingTimeMinutes,
      wordCount,
      leadImage: raw.leadImage,
      contentHtml: raw.content,
      contentMarkdown,
    },
    extractionFailed: false,
  };
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
