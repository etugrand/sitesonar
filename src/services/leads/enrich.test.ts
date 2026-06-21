import { describe, it, expect, vi } from 'vitest';
import { guessEmail } from './enrich.js';

describe('guessEmail', () => {
  it('returns a role email when MX verification passes', async () => {
    const resolveMx = vi.fn().mockResolvedValue([{ exchange: 'mx.acmelaw.com', priority: 10 }]);
    const email = await guessEmail('acmelaw.com', { verifyMx: true, resolveMx });
    expect(email).toBe('info@acmelaw.com');
    expect(resolveMx).toHaveBeenCalledWith('acmelaw.com');
  });

  it('returns empty when MX lookup fails', async () => {
    const resolveMx = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));
    const email = await guessEmail('acmelaw.com', { verifyMx: true, resolveMx });
    expect(email).toBe('');
  });

  it('skips MX verification when disabled', async () => {
    const resolveMx = vi.fn();
    const email = await guessEmail('acmelaw.com', { verifyMx: false, resolveMx });
    expect(email).toBe('info@acmelaw.com');
    expect(resolveMx).not.toHaveBeenCalled();
  });
});
