import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCarrierBAdapter } from '../../src/carriers/carrier-b/adapter.js';
import { type MockCarriers, PERSONAS, startMockCarriers } from '../../mock-carriers/index.js';
import { adapterContext, creds } from '../helpers/adapter-context.js';
import { TEST_HTTP } from '../helpers/config.js';
import { captureLogger } from '../helpers/logs.js';

const LIST = '/PolicyService/GetPolicyList';
const AUTH = '/PolicyService/Authenticate';
const jordan = PERSONAS.jordan.carrierB;

describe('Carrier B adapter against the mock legacy API', () => {
  let mocks: MockCarriers;
  const adapter = () => createCarrierBAdapter({ baseUrl: mocks.urls['carrier-b'], http: TEST_HTTP });

  beforeAll(async () => {
    mocks = await startMockCarriers();
  });
  afterAll(async () => {
    await mocks.close();
  });
  beforeEach(() => mocks.reset());

  it('retrieves and normalizes policies, skipping an unidentifiable record with a warning', async () => {
    const result = await adapter().retrievePolicies(creds(jordan.username, jordan.password), adapterContext());
    expect(result.policies.map((p) => p.externalPolicyId)).toEqual(['BL-90311-02', 'BL-90311-01', 'BL-90311-05']);
    expect(result.warnings).toEqual([expect.objectContaining({ code: 'missing_policy_number' })]);
    expect(result.stats).toMatchObject({ records: 4, logins: 1, reauthentications: 0 });
  });

  it('handles the single-object XML quirk for a one-policy account', async () => {
    const sam = PERSONAS.sam.carrierB;
    const result = await adapter().retrievePolicies(creds(sam.username, sam.password), adapterContext());
    expect(result.policies.map((p) => p.externalPolicyId)).toEqual(['BL-61001-07']);
  });

  it('detects auth failure reported as HTTP 200 with an error ReturnCode', async () => {
    await expect(adapter().retrievePolicies(creds(jordan.username, 'nope'), adapterContext())).rejects.toMatchObject({
      category: 'authentication',
      code: 'invalid_credentials',
      retryable: false,
    });
  });

  it('re-authenticates once when the session expires and completes the retrieval', async () => {
    mocks.carrierB.faults.add({
      method: 'GET',
      path: LIST,
      action: { type: 'status', status: 200, body: JSON.stringify({ GetPolicyListResult: { ReturnCode: '210', ReturnMsg: 'SESSION EXPIRED' } }) },
    });
    const result = await adapter().retrievePolicies(creds(jordan.username, jordan.password), adapterContext());
    expect(result.policies).toHaveLength(3);
    expect(result.stats).toMatchObject({ logins: 2, reauthentications: 1 });
    expect(mocks.carrierB.log.count('POST', AUTH)).toBe(2);
  });

  it('fails as session_expired if the session dies again right after re-authenticating', async () => {
    mocks.carrierB.faults.add({
      method: 'GET',
      path: LIST,
      times: 5,
      action: { type: 'status', status: 200, body: JSON.stringify({ GetPolicyListResult: { ReturnCode: '210' } }) },
    });
    await expect(adapter().retrievePolicies(creds(jordan.username, jordan.password), adapterContext())).rejects.toMatchObject({
      category: 'session_expired',
      code: 'session_expired_after_reauth',
    });
  });

  it('rides through intermittent 503 maintenance pages', async () => {
    const flaky = await startMockCarriers({ carrierB: { intermittentFailureEvery: 1 } });
    try {
      // Every list request fails -> exhausts retries.
      await expect(
        createCarrierBAdapter({ baseUrl: flaky.urls['carrier-b'], http: TEST_HTTP }).retrievePolicies(creds(jordan.username, jordan.password), adapterContext()),
      ).rejects.toMatchObject({ category: 'carrier_unavailable', code: 'http_503' });
    } finally {
      await flaky.close();
    }
    mocks.carrierB.faults.add({ method: 'GET', path: LIST, times: 2, action: { type: 'status', status: 503, contentType: 'text/html', body: '<h1>Maintenance</h1>' } });
    const result = await adapter().retrievePolicies(creds(jordan.username, jordan.password), adapterContext());
    expect(result.policies).toHaveLength(3);
    expect(result.stats.retries).toBe(2);
  });

  it('rejects an HTML page served with HTTP 200 as invalid_response', async () => {
    mocks.carrierB.faults.add({ method: 'GET', path: LIST, action: { type: 'status', status: 200, contentType: 'text/html', body: '<html>Error</html>' } });
    await expect(adapter().retrievePolicies(creds(jordan.username, jordan.password), adapterContext())).rejects.toMatchObject({
      category: 'invalid_response',
      code: 'unexpected_content_type',
    });
  });

  it('rejects an unexpected envelope as invalid_response', async () => {
    mocks.carrierB.faults.add({ method: 'GET', path: LIST, action: { type: 'status', status: 200, body: '{"Result":"OK"}' } });
    await expect(adapter().retrievePolicies(creds(jordan.username, jordan.password), adapterContext())).rejects.toMatchObject({
      category: 'invalid_response',
      code: 'invalid_policy_list',
    });
  });

  it('never logs the session key that travels in the query string', async () => {
    const { logger, text } = captureLogger('debug');
    await adapter().retrievePolicies(creds(jordan.username, jordan.password), adapterContext({ logger }));
    expect(text()).toContain('SessionKey=REDACTED');
    expect(text()).not.toMatch(/sk_[A-Za-z0-9_-]{10}/);
    expect(text()).not.toContain(jordan.password);
  });
});
