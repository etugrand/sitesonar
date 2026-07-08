/**
 * Minimal async semaphore for global concurrency caps that are independent of
 * the HTTP rate limit. Used to bound expensive subsystems (Lighthouse, crawls)
 * that each spawn their own Chrome, so a burst of allowed requests can't fork
 * enough browser processes to OOM the whole service.
 */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(max: number) {
    this.available = Math.max(1, max);
  }

  private async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    // Wait for a token to be handed over directly by release().
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next(); // hand the borrowed token straight to the next waiter
    } else {
      this.available += 1;
    }
  }

  /** Run fn while holding a slot; the slot is always released. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
