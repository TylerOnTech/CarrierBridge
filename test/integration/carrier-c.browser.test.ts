import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCarrierCAdapter } from '../../src/carriers/carrier-c/adapter.js';
import { TaskAbortError } from '../../src/carriers/shared/abort.js';
import { BrowserManager } from '../../src/carriers/shared/browser-manager.js';
import { NormalizedPolicySchema } from '../../src/contracts/index.js';
import { createLogger } from '../../src/logging/logger.js';
import { type MockCarriers, PERSONAS, startMockCarriers } from '../../mock-carriers/index.js';
import { adapterContext, creds } from '../helpers/adapter-context.js';

const alex = PERSONAS.alex.carrierC;

describe('Carrier C adapter: Playwright against the local mock portal', () => {
  let mocks: MockCarriers;
  const browser = new BrowserManager({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE_PATH, logger: createLogger({ level: 'silent', pretty: false }) });
  const adapter = (navigationTimeoutMs = 5_000, baseUrl?: string) =>
    createCarrierCAdapter({ baseUrl: baseUrl ?? mocks.urls['carrier-c'], navigationTimeoutMs, browser });

  beforeAll(async () => {
    mocks = await startMockCarriers();
  });
  afterAll(async () => {
    await browser.close();
    await mocks.close();
  });
  beforeEach(() => mocks.reset());

  it('logs in, walks the paginated dashboard, and scrapes every policy page', async () => {
    const result = await adapter().retrievePolicies(creds(alex.username, alex.password), adapterContext());
    expect(result.policies.map((p) => p.externalPolicyId)).toEqual(['CP-A-88120', 'CP-C-55021', 'CP-A-77002']);
    for (const p of result.policies) expect(() => NormalizedPolicySchema.parse(p)).not.toThrow();
    expect(mocks.carrierC.log.count('GET', '/dashboard')).toBe(2);

    const [auto, condo, expired] = result.policies;
    expect(auto).toMatchObject({
      policyType: 'auto',
      status: 'active',
      effectiveDate: '2026-05-12',
      premium: { amountCents: 58_810, term: 'semi_annual' },
      vehicles: [{ vin: 'JM1BPBDLXM1301122', year: 2021, make: 'Mazda', model: 'CX-5' }],
      drivers: [{ fullName: 'Alex Rivera' }],
    });
    // Missing elements on the page: no premium, no vehicles/drivers sections.
    expect(condo).toMatchObject({ policyType: 'condo', premium: null, vehicles: null, drivers: null });
    expect(expired).toMatchObject({ status: 'expired', drivers: null });
  });

  it('reports rejected credentials as an authentication failure', async () => {
    await expect(adapter().retrievePolicies(creds(alex.username, 'wrong'), adapterContext())).rejects.toMatchObject({
      category: 'authentication',
      code: 'invalid_credentials',
      retryable: false,
    });
  });

  it('logs back in when the session expires mid-scrape and still returns everything', async () => {
    mocks.carrierC.expireSessionAfterPageViews = 2;
    const result = await adapter().retrievePolicies(creds(alex.username, alex.password), adapterContext());
    expect(result.policies).toHaveLength(3);
    expect(result.stats.reauthentications).toBeGreaterThanOrEqual(1);
    expect(mocks.carrierC.logins).toBe(1 + result.stats.reauthentications!);
  });

  it('gives up with session_expired if the portal will not hold a session', async () => {
    mocks.carrierC.expireSessionAfterPageViews = 0;
    await expect(adapter().retrievePolicies(creds(alex.username, alex.password), adapterContext())).rejects.toMatchObject({
      category: 'session_expired',
    });
  });

  it('classifies a page that never loads as a navigation timeout', async () => {
    mocks.carrierC.faults.add({ method: 'GET', path: '/policies/*', action: { type: 'delay', ms: 3_000 } });
    await expect(adapter(500).retrievePolicies(creds(alex.username, alex.password), adapterContext())).rejects.toMatchObject({
      category: 'timeout',
      code: 'navigation_timeout',
      retryable: true,
    });
  });

  it('fails loudly (not with empty data) when a required element disappears after a redesign', async () => {
    mocks.carrierC.layoutVersion = 'v2';
    await expect(adapter().retrievePolicies(creds(alex.username, alex.password), adapterContext())).rejects.toMatchObject({
      category: 'invalid_response',
      code: 'portal_layout_changed',
      retryable: false,
    });
  });

  it('classifies an unreachable portal as carrier_unavailable', async () => {
    await expect(adapter(2_000, 'http://127.0.0.1:9').retrievePolicies(creds(alex.username, alex.password), adapterContext())).rejects.toMatchObject({
      category: 'carrier_unavailable',
      code: 'portal_unreachable',
    });
  });

  it('stops promptly when the task deadline aborts the retrieval', async () => {
    mocks.carrierC.faults.add({ method: 'GET', path: '/policies/*', action: { type: 'delay', ms: 4_000 } });
    const controller = new AbortController();
    setTimeout(() => controller.abort(new TaskAbortError('task_timeout')), 300);
    const started = Date.now();
    await expect(
      adapter(10_000).retrievePolicies(creds(alex.username, alex.password), adapterContext({ signal: controller.signal })),
    ).rejects.toMatchObject({ category: 'timeout', code: 'task_deadline_exceeded' });
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
