import type { FastifyPluginAsync } from 'fastify';
import type { JobStore } from '../jobs.js';

interface HealthDeps {
  jobs: JobStore;
  startedAt: Date;
}

export const healthRoutes = (deps: HealthDeps): FastifyPluginAsync => async (app) => {
  app.get(
    '/health',
    {
      schema: {
        description: 'Liveness probe + queue snapshot. Public (no auth).',
        tags: ['system'],
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              uptimeSeconds: { type: 'number' },
              version: { type: 'string' },
            },
          },
        },
      },
    },
    async () => {
      const uptimeSeconds = Math.floor((Date.now() - deps.startedAt.getTime()) / 1000);
      return {
        status: 'ok',
        uptimeSeconds,
        version: process.env.npm_package_version ?? '0.1.0',
      };
    },
  );

  // alias
  app.get('/healthz', async () => ({ status: 'ok' }));
};
