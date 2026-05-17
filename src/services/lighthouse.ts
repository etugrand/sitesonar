import { launch, type LaunchedChrome } from 'chrome-launcher';
import lighthouseImport from 'lighthouse';

// Lighthouse's main export is a function but is shaped oddly under ESM.
// Coerce to the documented signature.
const lighthouse = lighthouseImport as unknown as (
  url: string,
  flags: Record<string, unknown>,
  config?: unknown,
) => Promise<{ lhr: LighthouseResult; report?: string | string[] }>;

export type LighthousePreset = 'mobile' | 'desktop';

export interface LighthouseAudit {
  scores: {
    performance: number | null;
    accessibility: number | null;
    bestPractices: number | null;
    seo: number | null;
  };
  metrics: {
    firstContentfulPaint: number | null;
    largestContentfulPaint: number | null;
    totalBlockingTime: number | null;
    cumulativeLayoutShift: number | null;
    speedIndex: number | null;
    interactive: number | null;
  };
  fetchTime: string;
  finalUrl: string;
  userAgent: string;
  lighthouseVersion: string;
}

interface LighthouseResult {
  fetchTime: string;
  finalDisplayedUrl?: string;
  finalUrl?: string;
  userAgent: string;
  lighthouseVersion: string;
  categories: Record<string, { score: number | null } | undefined>;
  audits: Record<string, { numericValue?: number | null } | undefined>;
}

function roundScore(score: number | null | undefined): number | null {
  if (score === null || score === undefined) return null;
  return Math.round(score * 100);
}

function numericValue(
  audits: LighthouseResult['audits'],
  key: string,
): number | null {
  const audit = audits[key];
  if (!audit || audit.numericValue === undefined || audit.numericValue === null) {
    return null;
  }
  return Math.round(audit.numericValue);
}

/**
 * Run a Lighthouse audit against a URL. Spawns its own Chrome via
 * chrome-launcher so it stays isolated from the Playwright browser pool.
 *
 * Slow (10-30s) and CPU-heavy. Don't run concurrently with the same browser.
 */
export async function runLighthouse(
  url: string,
  preset: LighthousePreset = 'mobile',
  timeoutMs = 90_000,
): Promise<LighthouseAudit> {
  let chrome: LaunchedChrome | null = null;
  try {
    chrome = await launch({
      chromeFlags: [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
      ],
    });

    const flags = {
      logLevel: 'error',
      output: 'json',
      onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
      port: chrome.port,
      maxWaitForLoad: timeoutMs,
      formFactor: preset,
      screenEmulation:
        preset === 'mobile'
          ? {
              mobile: true,
              width: 412,
              height: 823,
              deviceScaleFactor: 1.75,
              disabled: false,
            }
          : {
              mobile: false,
              width: 1350,
              height: 940,
              deviceScaleFactor: 1,
              disabled: false,
            },
    };

    const runner = await lighthouse(url, flags);
    const lhr = runner.lhr;

    return {
      scores: {
        performance: roundScore(lhr.categories.performance?.score),
        accessibility: roundScore(lhr.categories.accessibility?.score),
        bestPractices: roundScore(lhr.categories['best-practices']?.score),
        seo: roundScore(lhr.categories.seo?.score),
      },
      metrics: {
        firstContentfulPaint: numericValue(lhr.audits, 'first-contentful-paint'),
        largestContentfulPaint: numericValue(lhr.audits, 'largest-contentful-paint'),
        totalBlockingTime: numericValue(lhr.audits, 'total-blocking-time'),
        cumulativeLayoutShift: numericValue(lhr.audits, 'cumulative-layout-shift'),
        speedIndex: numericValue(lhr.audits, 'speed-index'),
        interactive: numericValue(lhr.audits, 'interactive'),
      },
      fetchTime: lhr.fetchTime,
      finalUrl: lhr.finalDisplayedUrl ?? lhr.finalUrl ?? url,
      userAgent: lhr.userAgent,
      lighthouseVersion: lhr.lighthouseVersion,
    };
  } finally {
    if (chrome) await chrome.kill();
  }
}
