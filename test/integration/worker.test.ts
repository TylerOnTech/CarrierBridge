import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CarrierRegistry } from '../../src/carriers/registry.js';
import type { CarrierAdapter, RetrievalContext, RetrievalResult } from '../../src/carriers/types.js';
import { NORMALIZED_POLICY_SCHEMA_VERSION, type NormalizedPolicy } from '../../src/contracts/index.js';
import { CarrierError } from '../../src/domain/errors.js';
import { CredentialCipher } from '../../src/security/credential-cipher.js';
import { PullSchema } from '../../src/http/schemas.js';
import { type Harness, resetDatabase, startHarness, waitFor, waitForPull } from '../helpers/harness.js';
import { TEST_ENCRYPTION_KEY } from '../helpers/config.js';

type Behavior = (credentials: { token: string }, ctx: RetrievalContext, call: number) => Promise<RetrievalResult>;

function policy(carrierId: string, externalPolicyId: string): NormalizedPolicy {
  return {
    schemaVersion: NORMALIZED_POLICY_SCHEMA_VERSION,
    carrierId,
    externalPolicyId,
    policyholder: { fullName: 'Test Person', firstName: 'Test', lastName: 'Person' },
    policyType: 'auto',
    status: 'active',
    effectiveDate: '2026-01-01',
    expirationDate: '2026-07-01',
    premium: { amountCents: 10_000, currency: 'USD', term: 'semi_annual' },
    coverages: [],
    vehicles: [],
    drivers: [],
    retrievedAt: new Date().toISOString(),
    source: { integrationType: 'rest_api', adapterVersion: 'test', rawValues: {}, warnings: [] },
  };
}

const ok = (carrierId: string, ids: string[] = ['P-1']): RetrievalResult => ({ policies: ids.map((id) => policy(carrierId, id)), warnings: [], stats: {} });

/** A scripted adapter: deterministic, instrumented, and free of network or browser I/O. */
function fakeAdapter(id: string, behavior: Behavior): CarrierAdapter<{ token: string }> & { calls: number } {
  const adapter = {
    calls: 0,
    descriptor: { id, displayName: id, integrationType: 'rest_api' as const, adapterVersion: 'test', description: 'fake', credentialFields: [] },
    credentialsSchema: z.strictObject({ token: z.string() }),
    retrievePolicies: (credentials: { token: string }, ctx: RetrievalContext) => behavior(credentials, ctx, ++adapter.calls),
  };
  return adapter;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Worker: queue semantics, concurrency, retries, and recovery', () => {
  let h: Harness | undefined;

  async function boot(adapters: Array<{ adapter: CarrierAdapter<{ token: string }>; concurrency: number }>, env: Record<string, string> = {}, startWorker = true) {
    h = await startHarness({
      env,
      startWorker,
      registry: () => {
        const registry = new CarrierRegistry();
        for (const { adapter, concurrency } of adapters) registry.register(adapter, { concurrency });
        return registry;
      },
    });
    await resetDatabase(h.runtime.prisma);
    return h;
  }

  const createPull = (harness: Harness, carriers: string[]) =>
    harness.request.post('/pulls').send({ connections: carriers.map((carrierId) => ({ carrierId, credentials: { token: `tok-${carrierId}` } })) });

  afterEach(async () => {
    await h?.stop();
    h = undefined;
  });

  it('decrypts credentials for the adapter and persists its policies', async () => {
    let received: unknown;
    const a = fakeAdapter('fake-a', async (credentials) => {
      received = credentials;
      return ok('fake-a', ['P-1', 'P-2']);
    });
    const harness = await boot([{ adapter: a, concurrency: 1 }]);
    const pull = PullSchema.parse((await waitForPull(harness.request, (await createPull(harness, ['fake-a'])).body.id)).body);
    expect(received).toEqual({ token: 'tok-fake-a' });
    expect(pull).toMatchObject({ status: 'succeeded', summary: { policiesRetrieved: 2 } });
  });

  it('enforces global and per-carrier concurrency limits while still running in parallel', async () => {
    const active = { total: 0, 'fake-a': 0, 'fake-b': 0 };
    const peak = { total: 0, 'fake-a': 0, 'fake-b': 0 };
    const tracked = (id: 'fake-a' | 'fake-b') =>
      fakeAdapter(id, async () => {
        active.total++;
        active[id]++;
        peak.total = Math.max(peak.total, active.total);
        peak[id] = Math.max(peak[id], active[id]);
        await sleep(150);
        active.total--;
        active[id]--;
        return ok(id);
      });
    const harness = await boot(
      [
        { adapter: tracked('fake-a'), concurrency: 2 },
        { adapter: tracked('fake-b'), concurrency: 1 },
      ],
      { WORKER_CONCURRENCY: '3' },
    );
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push((await createPull(harness, ['fake-a', 'fake-b'])).body.id as string);
    for (const id of ids) expect((await waitForPull(harness.request, id)).body.status).toBe('succeeded');

    expect(peak['fake-a']).toBe(2);
    expect(peak['fake-b']).toBe(1);
    expect(peak.total).toBe(3);
  });

  it('reschedules retryable failures with backoff, then succeeds', async () => {
    const a = fakeAdapter('fake-a', async (_c, _ctx, call) => {
      if (call < 3) throw new CarrierError({ carrierId: 'fake-a', category: 'carrier_unavailable', code: 'http_503', message: 'down' });
      return ok('fake-a');
    });
    const harness = await boot([{ adapter: a, concurrency: 1 }]);
    const pull = PullSchema.parse((await waitForPull(harness.request, (await createPull(harness, ['fake-a'])).body.id)).body);
    expect(pull.status).toBe('succeeded');
    expect(pull.carriers[0]).toMatchObject({ attempts: 3, error: null });
    expect(pull.carriers[0]?.attemptHistory.map((h) => h.attempt)).toEqual([1, 2]);
  });

  it('fails permanently after maxAttempts, and immediately for non-retryable errors', async () => {
    const flaky = fakeAdapter('fake-a', async () => {
      throw new CarrierError({ carrierId: 'fake-a', category: 'timeout', code: 'request_timeout', message: 'slow' });
    });
    const invalid = fakeAdapter('fake-b', async () => {
      throw new CarrierError({ carrierId: 'fake-b', category: 'invalid_response', code: 'bad_shape', message: 'nope' });
    });
    const harness = await boot([
      { adapter: flaky, concurrency: 1 },
      { adapter: invalid, concurrency: 1 },
    ]);
    const pull = PullSchema.parse((await waitForPull(harness.request, (await createPull(harness, ['fake-a', 'fake-b'])).body.id)).body);
    expect(pull.status).toBe('failed');
    expect(pull.carriers.find((c) => c.carrierId === 'fake-a')).toMatchObject({ attempts: 3, error: { category: 'timeout', retryable: true } });
    expect(pull.carriers.find((c) => c.carrierId === 'fake-b')).toMatchObject({ attempts: 1, error: { category: 'invalid_response', retryable: false } });
    expect(flaky.calls).toBe(3);
    expect(invalid.calls).toBe(1);
  });

  it('aborts adapters that exceed the task deadline', async () => {
    const hang = fakeAdapter('fake-a', (_c, ctx) => new Promise((_resolve, reject) => ctx.signal.addEventListener('abort', () => reject(new Error('aborted')))));
    const harness = await boot([{ adapter: hang, concurrency: 1 }], { TASK_TIMEOUT_MS: '150', TASK_MAX_ATTEMPTS: '2' });
    const pull = PullSchema.parse((await waitForPull(harness.request, (await createPull(harness, ['fake-a'])).body.id)).body);
    expect(pull.carriers[0]).toMatchObject({ status: 'failed', attempts: 2, error: { category: 'timeout', code: 'task_deadline_exceeded' } });
  });

  it('drops contract-violating policies with a warning instead of persisting them', async () => {
    const leaky = fakeAdapter('fake-a', async () => ({
      policies: [policy('fake-a', 'GOOD'), { ...policy('fake-a', 'BAD'), accessToken: 'leaked' } as NormalizedPolicy],
      warnings: [],
      stats: {},
    }));
    const harness = await boot([{ adapter: leaky, concurrency: 1 }]);
    const pull = PullSchema.parse((await waitForPull(harness.request, (await createPull(harness, ['fake-a'])).body.id)).body);
    expect(pull.carriers[0]).toMatchObject({ policyCount: 1, warnings: [expect.objectContaining({ code: 'contract_violation', externalPolicyId: 'BAD' })] });
    expect(JSON.stringify(await harness.runtime.prisma.policy.findMany())).not.toContain('leaked');
  });

  it('recovers a task abandoned by a crashed worker once its lease expires', async () => {
    const a = fakeAdapter('fake-a', async () => ok('fake-a'));
    const harness = await boot([{ adapter: a, concurrency: 1 }], {}, false);
    const { prisma } = harness.runtime;
    const created = await createPull(harness, ['fake-a']);
    // Simulate a worker that claimed the task and then died without heartbeating.
    await prisma.$executeRaw`UPDATE pull_tasks SET status = 'running', attempts = 1, lease_token = gen_random_uuid(), lease_expires_at = now() - interval '1 second'`;
    await prisma.$executeRaw`UPDATE pulls SET status = 'running'`;

    harness.runtime.worker.start();
    const pull = PullSchema.parse((await waitForPull(harness.request, created.body.id)).body);
    expect(pull.status).toBe('succeeded');
    expect(pull.carriers[0]).toMatchObject({ attempts: 2 });
    expect(pull.carriers[0]?.attemptHistory).toEqual([expect.objectContaining({ code: 'lease_expired' })]);
  });

  it('fences out a stale worker whose lease was taken over', async () => {
    const a = fakeAdapter('fake-a', async () => ok('fake-a'));
    const harness = await boot([{ adapter: a, concurrency: 1 }], {}, false);
    const { queue, prisma } = harness.runtime;
    await createPull(harness, ['fake-a']);

    const [stale] = await queue.claim('fake-a', 1, 60_000);
    await prisma.$executeRaw`UPDATE pull_tasks SET lease_expires_at = now() - interval '1 second'`;
    await queue.recoverExpiredLeases();
    const [current] = await queue.claim('fake-a', 1, 60_000);
    expect(current?.leaseToken).not.toBe(stale?.leaseToken);

    expect(await queue.complete(stale!, [policy('fake-a', 'STALE')], [])).toBe(false);
    expect(await queue.heartbeat(stale!, 60_000)).toBe(false);
    expect(await queue.complete(current!, [policy('fake-a', 'FRESH')], [])).toBe(true);
    expect((await prisma.policy.findMany()).map((p) => p.externalPolicyId)).toEqual(['FRESH']);
  });

  it('on graceful shutdown, releases in-flight tasks back to the queue without consuming an attempt', async () => {
    let started = false;
    const a = fakeAdapter('fake-a', (_c, ctx, call) => {
      if (call > 1) return Promise.resolve(ok('fake-a'));
      started = true;
      return new Promise((_resolve, reject) => ctx.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    });
    const harness = await boot([{ adapter: a, concurrency: 1 }]);
    const created = await createPull(harness, ['fake-a']);
    await waitFor(() => started);

    await harness.runtime.worker.stop(100);
    const task = await harness.runtime.prisma.pullTask.findFirstOrThrow();
    expect(task).toMatchObject({ status: 'pending', attempts: 0, leaseToken: null });
    expect(task.encryptedCredentials).not.toBeNull(); // still needed for the next attempt

    harness.runtime.worker.start(); // e.g. the replacement process
    const pull = PullSchema.parse((await waitForPull(harness.request, created.body.id)).body);
    expect(pull).toMatchObject({ status: 'succeeded', carriers: [expect.objectContaining({ attempts: 1 })] });
  });

  it('fails a task whose stored credentials were tampered with, without retrying', async () => {
    const a = fakeAdapter('fake-a', async () => ok('fake-a'));
    const harness = await boot([{ adapter: a, concurrency: 1 }], {}, false);
    const created = await createPull(harness, ['fake-a']);
    const other = new CredentialCipher(Buffer.from(TEST_ENCRYPTION_KEY, 'base64')).seal('{"token":"x"}', '00000000-0000-4000-8000-000000000000');
    await harness.runtime.prisma.pullTask.updateMany({ data: { encryptedCredentials: other } });
    harness.runtime.worker.start();
    const pull = PullSchema.parse((await waitForPull(harness.request, created.body.id)).body);
    expect(pull.carriers[0]).toMatchObject({ status: 'failed', attempts: 1, error: { category: 'internal', code: 'unexpected_error' } });
    expect(a.calls).toBe(0);
  });
});
