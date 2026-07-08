import { chromium, type Browser, type BrowserContext } from 'playwright';
import type { PlaywrightProxy } from './proxy.js';

/**
 * Persistent Playwright browser. One Chromium process per server, contexts
 * acquired per request from a simple semaphore-bounded pool.
 *
 * We use contexts (not pages) as the unit of isolation: each request gets a
 * fresh context with its own cookies/storage, then it's closed.
 */
/** Max time a request will wait for a free pool slot before giving up (ms). */
const ACQUIRE_WAIT_TIMEOUT_MS = 30_000;

export class BrowserPool {
  private browser: Browser | null = null;
  private startPromise: Promise<void> | null = null;
  private size: number;
  private proxy?: PlaywrightProxy;
  private inUse = 0;
  private waiters: Array<() => void> = [];

  constructor(size: number, proxy?: PlaywrightProxy) {
    this.size = size;
    this.proxy = proxy;
  }

  /**
   * Launch the browser (idempotent, dedupes concurrent callers). Registers a
   * 'disconnected' listener so a crashed Chromium is detected and re-launched
   * on the next acquire, instead of every request failing forever.
   */
  async start(): Promise<void> {
    if (this.browser?.isConnected()) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      const browser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-blink-features=AutomationControlled',
        ],
        ...(this.proxy ? { proxy: this.proxy } : {}),
      });
      browser.on('disconnected', () => {
        // Drop the dead reference so the next acquire relaunches.
        if (this.browser === browser) this.browser = null;
      });
      this.browser = browser;
    })().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  /** True when a live Chromium is connected (used by the health probe). */
  isConnected(): boolean {
    return this.browser?.isConnected() ?? false;
  }

  async stop(): Promise<void> {
    if (this.browser) {
      const b = this.browser;
      this.browser = null;
      await b.close();
    }
  }

  /**
   * Acquire a fresh context. Caller MUST `await release(context)` in a
   * `finally` block to return the slot to the pool.
   */
  async acquire(options: Parameters<Browser['newContext']>[0] = {}): Promise<BrowserContext> {
    // Relaunch if the browser died (crash/OOM) instead of failing forever.
    if (!this.browser?.isConnected()) {
      await this.start();
    }
    if (!this.browser) {
      throw new Error('BrowserPool not started');
    }

    // Wait for a free slot, but never wait forever: if all slots are stuck on
    // hung navigations, reject with a 503-worthy error rather than piling up.
    while (this.inUse >= this.size) {
      await this.waitForSlot();
    }

    this.inUse += 1;
    try {
      // A slot may have freed after a disconnect; ensure the browser is live.
      if (!this.browser?.isConnected()) await this.start();
      return await this.browser!.newContext({
        viewport: { width: 1366, height: 900 },
        userAgent:
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        ...options,
      });
    } catch (err) {
      this.inUse -= 1;
      this.wakeNext();
      throw err;
    }
  }

  async release(context: BrowserContext): Promise<void> {
    try {
      await context.close();
    } finally {
      this.inUse -= 1;
      this.wakeNext();
    }
  }

  private wakeNext(): void {
    const next = this.waiters.shift();
    if (next) next();
  }

  /** Wait for a slot to free, rejecting after ACQUIRE_WAIT_TIMEOUT_MS. */
  private waitForSlot(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const wake = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const idx = this.waiters.indexOf(wake);
        if (idx !== -1) this.waiters.splice(idx, 1);
        reject(new Error('Timed out waiting for a browser slot'));
      }, ACQUIRE_WAIT_TIMEOUT_MS);
      this.waiters.push(wake);
    });
  }
}
