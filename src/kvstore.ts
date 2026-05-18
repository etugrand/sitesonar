import { Redis } from 'ioredis';

/**
 * Lightweight key/value store for short-lived counters and hashes (rate
 * limiting, diff tracking, etc.). Mirrors the JobStore split: Redis when
 * REDIS_URL is configured and reachable, in-memory otherwise.
 *
 * In-memory is fine for single-instance, non-billing use. The whole point of
 * a separate abstraction from JobStore is so we don't bolt counter/hash
 * methods onto the JobStore interface and tangle responsibilities.
 */
export interface KvStore {
  /** INCR the key. If it's new, sets TTL. Returns the new count. */
  incr(key: string, ttlSeconds: number): Promise<number>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** Seconds remaining, or null if missing / has no TTL. */
  ttl(key: string): Promise<number | null>;
  close?(): Promise<void>;
}

interface LoggerLike {
  info(msg: string): void;
  warn(obj: unknown, msg?: string): void;
}

export interface KvStoreFactoryOptions {
  redisUrl?: string;
  logger: LoggerLike;
}

function maskRedisUrl(url: string): string {
  return url.replace(/:[^:@/]*@/, ':***@');
}

export async function createKvStore(opts: KvStoreFactoryOptions): Promise<KvStore> {
  if (!opts.redisUrl) {
    opts.logger.info('KV store: in-memory (ephemeral)');
    return new InMemoryKvStore();
  }
  const masked = maskRedisUrl(opts.redisUrl);
  try {
    const store = await RedisKvStore.connect(opts.redisUrl, opts.logger);
    opts.logger.info(`KV store: Redis (${masked})`);
    return store;
  } catch (err) {
    opts.logger.warn(
      { err, url: masked },
      'REDIS_URL set but Redis unreachable for KV — falling back to in-memory.',
    );
    return new InMemoryKvStore();
  }
}

export class InMemoryKvStore implements KvStore {
  private store = new Map<string, { value: string; expiresAt: number }>();

  async incr(key: string, ttlSeconds: number): Promise<number> {
    this.evictExpired();
    const now = Date.now();
    const entry = this.store.get(key);
    if (entry && entry.expiresAt > now) {
      const next = parseInt(entry.value, 10) + 1;
      entry.value = String(next);
      return next;
    }
    this.store.set(key, { value: '1', expiresAt: now + ttlSeconds * 1000 });
    return 1;
  }

  async get(key: string): Promise<string | null> {
    this.evictExpired();
    const entry = this.store.get(key);
    if (!entry || entry.expiresAt <= Date.now()) return null;
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async ttl(key: string): Promise<number | null> {
    this.evictExpired();
    const entry = this.store.get(key);
    if (!entry) return null;
    const remaining = Math.ceil((entry.expiresAt - Date.now()) / 1000);
    return remaining > 0 ? remaining : null;
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [k, v] of this.store.entries()) {
      if (v.expiresAt <= now) this.store.delete(k);
    }
  }
}

export class RedisKvStore implements KvStore {
  private redis: Redis;

  private constructor(redis: Redis) {
    this.redis = redis;
  }

  static async connect(url: string, logger: LoggerLike): Promise<RedisKvStore> {
    const redis = new Redis(url, {
      lazyConnect: true,
      connectTimeout: 5000,
      maxRetriesPerRequest: 2,
      retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 1000)),
    });
    redis.on('error', (err) => logger.warn({ err }, 'redis error (kvstore)'));
    try {
      await redis.connect();
    } catch (err) {
      redis.disconnect();
      throw err;
    }
    return new RedisKvStore(redis);
  }

  async incr(key: string, ttlSeconds: number): Promise<number> {
    const next = await this.redis.incr(key);
    if (next === 1) {
      await this.redis.expire(key, ttlSeconds);
    }
    return next;
  }

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, value, 'EX', ttlSeconds);
  }

  async ttl(key: string): Promise<number | null> {
    const ttl = await this.redis.ttl(key);
    return ttl > 0 ? ttl : null;
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
