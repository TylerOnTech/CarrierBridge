import { type Browser, type BrowserContext, chromium } from 'playwright';
import type { Logger } from '../../logging/logger.js';

export interface BrowserManagerOptions {
  headless: boolean;
  executablePath?: string | undefined;
  logger: Logger;
}

/**
 * One Chromium process per worker, one isolated BrowserContext (cookies, storage) per task.
 * Launching a browser costs ~0.5-1s and ~100MB, so it is shared and lazily (re)launched;
 * contexts are cheap and guarantee no session state leaks between customers.
 */
export class BrowserManager {
  private browser: Promise<Browser> | undefined;
  private closing = false;

  constructor(private readonly options: BrowserManagerOptions) {}

  async newContext(): Promise<BrowserContext> {
    const browser = await this.getBrowser();
    return browser.newContext({
      userAgent: 'CarrierBridge/0.1 (synthetic integration demo)',
      acceptDownloads: false,
      viewport: { width: 1280, height: 900 },
    });
  }

  private getBrowser(): Promise<Browser> {
    this.browser ??= chromium
      .launch({ headless: this.options.headless, executablePath: this.options.executablePath })
      .then((browser) => {
        this.options.logger.info({ version: browser.version() }, 'browser launched');
        browser.on('disconnected', () => {
          if (!this.closing) this.options.logger.warn('browser disconnected; will relaunch on next use');
          this.browser = undefined;
        });
        return browser;
      })
      .catch((error: unknown) => {
        this.browser = undefined;
        throw error;
      });
    return this.browser;
  }

  async close(): Promise<void> {
    const pending = this.browser;
    this.browser = undefined;
    if (!pending) return;
    this.closing = true;
    try {
      await (await pending).close();
    } catch {
      // Browser failed to launch or is already gone; nothing to clean up.
    } finally {
      this.closing = false;
    }
  }
}
