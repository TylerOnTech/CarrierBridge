import type { Policy, PullTask } from '@prisma/client';
import { type NormalizedPolicy, NormalizedPolicySchema } from '../contracts/index.js';
import type { PullWithTasks } from '../persistence/pull-repository.js';
import type { PolicyResource, PullResponse } from './schemas.js';

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

type Carrier = PullResponse['carriers'][number];

function presentTask(task: PullTask): Carrier {
  const error =
    task.errorCategory && task.errorCode
      ? {
          category: task.errorCategory as NonNullable<Carrier['error']>['category'],
          code: task.errorCode,
          message: task.errorMessage ?? '',
          retryable: task.errorRetryable ?? false,
        }
      : null;
  const retryScheduled = task.status === 'pending' && task.attempts > 0;
  return {
    carrierId: task.carrierId,
    status: task.status,
    attempts: task.attempts,
    maxAttempts: task.maxAttempts,
    policyCount: task.policyCount,
    startedAt: iso(task.startedAt),
    completedAt: iso(task.completedAt),
    nextAttemptAt: retryScheduled ? iso(task.availableAt) : null,
    error: task.status === 'succeeded' ? null : error,
    warnings: task.warnings as Carrier['warnings'],
    attemptHistory: task.attemptHistory as Carrier['attemptHistory'],
  };
}

/** Maps persistence rows to the public representation. Credentials and lease state never leave here. */
export function presentPull(pull: PullWithTasks): PullResponse {
  const carriers = pull.tasks.map(presentTask);
  return {
    id: pull.id,
    status: pull.status,
    idempotencyKey: pull.idempotencyKey,
    createdAt: pull.createdAt.toISOString(),
    startedAt: iso(pull.startedAt),
    completedAt: iso(pull.completedAt),
    summary: {
      carriersTotal: carriers.length,
      carriersSucceeded: carriers.filter((c) => c.status === 'succeeded').length,
      carriersFailed: carriers.filter((c) => c.status === 'failed').length,
      carriersInProgress: carriers.filter((c) => c.status === 'pending' || c.status === 'running').length,
      policiesRetrieved: carriers.reduce((sum, c) => sum + c.policyCount, 0),
    },
    carriers,
    links: { self: `/pulls/${pull.id}`, policies: `/pulls/${pull.id}/policies` },
  };
}

export function presentPolicy(policy: Policy): PolicyResource {
  // Re-parsing restores the contract's field order (JSONB stores keys sorted by length)
  // and guards against rows written by an older adapter that no longer match the contract.
  const parsed = NormalizedPolicySchema.safeParse(policy.document);
  return {
    id: policy.id,
    pullId: policy.pullId,
    createdAt: policy.createdAt.toISOString(),
    policy: parsed.success ? parsed.data : (policy.document as unknown as NormalizedPolicy),
  };
}
