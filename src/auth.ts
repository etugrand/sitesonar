import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

interface AuthOptions {
  apiKeys: string[];
}

const BEARER_PATTERN = /^Bearer\s+(.+)$/i;

const plugin: FastifyPluginAsync<AuthOptions> = async (app, opts) => {
  const valid = new Set(opts.apiKeys);

  app.addHook('onRequest', async (req: FastifyRequest, reply) => {
    // Allow public endpoints
    if (
      req.url === '/health' ||
      req.url === '/healthz' ||
      req.url.startsWith('/docs') ||
      req.url === '/openapi.json'
    ) {
      return;
    }

    const header = req.headers.authorization;
    const match = header ? header.match(BEARER_PATTERN) : null;
    const token = match?.[1];

    if (!token || !valid.has(token)) {
      reply.code(401).send({ error: 'unauthorized', message: 'Missing or invalid API key' });
    }
  });
};

export const authPlugin = fp(plugin, { name: 'auth-plugin' });
