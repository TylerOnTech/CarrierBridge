import type { Page } from 'playwright';
import { CarrierError } from '../../../domain/errors.js';
import type { UsernamePasswordCredentials } from '../../shared/credentials.js';
import { LOGIN_PATH, SELECTORS } from './selectors.js';

/** Strings scraped from a policy page, before any interpretation. */
export interface RawPortalPolicy {
  summary: Record<string, string>;
  coverages: Array<{ name: string; limit: string; deductible: string }>;
  /** null when the section is absent from the page (as opposed to present but empty). */
  vehicles: Array<{ description: string; vin: string }> | null;
  drivers: string[] | null;
}

export type NavigationOutcome = 'ok' | 'login_required';

/** Page-object layer: knows URLs and markup, nothing about normalization or retries. */
export class PortalPages {
  constructor(
    private readonly page: Page,
    private readonly baseUrl: string,
    private readonly carrierId: string,
  ) {}

  currentPath(): string {
    return new URL(this.page.url()).pathname;
  }

  async goto(path: string): Promise<NavigationOutcome> {
    const response = await this.page.goto(new URL(path, this.baseUrl).toString(), { waitUntil: 'domcontentloaded' });
    const status = response?.status() ?? 0;
    if (status >= 500) {
      throw new CarrierError({
        carrierId: this.carrierId,
        category: 'carrier_unavailable',
        code: `http_${status}`,
        message: `Portal returned HTTP ${status} for ${path}`,
      });
    }
    return this.currentPath() === LOGIN_PATH ? 'login_required' : 'ok';
  }

  /** True if the browser is already showing `path` (pathname and query). */
  isAt(path: string): boolean {
    const current = new URL(this.page.url());
    const target = new URL(path, this.baseUrl);
    return current.pathname === target.pathname && current.search === target.search;
  }

  /** Submits the login form on the current page (navigating to it first if needed). */
  async login(credentials: UsernamePasswordCredentials): Promise<void> {
    if (this.currentPath() !== LOGIN_PATH) await this.goto(LOGIN_PATH);
    await this.requireElement(SELECTORS.login.username, 'login form');
    await this.page.fill(SELECTORS.login.username, credentials.username);
    await this.page.fill(SELECTORS.login.password, credentials.password.reveal());
    // Register the wait before clicking so the post-submit document cannot be missed.
    await Promise.all([this.page.waitForEvent('domcontentloaded'), this.page.click(SELECTORS.login.submit)]);

    if ((await this.page.locator(SELECTORS.login.error).count()) > 0) {
      throw new CarrierError({
        carrierId: this.carrierId,
        category: 'authentication',
        code: 'invalid_credentials',
        message: 'Portal rejected the supplied credentials',
      });
    }
    if (this.currentPath() === LOGIN_PATH) {
      throw new CarrierError({
        carrierId: this.carrierId,
        category: 'session_expired',
        code: 'session_not_established',
        message: 'Portal returned to the login page immediately after a successful sign-in',
      });
    }
  }

  async readDashboard(): Promise<{ policyPaths: string[]; nextPath: string | null }> {
    await this.requireElement(SELECTORS.dashboard.root, 'dashboard');
    const policyPaths = await this.page
      .locator(SELECTORS.dashboard.policyLink)
      .evaluateAll((links) => links.map((a) => a.getAttribute('href') ?? '').filter(Boolean));
    const next = this.page.locator(SELECTORS.dashboard.nextPage);
    const nextPath = (await next.count()) > 0 ? await next.first().getAttribute('href') : null;
    return { policyPaths, nextPath };
  }

  async readPolicy(): Promise<RawPortalPolicy> {
    await this.requireElement(SELECTORS.policy.root, 'policy detail page');
    // The summary block is mandatory: if it is missing the portal layout changed and
    // silently returning empty data would be worse than failing loudly.
    await this.requireElement(SELECTORS.policy.summaryRow, 'policy summary');

    const summaryEntries = await this.page.locator(SELECTORS.policy.summaryRow).evaluateAll((rows) =>
      rows.map((row): [string, string] => [row.querySelector('dt')?.textContent?.trim() ?? '', row.querySelector('dd')?.textContent?.trim() ?? '']),
    );
    const coverages = await this.page.locator(SELECTORS.policy.coverageRow).evaluateAll((rows) =>
      rows.map((row) => ({
        name: row.querySelector('[data-col="coverage"]')?.textContent?.trim() ?? '',
        limit: row.querySelector('[data-col="limit"]')?.textContent?.trim() ?? '',
        deductible: row.querySelector('[data-col="deductible"]')?.textContent?.trim() ?? '',
      })),
    );

    // Optional sections: absence is data ("not shown"), not an error, so no waiting.
    const vehicles =
      (await this.page.locator(SELECTORS.policy.vehiclesSection).count()) === 0
        ? null
        : await this.page.locator(SELECTORS.policy.vehicle).evaluateAll((items) =>
            items.map((li) => ({
              description: li.querySelector('[data-field="description"]')?.textContent?.trim() ?? '',
              vin: li.querySelector('[data-field="vin"]')?.textContent?.trim() ?? '',
            })),
          );
    const drivers =
      (await this.page.locator(SELECTORS.policy.driversSection).count()) === 0
        ? null
        : await this.page.locator(SELECTORS.policy.driver).allTextContents();

    return {
      summary: Object.fromEntries(summaryEntries.filter(([label]) => label)),
      coverages,
      vehicles,
      drivers: drivers?.map((d) => d.trim()) ?? null,
    };
  }

  private async requireElement(selector: string, what: string): Promise<void> {
    if ((await this.page.locator(selector).count()) === 0) {
      throw new CarrierError({
        carrierId: this.carrierId,
        category: 'invalid_response',
        code: 'portal_layout_changed',
        message: `Expected ${what} was not found on ${this.currentPath()}`,
        details: { selector },
      });
    }
  }
}
