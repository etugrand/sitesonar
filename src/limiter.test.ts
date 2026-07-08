import { describe, it, expect } from 'vitest';
import { Semaphore } from './limiter.js';

describe('Semaphore', () => {
  it('never exceeds max concurrency', async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const task = async () => {
      await sem.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
      });
    };
    await Promise.all(Array.from({ length: 10 }, task));
    expect(peak).toBeLessThanOrEqual(2);
    expect(active).toBe(0);
  });

  it('releases the slot even when the task throws', async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    // If the slot leaked, this second run would hang forever.
    const ok = await sem.run(async () => 'ok');
    expect(ok).toBe('ok');
  });

  it('runs all queued tasks (none dropped)', async () => {
    const sem = new Semaphore(1);
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => sem.run(async () => i)),
    );
    expect(results.sort()).toEqual([0, 1, 2, 3, 4]);
  });
});
