import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { BrowserPool } from '../browser.js';
import type { Config } from '../config.js';
import { extractArticle } from '../services/readability.js';

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
});

interface ExtractDeps {
  browser: BrowserPool;
  config: Config;
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

          return {
            url: body.url,
            finalUrl,
            status,
            article: slimArticle,
            extractionFailed,
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
