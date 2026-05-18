import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { BrowserPool } from '../browser.js';
import type { Config } from '../config.js';
import { extractArticle } from '../services/readability.js';
import { canonicalContent, trackChanges } from '../diff.js';
import type { KvStore } from '../kvstore.js';
import { hashApiKey } from '../ratelimit.js';

const ExtractBody = z.object({
  url: z.string().url(),
  waitUntil: z
    .enum(['load', 'domcontentloaded', 'networkidle', 'commit'])
    .default('networkidle'),
  waitForSelector: z.string().optional(),
  userAgent: z.string().optional(),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
  includeHtml: z.boolean().default(false),
  includeMarkdown: z.boolean().default(true),
  trackChanges: z.boolean().default(false),
});

interface ExtractDeps {
  browser: BrowserPool;
  config: Config;
  kv: KvStore;
}

function bearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1]! : null;
}

export const extractRoutes =
  (deps: ExtractDeps): FastifyPluginAsync =>
  async (app) => {
    app.post(
      '/v1/extract',
      {
        schema: {
          description:
            'Render a URL and return the article body via Mozilla Readability, with reader signals (author, publish date, reading time).',
          tags: ['extract'],
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
              userAgent: { type: 'string' },
              timeoutMs: { type: 'integer', minimum: 1, maximum: 120_000 },
              includeHtml: { type: 'boolean', default: false },
              includeMarkdown: { type: 'boolean', default: true },
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
        const parsed = ExtractBody.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
        }
        const body = parsed.data;
        const timeout = body.timeoutMs ?? deps.config.extractTimeoutMs;

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
          const finalUrl = page.url();
          const status = response ? response.status() : null;
          const { article, extractionFailed } = await extractArticle(page);

          const slimArticle = article
            ? {
                ...article,
                contentHtml: body.includeHtml ? article.contentHtml : '',
                contentMarkdown: body.includeMarkdown ? article.contentMarkdown : '',
              }
            : null;

          let diff: Awaited<ReturnType<typeof trackChanges>> | null = null;
          if (body.trackChanges && article) {
            const token = bearerToken(req.headers.authorization);
            if (token) {
              diff = await trackChanges({
                kv: deps.kv,
                keyId: hashApiKey(token),
                url: finalUrl,
                content: canonicalContent(
                  article.title,
                  article.excerpt,
                  article.contentMarkdown,
                ),
                ttlSeconds: deps.config.diffTtlDays * 86_400,
              });
            }
          }

          return {
            url: body.url,
            finalUrl,
            status,
            article: slimArticle,
            extractionFailed,
            ...(diff ? { diff } : {}),
            fetchedAt: new Date().toISOString(),
          };
        } catch (err) {
          req.log.warn({ err }, 'extract failed');
          return reply.code(502).send({
            error: 'extract_failed',
            message: err instanceof Error ? err.message : String(err),
          });
        } finally {
          await deps.browser.release(context);
        }
      },
    );
  };
