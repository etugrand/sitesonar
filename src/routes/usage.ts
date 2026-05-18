import type { FastifyPluginAsync } from 'fastify';
import type { KvStore } from '../kvstore.js';
import { hashApiKey } from '../ratelimit.js';

interface UsageDeps {
  kv: KvStore;
  limitPerMin: number;
}

const WINDOW_SECONDS = 60;
const PREFIX = 'sitesonar:rl:';

function extractToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1]! : null;
}

export const usageRoutes =
  (deps: UsageDeps): FastifyPluginAsync =>
  async (app) => {
    app.get(
      '/v1/usage',
      {
        schema: {
          description:
            "Return the calling API key's rate-limit usage in the current 60-second window. Calling this endpoint does NOT count against your quota.",
          tags: ['system'],
          security: [{ bearerAuth: [] }],
        },
      },
      async (req, reply) => {
        const token = extractToken(req.headers.authorization);
        if (!token) {
          return reply.code(401).send({ error: 'unauthorized' });
        }

        const keyId = hashApiKey(token);
        const window = Math.floor(Date.now() / 1000 / WINDOW_SECONDS);
        const key = `${PREFIX}${keyId}:${window}`;
        const raw = await deps.kv.get(key);
        const used = raw ? parseInt(raw, 10) : 0;
        const remaining = Math.max(0, deps.limitPerMin - used);
        const reset = (window + 1) * WINDOW_SECONDS;

        return {
          limit: deps.limitPerMin,
          used,
          remaining,
          windowSeconds: WINDOW_SECONDS,
          reset,
          resetIso: new Date(reset * 1000).toISOString(),
        };
      },
    );
  };
