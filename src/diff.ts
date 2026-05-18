import { createHash } from 'node:crypto';
import type { KvStore } from './kvstore.js';

const PREFIX = 'sitesonar:diff:';

export interface DiffResult {
  /** SHA-256 hex digest of the canonical content used for change detection. */
  contentHash: string;
  /**
   * - `true`  — content differs from the last time we saw this URL for this key.
   * - `false` — content is unchanged.
   * - `null`  — first time we've seen this URL+key combo (no baseline to compare).
   */
  changed: boolean | null;
  previousHash: string | null;
}

interface TrackOptions {
  kv: KvStore;
  /** Hashed API key (per ratelimit.hashApiKey) — scopes the change history per key. */
  keyId: string;
  url: string;
  /** Canonical text to hash. Caller decides what counts as "content". */
  content: string;
  ttlSeconds: number;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Compute a content hash, compare to the prior hash stored for (keyId, url),
 * and update the stored hash. Read-modify-write is not atomic, but a rare
 * concurrent overwrite just means a slightly stale "changed" answer — not
 * a correctness issue worth a transaction.
 */
export async function trackChanges(opts: TrackOptions): Promise<DiffResult> {
  const contentHash = sha256(opts.content);
  const urlHash = sha256(opts.url).slice(0, 16);
  const storeKey = `${PREFIX}${opts.keyId}:${urlHash}`;
  const previousHash = await opts.kv.get(storeKey);
  await opts.kv.set(storeKey, contentHash, opts.ttlSeconds);

  let changed: boolean | null;
  if (previousHash === null) {
    changed = null;
  } else if (previousHash === contentHash) {
    changed = false;
  } else {
    changed = true;
  }

  return { contentHash, changed, previousHash };
}

/**
 * Build a stable content string from a page's salient fields. Title/description
 * changes are real changes; response headers are not. Markdown is the bulk of
 * the signal.
 */
export function canonicalContent(
  title: string | null,
  description: string | null,
  markdown: string,
): string {
  return [title ?? '', description ?? '', markdown].join('\n---\n');
}
