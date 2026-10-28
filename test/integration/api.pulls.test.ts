import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PERSONAS } from '../../mock-carriers/index.js';
import { PolicyListSchema, PolicyResourceSchema, type PullResponse, PullSchema } from '../../src/http/schemas.js';
import { type Harness, resetDatabase, startHarness, waitForPull } from '../helpers/harness.js';
import { captureLogger } from '../helpers/logs.js';

type Persona = (typeof PERSONAS)[keyof typeof PERSONAS];
const connections = (p: Persona, overrides: Partial<Record<'carrier-a' | 'carrier-b' | 'carrier-c', string>> = {}) => [
  { carrierId: 'carrier-a', credentials: { username: p.carrierA.username, password: overrides['carrier-a'] ?? p.carrierA.password } },
  { carrierId: 'carrier-b', credentials: { username: p.carrierB.username, password: overrides['carrier-b'] ?? p.carrierB.password } },
  { carrierId: 'carrier-c', credentials: { username: p.carrierC.username, password: overrides['carrier-c'] ?? p.carrierC.password } },
];
const carrier = (body: PullResponse, id: string) => body.carriers.find((c) => c.carrierId === id)!;

describe('Pull lifecycle over HTTP (API + worker + Postgres + mock carriers)', () => {
  let h: Harness;
  const capture = captureLogger('debug');

  beforeAll(async () => {
    h = await startHarness({ logger: capture.logger });
  });
  afterAll(async () => {
    await h.stop();
  });
  beforeEach(async () => {
    await resetDatabase(h.runtime.prisma);
    h.mocks.reset();
  });

  it('accepts a pull with 202, runs it asynchronously, and exposes normalized policies', async () => {
    const created = await h.request.post('/pulls').send({ connections: connections(PERSONAS.alex) });
    expect(created.status).toBe(202);
    expect(created.headers.location).toBe(`/pulls/${created.body.id}`);
    expect(created.headers['idempotent-replayed']).toBe('false');
    expect(PullSchema.parse(created.body).status).toMatch(/pending|running/);

    const done = await waitForPull(h.request, created.body.id);
    const pull = PullSchema.parse(done.body);
    expect(pull.status).toBe('succeeded');
    expect(pull.summary).toEqual({ carriersTotal: 3, carriersSucceeded: 3, carriersFailed: 0, carriersInProgress: 0, policiesRetrieved: 8 });
    expect(pull.startedAt).not.toBeNull();
    expect(pull.completedAt).not.toBeNull();

    // Walk the keyset pagination: 8 policies at 3 per page.
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await h.request.get(`/pulls/${pull.id}/policies`).query({ limit: 3, ...(cursor ? { cursor } : {}) });
      expect(page.status).toBe(200);
      const parsed = PolicyListSchema.parse(page.body);
      seen.push(...parsed.data.map((p) => `${p.policy.carrierId}:${p.policy.externalPolicyId}`));
      cursor = parsed.pagination.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(8);
    expect(new Set(seen).size).toBe(8);
    expect(seen.filter((s) => s.startsWith('carrier-c:'))).toEqual(['carrier-c:CP-A-77002', 'carrier-c:CP-A-88120', 'carrier-c:CP-C-55021']);

    const list = await h.request.get(`/pulls/${pull.id}/policies`).query({ carrierId: 'carrier-b' });
    const umbrella = PolicyListSchema.parse(list.body).data.find((p) => p.policy.externalPolicyId === 'BL-55120-01')!;
    const single = await h.request.get(`/policies/${umbrella.id}`);
    expect(single.status).toBe(200);
    expect(PolicyResourceSchema.parse(single.body)).toEqual(umbrella);
    expect(single.body.policy).toMatchObject({ policyType: 'umbrella', premium: { amountCents: 31_850, currency: 'USD', term: 'annual' } });
    // Contract field order survives the JSONB round trip.
    expect(Object.keys(single.body.policy).slice(0, 3)).toEqual(['schemaVersion', 'carrierId', 'externalPolicyId']);
  });

  it('isolates carrier failures: one bad credential yields partially_succeeded, others keep their data', async () => {
    const created = await h.request.post('/pulls').send({ connections: connections(PERSONAS.jordan, { 'carrier-b': 'wrong-password' }) });
    const pull = PullSchema.parse((await waitForPull(h.request, created.body.id)).body);

    expect(pull.status).toBe('partially_succeeded');
    expect(carrier(pull, 'carrier-b')).toMatchObject({
      status: 'failed',
      attempts: 1, // authentication errors are not retried
      policyCount: 0,
      error: { category: 'authentication', code: 'invalid_credentials', retryable: false },
    });
    expect(carrier(pull, 'carrier-a')).toMatchObject({ status: 'succeeded', policyCount: 1, error: null });
    expect(carrier(pull, 'carrier-c')).toMatchObject({ status: 'succeeded', policyCount: 1 });

    const policies = await h.request.get(`/pulls/${pull.id}/policies`);
    expect(policies.body.data.map((p: { policy: { carrierId: string } }) => p.policy.carrierId).sort()).toEqual(['carrier-a', 'carrier-c']);
  });

  it('marks the pull failed when every carrier fails', async () => {
    const created = await h.request
      .post('/pulls')
      .send({ connections: connections(PERSONAS.sam, { 'carrier-a': 'x', 'carrier-b': 'x', 'carrier-c': 'x' }) });
    const pull = PullSchema.parse((await waitForPull(h.request, created.body.id)).body);
    expect(pull.status).toBe('failed');
    expect(pull.carriers.every((c) => c.error?.category === 'authentication')).toBe(true);
  });

  it('retries a transient carrier outage durably and records the failed attempt', async () => {
    // 3 consecutive 503s exhaust the in-process HTTP retries (1 + 2) for attempt 1.
    h.mocks.carrierB.faults.add({ method: 'GET', path: '/PolicyService/GetPolicyList', times: 3, action: { type: 'status', status: 503 } });
    const created = await h.request.post('/pulls').send({ connections: connections(PERSONAS.alex).slice(1, 2) });
    const pull = PullSchema.parse((await waitForPull(h.request, created.body.id)).body);

    expect(pull.status).toBe('succeeded');
    const b = carrier(pull, 'carrier-b');
    expect(b).toMatchObject({ status: 'succeeded', attempts: 2, policyCount: 2, error: null });
    expect(b.attemptHistory).toEqual([expect.objectContaining({ attempt: 1, category: 'carrier_unavailable', code: 'http_503', retryable: true })]);
  });

  it('surfaces record-level warnings and field-level normalization warnings', async () => {
    const created = await h.request.post('/pulls').send({ connections: connections(PERSONAS.jordan).slice(1, 2) });
    const pull = PullSchema.parse((await waitForPull(h.request, created.body.id)).body);
    expect(carrier(pull, 'carrier-b').warnings).toEqual([expect.objectContaining({ code: 'missing_policy_number' })]);

    const page = PolicyListSchema.parse((await h.request.get(`/pulls/${pull.id}/policies`)).body);
    const auto = page.data.find((p) => p.policy.externalPolicyId === 'BL-90311-02')!.policy;
    expect(auto.source.warnings).toContainEqual(expect.objectContaining({ field: 'vehicles[1].vin', code: 'invalid_vin' }));
    expect(auto.effectiveDate).toBe('2026-02-01');
    expect(auto.premium?.amountCents).toBe(128_460);
  });

  describe('idempotency', () => {
    const body = () => ({ connections: connections(PERSONAS.alex).slice(0, 1) });

    it('replays the original pull for a repeated key and body', async () => {
      const first = await h.request.post('/pulls').set('Idempotency-Key', 'key-123').send(body());
      const second = await h.request.post('/pulls').set('Idempotency-Key', 'key-123').send(body());
      expect(first.status).toBe(202);
      expect(second.status).toBe(200);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.body.id).toBe(first.body.id);
      expect(await h.runtime.prisma.pull.count()).toBe(1);
      await waitForPull(h.request, first.body.id);
    });

    it('rejects reuse of a key with a different body', async () => {
      const first = await h.request.post('/pulls').set('Idempotency-Key', 'key-456').send(body());
      const conflict = await h.request
        .post('/pulls')
        .set('Idempotency-Key', 'key-456')
        .send({ connections: connections(PERSONAS.jordan).slice(0, 1) });
      expect(conflict.status).toBe(422);
      expect(conflict.headers['content-type']).toContain('application/problem+json');
      expect(conflict.body).toMatchObject({ code: 'idempotency_key_reused', status: 422 });
      await waitForPull(h.request, first.body.id);
    });

    it('collapses concurrent duplicate requests into exactly one pull', async () => {
      const responses = await Promise.all(
        Array.from({ length: 6 }, () => h.request.post('/pulls').set('Idempotency-Key', 'race-key').send(body())),
      );
      const ids = new Set(responses.map((r) => r.body.id as string));
      expect(ids.size).toBe(1);
      expect(responses.filter((r) => r.status === 202)).toHaveLength(1);
      expect(responses.filter((r) => r.status === 200)).toHaveLength(5);
      expect(await h.runtime.prisma.pull.count()).toBe(1);
      expect(await h.runtime.prisma.pullTask.count()).toBe(1);
      await waitForPull(h.request, [...ids][0]!);
    });
  });

  describe('credential safety', () => {
    it('encrypts credentials at rest, purges them on completion, and never echoes or logs them', async () => {
      capture.lines.length = 0;
      const created = await h.request.post('/pulls').send({ connections: connections(PERSONAS.alex) });
      const stored = await h.runtime.prisma.pullTask.findMany({ where: { pullId: created.body.id } });
      for (const task of stored) {
        if (task.encryptedCredentials) expect(task.encryptedCredentials).not.toContain(PERSONAS.alex.carrierA.password);
      }

      const done = await waitForPull(h.request, created.body.id);
      const tasks = await h.runtime.prisma.pullTask.findMany({ where: { pullId: created.body.id } });
      expect(tasks.every((t) => t.encryptedCredentials === null)).toBe(true);

      const policies = await h.request.get(`/pulls/${created.body.id}/policies`).query({ limit: 100 });
      const everything = JSON.stringify([created.body, done.body, policies.body]) + capture.text();
      for (const secret of [PERSONAS.alex.carrierA.password, PERSONAS.alex.carrierB.password, PERSONAS.alex.carrierC.password]) {
        expect(everything).not.toContain(secret);
      }
      expect(everything).not.toMatch(/\b(at|rt|sk|sess)_[A-Za-z0-9_-]{16,}/); // carrier tokens / session ids
      expect(capture.text()).toContain(created.body.id); // worker logs are correlated to the pull
    });
  });
});
