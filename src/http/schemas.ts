import { z } from 'zod';
import { ERROR_CATEGORIES } from '../domain/errors.js';
import { INTEGRATION_TYPES, NormalizedPolicySchema } from '../contracts/index.js';

/**
 * Request/response schemas for the public API. They validate input at runtime, are
 * the source for the OpenAPI document, and are used by tests to assert that real
 * responses match what the documentation promises.
 */
export const CreatePullRequestSchema = z
  .strictObject({
    connections: z
      .array(
        z.strictObject({
          carrierId: z.string().min(1).max(64),
          credentials: z
            .record(z.string(), z.unknown())
            .describe('Carrier-specific credentials. GET /carriers lists the fields each carrier expects.'),
        }),
      )
      .min(1)
      .max(10),
  })
  .meta({ id: 'CreatePullRequest' });

export const ProblemSchema = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    detail: z.string(),
    instance: z.string(),
    code: z.string(),
    requestId: z.string(),
    errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  })
  .meta({ id: 'Problem', description: 'RFC 9457 problem details' });

export const CarrierErrorSchema = z
  .object({
    category: z.enum(ERROR_CATEGORIES),
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
  })
  .meta({ id: 'CarrierError' });

export const RetrievalWarningSchema = z
  .object({ code: z.string(), message: z.string(), externalPolicyId: z.string().nullable().optional() })
  .meta({ id: 'RetrievalWarning' });

export const AttemptSchema = z
  .object({
    attempt: z.number().int(),
    category: z.string(),
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    at: z.string(),
  })
  .meta({ id: 'FailedAttempt' });

export const PullCarrierSchema = z
  .object({
    carrierId: z.string(),
    status: z.enum(['pending', 'running', 'succeeded', 'failed']),
    attempts: z.number().int(),
    maxAttempts: z.number().int(),
    policyCount: z.number().int(),
    startedAt: z.iso.datetime().nullable(),
    completedAt: z.iso.datetime().nullable(),
    nextAttemptAt: z.iso.datetime().nullable().describe('Set while a retry is scheduled'),
    error: CarrierErrorSchema.nullable().describe('Final error if failed, or the last attempt error while retrying'),
    warnings: z.array(RetrievalWarningSchema),
    attemptHistory: z.array(AttemptSchema),
  })
  .meta({ id: 'PullCarrier' });

export const PullSchema = z
  .object({
    id: z.uuid(),
    status: z.enum(['pending', 'running', 'succeeded', 'partially_succeeded', 'failed']),
    idempotencyKey: z.string().nullable(),
    createdAt: z.iso.datetime(),
    startedAt: z.iso.datetime().nullable(),
    completedAt: z.iso.datetime().nullable(),
    summary: z.object({
      carriersTotal: z.number().int(),
      carriersSucceeded: z.number().int(),
      carriersFailed: z.number().int(),
      carriersInProgress: z.number().int(),
      policiesRetrieved: z.number().int(),
    }),
    carriers: z.array(PullCarrierSchema),
    links: z.object({ self: z.string(), policies: z.string() }),
  })
  .meta({ id: 'Pull' });

export const PolicyResourceSchema = z
  .object({
    id: z.uuid(),
    pullId: z.uuid(),
    createdAt: z.iso.datetime(),
    policy: NormalizedPolicySchema,
  })
  .meta({ id: 'PolicyResource' });

export const PolicyListSchema = z
  .object({
    data: z.array(PolicyResourceSchema),
    pagination: z.object({ limit: z.number().int(), nextCursor: z.string().nullable() }),
  })
  .meta({ id: 'PolicyList' });

export const CarrierSchema = z
  .object({
    id: z.string(),
    displayName: z.string(),
    integrationType: z.enum(INTEGRATION_TYPES),
    adapterVersion: z.string(),
    description: z.string(),
    maxConcurrentRetrievals: z.number().int(),
    credentialFields: z.array(z.object({ name: z.string(), label: z.string(), secret: z.boolean() })),
  })
  .meta({ id: 'Carrier' });

export const CarrierListSchema = z.object({ data: z.array(CarrierSchema) }).meta({ id: 'CarrierList' });

export const HealthSchema = z
  .object({
    status: z.enum(['ok', 'degraded', 'shutting_down']),
    version: z.string(),
    uptimeSeconds: z.number(),
    checks: z.object({ database: z.enum(['ok', 'error']) }),
  })
  .meta({ id: 'Health' });

export const ListPoliciesQuerySchema = z.object({
  carrierId: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.uuid().optional(),
});

export const IdParamSchema = z.object({ id: z.uuid() });

export const IdempotencyKeySchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[\x21-\x7e]+$/, 'must be printable ASCII without spaces');

export type PullResponse = z.infer<typeof PullSchema>;
export type PolicyResource = z.infer<typeof PolicyResourceSchema>;
