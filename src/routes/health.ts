import type { FastifyPluginAsync } from 'fastify';
import type { JobStore } from '../jobs.js';
import type { Config } from '../config.js';
import type { BrowserPool } from '../browser.js';

interface HealthDeps {
  jobs: JobStore;
  startedAt: Date;
  config: Config;
  browser: BrowserPool;
}

export const healthRoutes = (deps: HealthDeps): FastifyPluginAsync => async (app) => {
  app.get(
    '/health',
    {
      schema: {
        description: 'Liveness probe + capacity snapshot. Public (no auth).',
        tags: ['system'],
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              browserConnected: { type: 'boolean' },
              uptimeSeconds: { type: 'number' },
              version: { type: 'string' },
              browserPoolSize: { type: 'integer' },
              rateLimitPerMin: { type: 'integer' },
            },
          },
          503: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              browserConnected: { type: 'boolean' },
              uptimeSeconds: { type: 'number' },
              version: { type: 'string' },
              browserPoolSize: { type: 'integer' },
              rateLimitPerMin: { type: 'integer' },
            },
          },
        },
      },
    },
    async (_req, reply) => {
      const uptimeSeconds = Math.floor((Date.now() - deps.startedAt.getTime()) / 1000);
      // Reflect real capacity: if Chromium has died and not yet relaunched, the
      // browser endpoints are unusable — report degraded (503) so upstreams stop
      // routing here and, if it stays down, the container gets recycled.
      const browserConnected = deps.browser.isConnected();
      reply.code(browserConnected ? 200 : 503);
      return {
        status: browserConnected ? 'ok' : 'degraded',
        browserConnected,
        uptimeSeconds,
        version: process.env.npm_package_version ?? '0.1.0',
        browserPoolSize: deps.config.browserPoolSize,
        rateLimitPerMin: deps.config.rateLimitPerMin,
      };
    },
  );

  // alias
  app.get('/healthz', async () => ({ status: 'ok' }));
};
