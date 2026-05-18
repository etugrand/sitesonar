import type { Page } from 'playwright';

export interface DetectedTechnology {
  name: string;
  version: string | null;
  categories: string[];
  confidence: number;
  website: string | null;
  icon: string | null;
}

export interface TechDetectionResult {
  technologies: DetectedTechnology[];
}

interface Artifacts {
  html: string;
  headers: Record<string, string>;
  cookies: { name: string; value: string }[];
  scripts: string[];
  metas: Record<string, string>;
  globals: string[];
}

async function collectArtifacts(page: Page): Promise<Omit<Artifacts, 'headers'>> {
  const html = await page.content();
  const context = page.context();
  const cookies = await context.cookies();
  const scripts = await page.evaluate(() =>
    Array.from(document.scripts).map((s) => s.src).filter(Boolean),
  );
  const metas = await page.evaluate(() => {
    const out: Record<string, string> = {};
    for (const m of Array.from(document.querySelectorAll('meta'))) {
      const name = m.getAttribute('name') ?? m.getAttribute('property');
      const content = m.getAttribute('content');
      if (name && content) out[name] = content;
    }
    return out;
  });
  const globals = await page.evaluate(() => {
    const known = [
      'React',
      'ReactDOM',
      'Vue',
      'angular',
      'jQuery',
      '__NEXT_DATA__',
      '__NUXT__',
      'shopify',
      'Shopify',
      'dataLayer',
      'ga',
      'gtag',
      'fbq',
      '_paq',
      'Stripe',
      'Intercom',
      'Drift',
      'mixpanel',
      'amplitude',
    ];
    return known.filter(
      (g) => typeof (window as unknown as Record<string, unknown>)[g] !== 'undefined',
    );
  });
  return { html, cookies, scripts, metas, globals };
}

interface Signature {
  name: string;
  categories: string[];
  website: string;
  icon: string;
  match: (a: Artifacts) => { matched: boolean; confidence: number; version: string | null };
}

const SIGNATURES: Signature[] = [
  {
    name: 'WordPress',
    categories: ['CMS'],
    website: 'https://wordpress.org',
    icon: 'WordPress.svg',
    match: (a) => {
      const html = a.html.toLowerCase();
      if (html.includes('/wp-content/') || html.includes('wp-includes')) {
        const generator = a.metas['generator'];
        const v = generator
          ? (generator.match(/WordPress\s+([\d.]+)/i)?.[1] ?? null)
          : null;
        return { matched: true, confidence: 100, version: v };
      }
      return { matched: false, confidence: 0, version: null };
    },
  },
  {
    name: 'Next.js',
    categories: ['JavaScript Framework'],
    website: 'https://nextjs.org',
    icon: 'Nextjs.svg',
    match: (a) => {
      if (a.globals.includes('__NEXT_DATA__') || a.html.includes('__NEXT_DATA__')) {
        return { matched: true, confidence: 100, version: null };
      }
      return { matched: false, confidence: 0, version: null };
    },
  },
  {
    name: 'React',
    categories: ['JavaScript Framework'],
    website: 'https://react.dev',
    icon: 'React.svg',
    match: (a) => {
      if (a.globals.includes('React') || a.globals.includes('ReactDOM')) {
        return { matched: true, confidence: 100, version: null };
      }
      return { matched: false, confidence: 0, version: null };
    },
  },
  {
    name: 'Vue.js',
    categories: ['JavaScript Framework'],
    website: 'https://vuejs.org',
    icon: 'Vue.js.svg',
    match: (a) => {
      if (a.globals.includes('Vue') || a.globals.includes('__NUXT__')) {
        return { matched: true, confidence: 100, version: null };
      }
      return { matched: false, confidence: 0, version: null };
    },
  },
  {
    name: 'Shopify',
    categories: ['Ecommerce'],
    website: 'https://shopify.com',
    icon: 'Shopify.svg',
    match: (a) => {
      if (
        a.globals.includes('Shopify') ||
        a.globals.includes('shopify') ||
        a.html.includes('cdn.shopify.com')
      ) {
        return { matched: true, confidence: 100, version: null };
      }
      return { matched: false, confidence: 0, version: null };
    },
  },
  {
    name: 'Google Analytics',
    categories: ['Analytics'],
    website: 'https://analytics.google.com',
    icon: 'Google Analytics.svg',
    match: (a) => {
      if (
        a.globals.includes('gtag') ||
        a.globals.includes('ga') ||
        a.html.includes('google-analytics.com') ||
        a.html.includes('googletagmanager.com')
      ) {
        return { matched: true, confidence: 100, version: null };
      }
      return { matched: false, confidence: 0, version: null };
    },
  },
  {
    name: 'Cloudflare',
    categories: ['CDN'],
    website: 'https://cloudflare.com',
    icon: 'CloudFlare.svg',
    match: (a) => {
      const server = a.headers['server'] ?? '';
      const cfRay = a.headers['cf-ray'];
      if (cfRay || /cloudflare/i.test(server)) {
        return { matched: true, confidence: 100, version: null };
      }
      return { matched: false, confidence: 0, version: null };
    },
  },
  {
    name: 'Nginx',
    categories: ['Web Server'],
    website: 'https://nginx.org',
    icon: 'Nginx.svg',
    match: (a) => {
      const server = a.headers['server'] ?? '';
      const m = server.match(/^nginx(?:\/([\d.]+))?/i);
      if (m) return { matched: true, confidence: 100, version: m[1] ?? null };
      return { matched: false, confidence: 0, version: null };
    },
  },
];

export async function detectTech(
  page: Page,
  headers: Record<string, string>,
  categoryFilter?: string[],
): Promise<TechDetectionResult> {
  const partial = await collectArtifacts(page);
  const lowerHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lowerHeaders[k.toLowerCase()] = v;
  const artifacts: Artifacts = { ...partial, headers: lowerHeaders };

  const techs: DetectedTechnology[] = [];
  for (const sig of SIGNATURES) {
    const r = sig.match(artifacts);
    if (!r.matched) continue;
    if (categoryFilter && !sig.categories.some((c) => categoryFilter.includes(c))) continue;
    techs.push({
      name: sig.name,
      version: r.version,
      categories: sig.categories,
      confidence: r.confidence,
      website: sig.website,
      icon: sig.icon,
    });
  }
  return { technologies: techs };
}
