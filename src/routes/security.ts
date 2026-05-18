import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import { gradeHeaders } from '../services/security-headers.js';

const SecurityBody = z.object({
  url: z.string().url(),
  timeoutMs: z.number().int().positive().max(60_000).optional(),
});

interface SecurityDeps {
  config: Config;
}

export const securityRoutes =
  (deps: SecurityDeps): FastifyPluginAsync =>
  async (app) => {
    app.post(
      '/v1/security',
      {
        schema: {
          description:
            'Fetch a URL and grade its HTTP security headers (HSTS, CSP, etc.). No browser rendering — fast.',
          tags: ['security'],
          security: [{ bearerAuth: [] }],
          body: {
            type: 'object',
            required: ['url'],
            properties: {
              url: { type: 'string', format: 'uri' },
              timeoutMs: { type: 'integer', minimum: 1, maximum: 60_000 },
            },
          },
        },
      },
      async (req, reply) => {
        const parsed = SecurityBody.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
        }
        const body = parsed.data;
        const timeout = body.timeoutMs ?? deps.config.securityTimeoutMs;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
          const response = await fetch(body.url, {
            method: 'GET',
            redirect: 'follow',
            signal: controller.signal,
          });
          const rawHeaders: Record<string, string> = {};
          response.headers.forEach((v, k) => {
            rawHeaders[k.toLowerCase()] = v;
          });
          const grade = gradeHeaders(rawHeaders);
          return {
            url: body.url,
            finalUrl: response.url,
            status: response.status,
            security: grade,
            fetchedAt: new Date().toISOString(),
          };
        } catch (err) {
          req.log.warn({ err }, 'security headers fetch failed');
          if (err instanceof Error && err.name === 'AbortError') {
            return reply.code(504).send({ error: 'timeout', message: `Exceeded ${timeout}ms` });
          }
          return reply.code(502).send({
            error: 'fetch_failed',
            message: err instanceof Error ? err.message : String(err),
          });
        } finally {
          clearTimeout(timer);
        }
      },
    );
  };
