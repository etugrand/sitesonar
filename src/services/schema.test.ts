import { describe, it, expect } from 'vitest';
import { analyzeStructuredData } from './schema.js';

const ldjson = (obj: unknown) =>
  `<html><head><script type="application/ld+json">${JSON.stringify(obj)}</script></head><body></body></html>`;

describe('analyzeStructuredData @graph unwrapping', () => {
  it('enumerates entities inside an @graph instead of one Unknown block', async () => {
    const html = ldjson({
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'Organization', name: 'Anaella' },
        { '@type': 'SoftwareApplication', name: 'Anaella' },
        { '@type': 'WebSite', url: 'https://anaella.com' },
        { '@type': 'FAQPage', mainEntity: [] },
      ],
    });
    const r = await analyzeStructuredData(html);
    const types = r.items.map((i) => i.type).sort();
    expect(types).toEqual(['FAQPage', 'Organization', 'SoftwareApplication', 'WebSite']);
    expect(types).not.toContain('Unknown');
    expect(r.jsonLdCount).toBe(1); // still one <script> block
  });

  it('still handles a plain top-level typed entity', async () => {
    const r = await analyzeStructuredData(ldjson({ '@context': 'https://schema.org', '@type': 'Article', headline: 'x' }));
    expect(r.items.map((i) => i.type)).toEqual(['Article']);
  });

  it('handles an array of entities', async () => {
    const r = await analyzeStructuredData(
      ldjson([{ '@type': 'Organization' }, { '@type': 'BreadcrumbList' }]),
    );
    expect(r.items.map((i) => i.type).sort()).toEqual(['BreadcrumbList', 'Organization']);
  });
});
