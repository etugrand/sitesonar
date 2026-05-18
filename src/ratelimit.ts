import { createHash } from 'node:crypto';
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import type { KvStore } from './kvstore.js';

interface RateLimitOptions {
  kv: KvStore;
  limitPerMin: number;
}

const WINDOW_SECONDS = 60;
const PREFIX = 'sitesonar:rl:';

/**
 * Stable, non-reversible per-key identifier for counter sharding. Truncated
 * SHA-256 keeps Redis keys short without weakening the privacy property.
 */
export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
}

function currentWindow(): number {
  return Math.floor(Date.now() / 1000 / WINDOW_SECONDS);
}

function extractToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1]! : null;
}

const plugin: FastifyPluginAsync<RateLimitOptions> = async (app, opts) => {
  app.addHook('onRequest', async (req, reply) => {
    // Skip everything that isn't a versioned API route. Health, docs, and
    // /v1/usage (callers shouldn't be charged for checking their balance).
    if (!req.url.startsWith('/v1/')) return;
    if (req.url === '/v1/usage' || req.url.startsWith('/v1/usage?')) return;

    const token = extractToken(req.headers.authorization);
    // Unauthed requests will be rejected by authPlugin's onRequest; we don't
    // count them. authPlugin is registered before this plugin so its hook
    // fires first and short-circuits on 401.
    if (!token) return;

    const keyId = hashApiKey(token);
    const window = currentWindow();
    const key = `${PREFIX}${keyId}:${window}`;
    // Generous TTL slack (window + 10s) avoids a counter expiring mid-window
    // due to clock drift between app and Redis.
    const count = await opts.kv.incr(key, WINDOW_SECONDS + 10);

    const remaining = Math.max(0, opts.limitPerMin - count);
    const reset = (window + 1) * WINDOW_SECONDS;

    reply.header('X-RateLimit-Limit', String(opts.limitPerMin));
    reply.header('X-RateLimit-Remaining', String(remaining));
    reply.header('X-RateLimit-Reset', String(reset));

    if (count > opts.limitPerMin) {
      const nowSec = Math.floor(Date.now() / 1000);
      const retryAfter = Math.max(1, reset - nowSec);
      reply.header('Retry-After', String(retryAfter));
      return reply.code(429).send({
        error: 'rate_limit_exceeded',
        message: `Limit ${opts.limitPerMin}/min exceeded; retry in ${retryAfter}s.`,
      });
    }
  });
};

export const rateLimitPlugin = fp(plugin, { name: 'rate-limit-plugin' });
