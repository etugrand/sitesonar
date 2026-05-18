import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { BrowserPool } from '../browser.js';
import type { Config } from '../config.js';
import {
  extractMetadata,
  filterResponseHeaders,
  htmlToMarkdown,
} from '../services/extract.js';
import { canonicalContent, trackChanges } from '../diff.js';
import type { KvStore } from '../kvstore.js';
import { hashApiKey } from '../ratelimit.js';

const ScrapeBody = z.object({
  url: z.string().url(),
  waitUntil: z
    .enum(['load', 'domcontentloaded', 'networkidle', 'commit'])
    .default('networkidle'),
  waitForSelector: z.string().optional(),
  includeHtml: z.boolean().default(false),
  includeMarkdown: z.boolean().default(true),
  userAgent: z.string().optional(),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
  trackChanges: z.boolean().default(false),
});

interface ScrapeDeps {
  browser: BrowserPool;
  config: Config;
  kv: KvStore;
}

function bearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1]! : null;
}

export const scrapeRoutes =
  (deps: ScrapeDeps): FastifyPluginAsync =>
  async (app) => {
    app.post(
      '/v1/scrape',
      {
        schema: {
          description:
            'Render a URL with a real browser and return metadata + (optionally) markdown and HTML.',
          tags: ['scrape'],
          security: [{ bearerAuth: [] }],
          body: {
            type: 'object',
            required: ['url'],
            properties: {
              url: { type: 'string', format: 'uri' },
              waitUntil: {
                type: 'string',
                enum: ['load', 'domcontentloaded', 'networkidle', 'commit'],
                default: 'networkidle',
              },
              waitForSelector: { type: 'string' },
              includeHtml: { type: 'boolean', default: false },
              includeMarkdown: { type: 'boolean', default: true },
              userAgent: { type: 'string' },
              timeoutMs: { type: 'integer', minimum: 1, maximum: 120_000 },
              trackChanges: {
                type: 'boolean',
                default: false,
                description:
                  'When true, the response includes a `diff` block with a content hash and a changed flag (true/false/null). Hashes are scoped per API key and retained for DIFF_TTL_DAYS days.',
              },
            },
          },
        },
      },
      async (req, reply) => {
        const parsed = ScrapeBody.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
        }
        const body = parsed.data;
        const timeout = body.timeoutMs ?? deps.config.scrapeTimeoutMs;

        const context = await deps.browser.acquire(
          body.userAgent ? { userAgent: body.userAgent } : {},
        );
        try {
          const page = await context.newPage();
          const response = await page.goto(body.url, {
            waitUntil: body.waitUntil,
            timeout,
          });

          if (body.waitForSelector) {
            await page.waitForSelector(body.waitForSelector, { timeout });
          }

          const html = await page.content();
          const finalUrl = page.url();
          const status = response ? response.status() : null;
          const metadata = extractMetadata(html, finalUrl);
          metadata.responseHeaders = filterResponseHeaders(response?.headers());

          // Markdown is computed once and reused for both the response
          // payload (when caller asked) and the diff hash (when tracking).
          const needMarkdown = body.includeMarkdown || body.trackChanges;
          const markdown = needMarkdown ? htmlToMarkdown(html) : '';

          let diff: Awaited<ReturnType<typeof trackChanges>> | null = null;
          if (body.trackChanges) {
            const token = bearerToken(req.headers.authorization);
            if (token) {
              diff = await trackChanges({
                kv: deps.kv,
                keyId: hashApiKey(token),
                url: finalUrl,
                content: canonicalContent(metadata.title, metadata.description, markdown),
                ttlSeconds: deps.config.diffTtlDays * 86_400,
              });
            }
          }

          return {
            url: body.url,
            finalUrl,
            status,
            metadata,
            ...(body.includeMarkdown ? { markdown } : {}),
            ...(body.includeHtml ? { html } : {}),
            ...(diff ? { diff } : {}),
            fetchedAt: new Date().toISOString(),
          };
        } catch (err) {
          req.log.warn({ err }, 'scrape failed');
          return reply.code(502).send({
            error: 'scrape_failed',
            message: err instanceof Error ? err.message : String(err),
          });
        } finally {
          await deps.browser.release(context);
        }
      },
    );
  };
