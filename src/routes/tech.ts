import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { BrowserPool } from '../browser.js';
import type { Config } from '../config.js';
import { detectTech } from '../services/tech.js';

const TechBody = z.object({
  url: z.string().url(),
  waitUntil: z
    .enum(['load', 'domcontentloaded', 'networkidle', 'commit'])
    .default('networkidle'),
  userAgent: z.string().optional(),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
  categories: z.array(z.string()).optional(),
});

interface TechDeps {
  browser: BrowserPool;
  config: Config;
}

export const techRoutes =
  (deps: TechDeps): FastifyPluginAsync =>
  async (app) => {
    app.post(
      '/v1/tech',
      {
        schema: {
          description:
            'Render a URL and fingerprint the technology stack (CMS, frameworks, analytics, CDN, etc.).',
          tags: ['tech'],
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
              userAgent: { type: 'string' },
              timeoutMs: { type: 'integer', minimum: 1, maximum: 120_000 },
              categories: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
      async (req, reply) => {
        const parsed = TechBody.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
        }
        const body = parsed.data;
        const timeout = body.timeoutMs ?? deps.config.techTimeoutMs;

        const context = await deps.browser.acquire(
          body.userAgent ? { userAgent: body.userAgent } : {},
        );
        try {
          const page = await context.newPage();
          const response = await page.goto(body.url, { waitUntil: body.waitUntil, timeout });
          const finalUrl = page.url();
          const status = response ? response.status() : null;
          const rawHeaders: Record<string, string> = response ? response.headers() : {};

          const { technologies } = await detectTech(page, rawHeaders, body.categories);

          return {
            url: body.url,
            finalUrl,
            status,
            technologies,
            fetchedAt: new Date().toISOString(),
          };
        } catch (err) {
          req.log.warn({ err }, 'tech detection failed');
          return reply.code(502).send({
            error: 'tech_failed',
            message: err instanceof Error ? err.message : String(err),
          });
        } finally {
          await deps.browser.release(context);
        }
      },
    );
  };
