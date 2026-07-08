import { describe, it, expect } from 'vitest';
import { readTextCapped } from './http-limits.js';

function resFrom(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { headers });
}

describe('readTextCapped', () => {
  it('returns the body when under the cap', async () => {
    const out = await readTextCapped(resFrom('hello world'), 1000);
    expect(out).toBe('hello world');
  });

  it('rejects up-front when Content-Length exceeds the cap', async () => {
    const res = resFrom('x', { 'content-length': String(999_999) });
    await expect(readTextCapped(res, 10)).rejects.toThrow(/too large/);
  });

  it('aborts mid-stream when the body exceeds the cap without Content-Length', async () => {
    const big = 'a'.repeat(5000);
    await expect(readTextCapped(resFrom(big), 100)).rejects.toThrow(/exceeded/);
  });
});
