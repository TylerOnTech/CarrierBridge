import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCarrierAAdapter } from '../../src/carriers/carrier-a/adapter.js';
import { CarrierError } from '../../src/domain/errors.js';
import { NormalizedPolicySchema } from '../../src/contracts/index.js';
import { type MockCarriers, PERSONAS, startMockCarriers } from '../../mock-carriers/index.js';
import { adapterContext, creds } from '../helpers/adapter-context.js';
import { TEST_HTTP } from '../helpers/config.js';

const alex = PERSONAS.alex.carrierA;

describe('Carrier A adapter against the mock REST API', () => {
  let mocks: MockCarriers;
  const adapter = () => createCarrierAAdapter({ baseUrl: mocks.urls['carrier-a'], http: TEST_HTTP });
  const log = () => mocks.carrierA.log;

  beforeAll(async () => {
    mocks = await startMockCarriers();
  });
  afterAll(async () => {
    await mocks.close();
  });
  beforeEach(() => mocks.reset());

  it('walks cursor pagination, fetches details, and returns contract-valid policies', async () => {
    const result = await adapter().retrievePolicies(creds(alex.username, alex.password), adapterContext());
    expect(result.policies.map((p) => p.externalPolicyId)).toEqual(['APX-AUTO-100234', 'APX-HOME-200871', 'APX-AUTO-099120']);
    for (const p of result.policies) expect(() => NormalizedPolicySchema.parse(p)).not.toThrow();
    expect(result.stats).toMatchObject({ pages: 2, logins: 1, tokenRefreshes: 0 });
    expect(log().count('GET', '/v1/policies')).toBe(2);
    expect(result.policies[0]?.retrievedAt).toBe('2026-10-28T12:00:00.000Z');
  });

  it('classifies a bad password as a non-retryable authentication failure', async () => {
    const error = await adapter()
      .retrievePolicies(creds(alex.username, 'wrong-password'), adapterContext())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CarrierError);
    expect(error).toMatchObject({ category: 'authentication', code: 'invalid_credentials', retryable: false });
  });

  it('refreshes an expired access token and replays the request', async () => {
    mocks.carrierA.faults.add({
      method: 'GET',
      path: '/v1/policies',
      action: {
        type: 'status',
        status: 401,
        body: JSON.stringify({ error: 'invalid_token', error_description: 'The access token expired' }),
      },
    });
    const result = await adapter().retrievePolicies(creds(alex.username, alex.password), adapterContext());
    expect(result.policies).toHaveLength(3);
    expect(result.stats).toMatchObject({ logins: 1, tokenRefreshes: 1 });
    expect(log().count('POST', '/oauth/token')).toBe(2);
  });

  it('falls back to a fresh login when the refresh token is rejected', async () => {
    mocks.carrierA.faults.add({ method: 'GET', path: '/v1/policies', action: { type: 'status', status: 401, body: '{"error":"invalid_token"}' } });
    // Skip the initial login, then reject the refresh grant once.
    mocks.carrierA.faults.add({ method: 'POST', path: '/oauth/token', after: 1, action: { type: 'status', status: 400, body: '{"error":"invalid_grant"}' } });
    const result = await adapter().retrievePolicies(creds(alex.username, alex.password), adapterContext());
    expect(result.policies).toHaveLength(3);
    expect(result.stats).toMatchObject({ logins: 2, tokenRefreshes: 0 });
  });

  it('refreshes proactively when the token is about to expire', async () => {
    const shortLived = await startMockCarriers({ carrierA: { tokenTtlSeconds: 5 } });
    try {
      const result = await createCarrierAAdapter({ baseUrl: shortLived.urls['carrier-a'], http: TEST_HTTP }).retrievePolicies(
        creds(alex.username, alex.password),
        adapterContext(),
      );
      expect(result.policies).toHaveLength(3);
      // 5s TTL is inside the 30s refresh skew, so every request triggers a refresh first.
      expect(result.stats.tokenRefreshes).toBeGreaterThan(0);
    } finally {
      await shortLived.close();
    }
  });

  it('waits out a real rate limit using the Retry-After header', async () => {
    const limited = await startMockCarriers({ carrierA: { rateLimit: { limit: 3, windowMs: 1_000 } } });
    try {
      const started = Date.now();
      const result = await createCarrierAAdapter({ baseUrl: limited.urls['carrier-a'], http: TEST_HTTP }).retrievePolicies(
        creds(alex.username, alex.password),
        adapterContext(),
      );
      expect(result.policies).toHaveLength(3);
      expect(limited.carrierA.log.entries.some((e) => e.status === 429)).toBe(true);
      expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    } finally {
      await limited.close();
    }
  });

  it('classifies a truncated JSON body as invalid_response', async () => {
    mocks.carrierA.faults.add({ method: 'GET', path: '/v1/policies', action: { type: 'malformed_json' } });
    await expect(adapter().retrievePolicies(creds(alex.username, alex.password), adapterContext())).rejects.toMatchObject({
      category: 'invalid_response',
      code: 'malformed_json',
      retryable: false,
    });
  });

  it('classifies a structurally wrong listing as invalid_response', async () => {
    mocks.carrierA.faults.add({ method: 'GET', path: '/v1/policies', action: { type: 'status', status: 200, body: '{"items":[]}' } });
    await expect(adapter().retrievePolicies(creds(alex.username, alex.password), adapterContext())).rejects.toMatchObject({
      category: 'invalid_response',
      code: 'invalid_policy_list',
    });
  });

  it('retries transient 503s and fails as carrier_unavailable once retries are exhausted', async () => {
    mocks.carrierA.faults.add({ method: 'GET', path: '/v1/policies/*', times: 2, action: { type: 'status', status: 503 } });
    const recovered = await adapter().retrievePolicies(creds(alex.username, alex.password), adapterContext());
    expect(recovered.policies).toHaveLength(3);

    mocks.reset();
    mocks.carrierA.faults.add({ method: 'GET', path: '/v1/policies', times: 10, action: { type: 'status', status: 503 } });
    await expect(adapter().retrievePolicies(creds(alex.username, alex.password), adapterContext())).rejects.toMatchObject({
      category: 'carrier_unavailable',
      code: 'http_503',
      retryable: true,
    });
    expect(log().count('GET', '/v1/policies')).toBe(TEST_HTTP.maxRetries + 1);
  });

  it('records a warning and continues when a listed policy 404s on detail', async () => {
    mocks.carrierA.faults.add({ method: 'GET', path: '/v1/policies/APX-HOME-200871', action: { type: 'status', status: 404, body: '{}' } });
    const result = await adapter().retrievePolicies(creds(alex.username, alex.password), adapterContext());
    expect(result.policies).toHaveLength(2);
    expect(result.warnings).toEqual([expect.objectContaining({ code: 'record_not_found', externalPolicyId: 'APX-HOME-200871' })]);
  });
});
