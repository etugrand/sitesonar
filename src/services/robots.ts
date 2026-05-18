// robots-parser ships an .d.ts with a quirky `declare module` form that breaks
// default-import typing under NodeNext. The runtime export is `module.exports = function`.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- d.ts mismatch with CJS default export
import robotsParser from 'robots-parser';

interface RobotsParserResult {
  getCrawlDelay(ua?: string): number | undefined;
}
type RobotsParserFn = (url: string, contents: string) => RobotsParserResult;

export interface RobotsRule {
  userAgent: string;
  allow: string[];
  disallow: string[];
  crawlDelay: number | null;
}

export interface EffectiveRules {
  userAgent: string;
  allow: string[];
  disallow: string[];
  crawlDelay: number | null;
}

export interface ParsedRobots {
  rules: RobotsRule[];
  sitemaps: string[];
  effectiveRules?: EffectiveRules;
  raw: string;
}

const MAX_RAW_BYTES = 100 * 1024;

export function parseRobots(
  text: string,
  url: string,
  effectiveUserAgent?: string,
): ParsedRobots {
  const raw = text.length > MAX_RAW_BYTES ? text.slice(0, MAX_RAW_BYTES) : text;

  const lines = raw.split(/\r?\n/);
  const rules: RobotsRule[] = [];
  const sitemaps: string[] = [];

  // Pending UAs that haven't yet been bound to a directive block.
  let pendingUserAgents: string[] = [];
  // The directive block currently being filled. Bound to pendingUserAgents only
  // on the first directive line that arrives after a UA stack.
  let activeRules: RobotsRule[] | null = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!value && key !== 'user-agent') continue;

    if (key === 'user-agent') {
      if (activeRules) {
        // Directives ended for the prior block; start a new UA stack.
        rules.push(...activeRules);
        activeRules = null;
        pendingUserAgents = [];
      }
      pendingUserAgents.push(value);
    } else if (key === 'sitemap') {
      sitemaps.push(value);
    } else {
      // Any directive (disallow/allow/crawl-delay/etc.) binds the pending UAs.
      if (activeRules === null) {
        if (pendingUserAgents.length === 0) continue; // directive with no preceding UA, ignore
        activeRules = pendingUserAgents.map((ua) => ({
          userAgent: ua,
          allow: [],
          disallow: [],
          crawlDelay: null,
        }));
      }
      if (key === 'disallow') {
        for (const r of activeRules) r.disallow.push(value);
      } else if (key === 'allow') {
        for (const r of activeRules) r.allow.push(value);
      } else if (key === 'crawl-delay') {
        const n = parseInt(value, 10);
        if (!Number.isNaN(n)) for (const r of activeRules) r.crawlDelay = n;
      }
    }
  }
  if (activeRules) rules.push(...activeRules);

  const result: ParsedRobots = { rules, sitemaps, raw };

  if (effectiveUserAgent) {
    const parser = (robotsParser as unknown as RobotsParserFn)(url, raw);
    const match = pickMatchingRule(rules, effectiveUserAgent);
    result.effectiveRules = {
      userAgent: effectiveUserAgent,
      allow: match?.allow ?? [],
      disallow: match?.disallow ?? [],
      crawlDelay: parser.getCrawlDelay(effectiveUserAgent) ?? null,
    };
  }

  return result;
}

function pickMatchingRule(rules: RobotsRule[], userAgent: string): RobotsRule | undefined {
  const ua = userAgent.toLowerCase();
  // RFC 9309: longest matching UA prefix wins. Wildcard '*' is the fallback.
  let best: RobotsRule | undefined;
  let bestLen = -1;
  let wildcard: RobotsRule | undefined;
  for (const r of rules) {
    const ruleUa = r.userAgent.toLowerCase();
    if (ruleUa === '*') {
      wildcard = r;
      continue;
    }
    if (ua.includes(ruleUa) && ruleUa.length > bestLen) {
      best = r;
      bestLen = ruleUa.length;
    }
  }
  return best ?? wildcard;
}
