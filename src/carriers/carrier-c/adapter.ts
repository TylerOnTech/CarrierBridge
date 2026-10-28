import { errors as playwrightErrors } from 'playwright';
import type { NormalizedPolicy } from '../../contracts/index.js';
import { CarrierError } from '../../domain/errors.js';
import { abortToCarrierError } from '../shared/abort.js';
import type { BrowserManager } from '../shared/browser-manager.js';
import { type UsernamePasswordCredentials, USERNAME_PASSWORD_FIELDS, usernamePasswordSchema } from '../shared/credentials.js';
import { RecordRejectedError } from '../shared/policy-builder.js';
import type { CarrierAdapter, CarrierDescriptor, RetrievalContext, RetrievalWarning } from '../types.js';
import { normalizeCarrierCPolicy } from './normalize.js';
import { PortalPages } from './portal/pages.js';
import { DASHBOARD_PATH } from './portal/selectors.js';

export const CARRIER_C_ID = 'carrier-c';
const MAX_DASHBOARD_PAGES = 20;
/** Re-logins allowed per retrieval before we conclude the portal will not keep a session. */
const MAX_REAUTHENTICATIONS = 5;

export const carrierCDescriptor: CarrierDescriptor = {
  id: CARRIER_C_ID,
  displayName: 'Carrier C (Browser-only Portal)',
  integrationType: 'browser',
  adapterVersion: '1.0.0',
  description: 'Headless Chromium logs in, walks the paginated dashboard, and scrapes each policy page.',
  credentialFields: USERNAME_PASSWORD_FIELDS,
};

export interface CarrierCAdapterConfig {
  baseUrl: string;
  navigationTimeoutMs: number;
  browser: BrowserManager;
}

export function createCarrierCAdapter(config: CarrierCAdapterConfig): CarrierAdapter<UsernamePasswordCredentials> {
  return {
    descriptor: carrierCDescriptor,
    credentialsSchema: usernamePasswordSchema,

    async retrievePolicies(credentials, ctx) {
      const context = await config.browser.newContext();
      // Closing the context is how we cancel in-flight Playwright calls on deadline/shutdown.
      const onAbort = () => void context.close().catch(() => undefined);
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(config.navigationTimeoutMs);
        page.setDefaultNavigationTimeout(config.navigationTimeoutMs);
        return await scrape(new PortalPages(page, config.baseUrl, CARRIER_C_ID), credentials, ctx);
      } catch (error) {
        throw classifyBrowserError(error, ctx);
      } finally {
        ctx.signal.removeEventListener('abort', onAbort);
        await context.close().catch(() => undefined);
      }
    },
  };
}

async function scrape(pages: PortalPages, credentials: UsernamePasswordCredentials, ctx: RetrievalContext) {
  let reauthentications = 0;
  await pages.login(credentials);

  /** Navigates to `path`, transparently re-logging in if the portal bounced us to /login. */
  const visit = async (path: string): Promise<void> => {
    if (pages.isAt(path)) return; // e.g. login already redirected us here
    if ((await pages.goto(path)) === 'ok') return;
    if (++reauthentications > MAX_REAUTHENTICATIONS) {
      throw new CarrierError({
        carrierId: CARRIER_C_ID,
        category: 'session_expired',
        code: 'session_expired_repeatedly',
        message: `Portal session expired more than ${MAX_REAUTHENTICATIONS} times during one retrieval`,
      });
    }
    ctx.logger.info({ path, reauthentications }, 'portal session expired; logging in again');
    await pages.login(credentials); // the portal redirects back to `path` after login
    if (!pages.isAt(path) && (await pages.goto(path)) !== 'ok') {
      throw new CarrierError({
        carrierId: CARRIER_C_ID,
        category: 'session_expired',
        code: 'session_not_established',
        message: 'Portal did not accept the session immediately after login',
      });
    }
  };

  // 1. Collect policy links across dashboard pages.
  const policyPaths: string[] = [];
  let next: string | null = DASHBOARD_PATH;
  for (let pageCount = 0; next; pageCount++) {
    if (pageCount >= MAX_DASHBOARD_PAGES) break;
    await visit(next);
    const dashboard = await pages.readDashboard();
    for (const p of dashboard.policyPaths) if (!policyPaths.includes(p)) policyPaths.push(p);
    next = dashboard.nextPath;
  }

  // 2. Visit each policy sequentially: one tab per customer keeps the session realistic and polite.
  const meta = {
    carrierId: CARRIER_C_ID,
    integrationType: 'browser' as const,
    adapterVersion: carrierCDescriptor.adapterVersion,
    retrievedAt: ctx.now().toISOString(),
  };
  const policies: NormalizedPolicy[] = [];
  const warnings: RetrievalWarning[] = [];
  for (const path of policyPaths) {
    await visit(path);
    const raw = await pages.readPolicy();
    try {
      policies.push(normalizeCarrierCPolicy(raw, meta));
    } catch (error) {
      if (!(error instanceof RecordRejectedError)) throw error;
      warnings.push({ code: error.code, message: `${error.message} (${path})`, externalPolicyId: null });
    }
  }
  return { policies, warnings, stats: { policyPages: policyPaths.length, reauthentications } };
}

function classifyBrowserError(error: unknown, ctx: RetrievalContext): CarrierError {
  if (ctx.signal.aborted) return abortToCarrierError(CARRIER_C_ID, ctx.signal);
  if (error instanceof CarrierError) return error;
  if (error instanceof playwrightErrors.TimeoutError) {
    return new CarrierError({
      carrierId: CARRIER_C_ID,
      category: 'timeout',
      code: 'navigation_timeout',
      message: 'Portal page or element did not load within the navigation timeout',
      cause: error,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/net::ERR_/.test(message)) {
    return new CarrierError({
      carrierId: CARRIER_C_ID,
      category: 'carrier_unavailable',
      code: 'portal_unreachable',
      message: `Portal could not be reached (${/net::ERR_[A-Z_]+/.exec(message)?.[0] ?? 'network error'})`,
      cause: error,
    });
  }
  return new CarrierError({
    carrierId: CARRIER_C_ID,
    category: 'internal',
    code: 'browser_error',
    message: 'Unexpected browser automation failure',
    retryable: true,
    cause: error,
  });
}
