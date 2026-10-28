/**
 * Seeds the database with historical pulls built from the same synthetic carrier data the
 * mocks serve, run through the real normalizers, so seeded rows are exactly what a live
 * pull would produce. Fixed IDs and timestamps make the seed idempotent and deterministic.
 */
import { PrismaClient } from '@prisma/client';
import { normalizeCarrierAPolicy } from '../src/carriers/carrier-a/normalize.js';
import { PolicyDetailSchema } from '../src/carriers/carrier-a/schemas.js';
import { normalizeCarrierBPolicy } from '../src/carriers/carrier-b/normalize.js';
import { normalizeCarrierCPolicy } from '../src/carriers/carrier-c/normalize.js';
import type { RawPortalPolicy } from '../src/carriers/carrier-c/portal/pages.js';
import { RecordRejectedError, type PolicyMeta } from '../src/carriers/shared/policy-builder.js';
import { type NormalizedPolicy, NormalizedPolicySchema } from '../src/contracts/index.js';
import { CARRIER_A_POLICIES } from '../mock-carriers/data/carrier-a.js';
import { CARRIER_B_POLICIES } from '../mock-carriers/data/carrier-b.js';
import { CARRIER_C_POLICIES, type PortalPolicy } from '../mock-carriers/data/carrier-c.js';
import type { PersonaKey } from '../mock-carriers/data/personas.js';

type CarrierId = 'carrier-a' | 'carrier-b' | 'carrier-c';

interface SeedFailure {
  category: string;
  code: string;
  message: string;
  retryable: boolean;
  attempts: number;
}

interface SeedPull {
  id: string;
  persona: PersonaKey;
  createdAt: string;
  outcomes: Record<CarrierId, 'success' | SeedFailure>;
}

const SEED_PULLS: SeedPull[] = [
  {
    id: '5eed0000-0000-4000-8000-000000000001',
    persona: 'alex',
    createdAt: '2026-10-20T15:04:05.000Z',
    outcomes: { 'carrier-a': 'success', 'carrier-b': 'success', 'carrier-c': 'success' },
  },
  {
    id: '5eed0000-0000-4000-8000-000000000002',
    persona: 'jordan',
    createdAt: '2026-10-21T09:30:00.000Z',
    outcomes: {
      'carrier-a': 'success',
      'carrier-b': 'success',
      'carrier-c': {
        category: 'timeout',
        code: 'navigation_timeout',
        message: 'Portal page or element did not load within the navigation timeout',
        retryable: true,
        attempts: 3,
      },
    },
  },
  {
    id: '5eed0000-0000-4000-8000-000000000003',
    persona: 'sam',
    createdAt: '2026-10-22T18:45:00.000Z',
    outcomes: {
      'carrier-a': 'success',
      'carrier-b': 'success',
      'carrier-c': { category: 'authentication', code: 'invalid_credentials', message: 'Portal rejected the supplied credentials', retryable: false, attempts: 1 },
    },
  },
  {
    id: '5eed0000-0000-4000-8000-000000000004',
    persona: 'jordan',
    createdAt: '2026-10-19T11:00:00.000Z',
    outcomes: {
      'carrier-a': { category: 'rate_limited', code: 'http_429', message: 'Carrier rate limited list_policies', retryable: true, attempts: 3 },
      'carrier-b': { category: 'carrier_unavailable', code: 'http_503', message: 'Carrier returned HTTP 503 for get_policy_list', retryable: true, attempts: 3 },
      'carrier-c': { category: 'authentication', code: 'invalid_credentials', message: 'Portal rejected the supplied credentials', retryable: false, attempts: 1 },
    },
  },
];

/** Mirrors how the Carrier C portal renders a policy (see mock-carriers/carrier-c/views.ts). */
function asScraped(p: PortalPolicy): RawPortalPolicy {
  return {
    summary: {
      'Policy Number': p.policyNumber,
      Product: p.product,
      Status: p.status,
      'Policy Period': `${p.periodStart} – ${p.periodEnd}`,
      Premium: p.premium ?? 'Not available',
      'Named Insured': p.namedInsured,
    },
    coverages: p.coverages,
    vehicles: p.vehicles?.map((v) => ({ description: `${v.year} ${v.make} ${v.model}`, vin: `VIN: ${v.vin}` })) ?? null,
    drivers: p.drivers ?? null,
  };
}

function normalizeAll(carrierId: CarrierId, persona: PersonaKey, retrievedAt: string) {
  const meta = (integrationType: PolicyMeta['integrationType']): PolicyMeta => ({ carrierId, integrationType, adapterVersion: '1.0.0', retrievedAt });
  const policies: NormalizedPolicy[] = [];
  const warnings: Array<{ code: string; message: string; externalPolicyId: string | null }> = [];
  const attempt = (fn: () => NormalizedPolicy) => {
    try {
      policies.push(NormalizedPolicySchema.parse(fn()));
    } catch (error) {
      if (!(error instanceof RecordRejectedError)) throw error;
      warnings.push({ code: error.code, message: error.message, externalPolicyId: null });
    }
  };
  if (carrierId === 'carrier-a') for (const r of CARRIER_A_POLICIES[persona]) attempt(() => normalizeCarrierAPolicy(PolicyDetailSchema.parse(r), meta('rest_api')));
  if (carrierId === 'carrier-b') for (const r of CARRIER_B_POLICIES[persona]) attempt(() => normalizeCarrierBPolicy(r, meta('legacy_api')));
  if (carrierId === 'carrier-c') for (const r of CARRIER_C_POLICIES[persona]) attempt(() => normalizeCarrierCPolicy(asScraped(r), meta('browser')));
  return { policies, warnings };
}

const addSeconds = (iso: string, s: number) => new Date(Date.parse(iso) + s * 1000);

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await prisma.pull.deleteMany({ where: { id: { in: SEED_PULLS.map((p) => p.id) } } });

    for (const [pullIndex, seed] of SEED_PULLS.entries()) {
      const createdAt = new Date(seed.createdAt);
      const outcomes = Object.entries(seed.outcomes) as Array<[CarrierId, SeedPull['outcomes'][CarrierId]]>;
      const successes = outcomes.filter(([, o]) => o === 'success').length;
      const status = successes === outcomes.length ? 'succeeded' : successes === 0 ? 'failed' : 'partially_succeeded';

      await prisma.pull.create({
        data: {
          id: seed.id,
          status,
          idempotencyKey: `seed-${seed.id.slice(-4)}`,
          requestFingerprint: '0'.repeat(64),
          correlationId: `seed-${seed.persona}`,
          createdAt,
          startedAt: addSeconds(seed.createdAt, 1),
          completedAt: addSeconds(seed.createdAt, 9),
        },
      });

      for (const [index, [carrierId, outcome]] of outcomes.entries()) {
        const taskId = `5eed0000-0000-4000-8001-${String((pullIndex + 1) * 10 + index).padStart(12, '0')}`;
        const completedAt = addSeconds(seed.createdAt, 3 + index * 2);
        if (outcome === 'success') {
          const { policies, warnings } = normalizeAll(carrierId, seed.persona, completedAt.toISOString());
          await prisma.pullTask.create({
            data: { id: taskId, pullId: seed.id, carrierId, status: 'succeeded', attempts: 1, maxAttempts: 3, policyCount: policies.length, warnings, startedAt: addSeconds(seed.createdAt, 1), completedAt, createdAt },
          });
          await prisma.policy.createMany({
            data: policies.map((p) => ({
              pullId: seed.id,
              taskId,
              carrierId,
              externalPolicyId: p.externalPolicyId,
              schemaVersion: p.schemaVersion,
              policyType: p.policyType,
              status: p.status,
              effectiveDate: p.effectiveDate ? new Date(`${p.effectiveDate}T00:00:00Z`) : null,
              expirationDate: p.expirationDate ? new Date(`${p.expirationDate}T00:00:00Z`) : null,
              retrievedAt: new Date(p.retrievedAt),
              document: p,
              createdAt: completedAt,
            })),
          });
        } else {
          const history = Array.from({ length: outcome.attempts }, (_, i) => ({
            attempt: i + 1,
            category: outcome.category,
            code: outcome.code,
            message: outcome.message,
            retryable: outcome.retryable,
            at: addSeconds(seed.createdAt, 2 + i * 2).toISOString(),
          }));
          await prisma.pullTask.create({
            data: {
              id: taskId,
              pullId: seed.id,
              carrierId,
              status: 'failed',
              attempts: outcome.attempts,
              maxAttempts: 3,
              errorCategory: outcome.category,
              errorCode: outcome.code,
              errorMessage: outcome.message,
              errorRetryable: outcome.retryable,
              attemptHistory: history,
              startedAt: addSeconds(seed.createdAt, 1),
              completedAt,
              createdAt,
            },
          });
        }
      }
    }

    const [pulls, policies] = await Promise.all([prisma.pull.count(), prisma.policy.count()]);
    console.log(JSON.stringify({ msg: 'seed complete', seededPulls: SEED_PULLS.map((p) => p.id), totals: { pulls, policies } }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
