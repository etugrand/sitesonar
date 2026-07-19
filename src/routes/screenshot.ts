import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { BrowserPool } from '../browser.js';
import type { Config } from '../config.js';

const ScreenshotBody = z.object({
  url: z.string().url(),
  preset: z.enum(['mobile', 'desktop', 'tablet']).default('desktop'),
  fullPage: z.boolean().default(false),
  format: z.enum(['png', 'jpeg']).default('png'),
  quality: z.number().int().min(1).max(100).optional(),
  waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).default('load'),
  waitForSelector: z.string().optional(),
  timeoutMs: z.number().int().positive().max(60_000).optional(),
  asBase64: z.boolean().default(false),
});

const VIEWPORTS = {
  mobile: { width: 412, height: 823, deviceScaleFactor: 1.75, isMobile: true },
  tablet: { width: 768, height: 1024, deviceScaleFactor: 2, isMobile: true },
  desktop: { width: 1366, height: 900, deviceScaleFactor: 1, isMobile: false },
} as const;

interface ScreenshotDeps {
  browser: BrowserPool;
  config: Config;
}

export const screenshotRoutes =
  (deps: ScreenshotDeps): FastifyPluginAsync =>
  async (app) => {
    app.post(
      '/v1/screenshot',
      {
        schema: {
          description:
            'Capture a screenshot. Returns raw image bytes (default) or JSON with base64 when asBase64=true.',
          tags: ['scrape'],
          security: [{ bearerAuth: [] }],
          body: {
            type: 'object',
            required: ['url'],
            properties: {
              url: { type: 'string', format: 'uri' },
              preset: { type: 'string', enum: ['mobile', 'desktop', 'tablet'], default: 'desktop' },
              fullPage: { type: 'boolean', default: false },
              format: { type: 'string', enum: ['png', 'jpeg'], default: 'png' },
              quality: { type: 'integer', minimum: 1, maximum: 100 },
              waitUntil: {
                type: 'string',
                enum: ['load', 'domcontentloaded', 'networkidle'],
                default: 'load',
              },
              waitForSelector: { type: 'string' },
              timeoutMs: { type: 'integer', minimum: 1, maximum: 60_000 },
              asBase64: { type: 'boolean', default: false },
            },
          },
        },
      },
      async (req, reply) => {
        const parsed = ScreenshotBody.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
        }
        const body = parsed.data;
        const timeout = body.timeoutMs ?? deps.config.screenshotTimeoutMs;
        const viewport = VIEWPORTS[body.preset];

        const context = await deps.browser.acquire({
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: viewport.deviceScaleFactor,
          isMobile: viewport.isMobile,
        });
        try {
          const page = await context.newPage();
          await page.goto(body.url, { waitUntil: body.waitUntil, timeout });
          if (body.waitForSelector) {
            await page.waitForSelector(body.waitForSelector, { timeout });
          }

          const buffer = await page.screenshot({
            type: body.format,
            fullPage: body.fullPage,
            ...(body.format === 'jpeg' && body.quality !== undefined
              ? { quality: body.quality }
              : {}),
          });

          if (body.asBase64) {
            return {
              url: body.url,
              preset: body.preset,
              format: body.format,
              bytes: buffer.length,
              data: buffer.toString('base64'),
              capturedAt: new Date().toISOString(),
            };
          }

          reply
            .code(200)
            .header('Content-Type', body.format === 'png' ? 'image/png' : 'image/jpeg')
            .send(buffer);
          return reply;
        } catch (err) {
          req.log.warn({ err }, 'screenshot failed');
          return reply.code(502).send({
            error: 'screenshot_failed',
            message: err instanceof Error ? err.message : String(err),
          });
        } finally {
          await deps.browser.release(context);
        }
      },
    );
  };
