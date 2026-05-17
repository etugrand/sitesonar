import * as cheerio from 'cheerio';

export interface SchemaItem {
  type: string;
  raw: unknown;
  errors: string[];
}

export interface SchemaReport {
  jsonLdCount: number;
  microdataCount: number;
  rdfaCount: number;
  items: SchemaItem[];
  warnings: string[];
}

/**
 * Extracts and lightly validates structured data from rendered HTML.
 *
 * Surface-level validation only: parses JSON-LD blocks, counts
 * microdata/RDFa nodes, and flags malformed JSON. Deep schema.org
 * compliance is intentionally out of scope here — for that, run the
 * structured-data-testing-tool separately or post the HTML to
 * https://validator.schema.org.
 */
export function analyzeStructuredData(html: string): SchemaReport {
  const $ = cheerio.load(html);
  const items: SchemaItem[] = [];
  const warnings: string[] = [];

  // JSON-LD
  const jsonLdBlocks = $('script[type="application/ld+json"]');
  jsonLdBlocks.each((_, el) => {
    const raw = $(el).contents().text().trim();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      const collect = (node: unknown): void => {
        if (Array.isArray(node)) {
          node.forEach(collect);
          return;
        }
        if (node && typeof node === 'object') {
          const obj = node as Record<string, unknown>;
          const type = obj['@type'];
          items.push({
            type: typeof type === 'string' ? type : Array.isArray(type) ? type.join(',') : 'Unknown',
            raw: obj,
            errors: [],
          });
        }
      };
      collect(parsed);
    } catch (err) {
      warnings.push(
        `Invalid JSON-LD block: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  // Microdata (count only)
  const microdataCount = $('[itemscope]').length;

  // RDFa (count only)
  const rdfaCount = $('[typeof], [property]').length;

  return {
    jsonLdCount: jsonLdBlocks.length,
    microdataCount,
    rdfaCount,
    items,
    warnings,
  };
}
