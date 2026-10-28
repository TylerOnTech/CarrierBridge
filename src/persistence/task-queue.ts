import type { NormalizedPolicy } from '../contracts/index.js';
import type { CarrierError } from '../domain/errors.js';
import { derivePullStatus, isTerminalPullStatus, type PullStatus, type TaskStatus } from '../domain/pull-status.js';
import type { RetrievalWarning } from '../carriers/types.js';
import type { PrismaClient } from './prisma.js';

export interface ClaimedTask {
  id: string;
  pullId: string;
  carrierId: string;
  attempts: number;
  maxAttempts: number;
  leaseToken: string;
  encryptedCredentials: string | null;
  correlationId: string;
}

interface ClaimedRow {
  id: string;
  pull_id: string;
  carrier_id: string;
  attempts: number;
  max_attempts: number;
  lease_token: string;
  encrypted_credentials: string | null;
}

const historyEntry = (attempt: number, error: CarrierError) =>
  JSON.stringify([
    {
      attempt,
      category: error.category,
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      at: new Date().toISOString(),
    },
  ]);

/**
 * A durable work queue on Postgres. Workers claim tasks with
 * `FOR UPDATE SKIP LOCKED`, so any number of worker processes can poll the same table
 * without double-processing or blocking each other. Each claim issues a fresh lease token
 * (a fencing token): every state transition below requires the caller's token to still be
 * current, so a worker that stalled past its lease cannot clobber the attempt that replaced it.
 */
export class TaskQueue {
  constructor(private readonly prisma: PrismaClient) {}

  async claim(carrierId: string, limit: number, leaseMs: number): Promise<ClaimedTask[]> {
    if (limit <= 0) return [];
    const rows = await this.prisma.$queryRaw<ClaimedRow[]>`
      WITH candidates AS (
        SELECT id FROM pull_tasks
        WHERE status = 'pending' AND carrier_id = ${carrierId} AND available_at <= now()
        ORDER BY available_at, created_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE pull_tasks t
      SET status = 'running',
          attempts = t.attempts + 1,
          lease_token = gen_random_uuid(),
          lease_expires_at = now() + (${leaseMs}::int * interval '1 millisecond'),
          started_at = COALESCE(t.started_at, now()),
          updated_at = now()
      FROM candidates c
      WHERE t.id = c.id
      RETURNING t.id, t.pull_id, t.carrier_id, t.attempts, t.max_attempts, t.lease_token::text AS lease_token,
                t.encrypted_credentials`;
    if (rows.length === 0) return [];

    const pullIds = [...new Set(rows.map((r) => r.pull_id))];
    await this.prisma.$executeRaw`
      UPDATE pulls SET status = 'running', started_at = COALESCE(started_at, now()), updated_at = now()
      WHERE id = ANY(${pullIds}::uuid[]) AND status = 'pending'`;
    const pulls = await this.prisma.pull.findMany({ where: { id: { in: pullIds } }, select: { id: true, correlationId: true } });
    const correlation = new Map(pulls.map((p) => [p.id, p.correlationId]));

    return rows.map((r) => ({
      id: r.id,
      pullId: r.pull_id,
      carrierId: r.carrier_id,
      attempts: r.attempts,
      maxAttempts: r.max_attempts,
      leaseToken: r.lease_token,
      encryptedCredentials: r.encrypted_credentials,
      correlationId: correlation.get(r.pull_id) ?? 'unknown',
    }));
  }

  /** Extends the lease. Returns false if the lease was lost (expired and reclaimed). */
  async heartbeat(task: ClaimedTask, leaseMs: number): Promise<boolean> {
    const updated = await this.prisma.$executeRaw`
      UPDATE pull_tasks SET lease_expires_at = now() + (${leaseMs}::int * interval '1 millisecond'), updated_at = now()
      WHERE id = ${task.id}::uuid AND lease_token = ${task.leaseToken}::uuid AND status = 'running'`;
    return updated > 0;
  }

  /** Marks success and inserts policies in one transaction. Returns false if the lease was lost. */
  complete(task: ClaimedTask, policies: NormalizedPolicy[], warnings: RetrievalWarning[]): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.$executeRaw`
        UPDATE pull_tasks
        SET status = 'succeeded', completed_at = now(), policy_count = ${policies.length},
            warnings = ${JSON.stringify(warnings)}::jsonb,
            error_category = NULL, error_code = NULL, error_message = NULL, error_retryable = NULL,
            encrypted_credentials = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE id = ${task.id}::uuid AND lease_token = ${task.leaseToken}::uuid AND status = 'running'`;
      if (updated === 0) return false;
      if (policies.length > 0) {
        await tx.policy.createMany({
          data: policies.map((p) => ({
            pullId: task.pullId,
            taskId: task.id,
            carrierId: p.carrierId,
            externalPolicyId: p.externalPolicyId,
            schemaVersion: p.schemaVersion,
            policyType: p.policyType,
            status: p.status,
            effectiveDate: p.effectiveDate ? new Date(`${p.effectiveDate}T00:00:00Z`) : null,
            expirationDate: p.expirationDate ? new Date(`${p.expirationDate}T00:00:00Z`) : null,
            retrievedAt: new Date(p.retrievedAt),
            document: p,
          })),
        });
      }
      return true;
    });
  }

  /** Puts a failed attempt back in the queue after `delayMs` (durable retry with backoff). */
  async reschedule(task: ClaimedTask, error: CarrierError, delayMs: number): Promise<boolean> {
    const updated = await this.prisma.$executeRaw`
      UPDATE pull_tasks
      SET status = 'pending', available_at = now() + (${Math.round(delayMs)}::int * interval '1 millisecond'),
          error_category = ${error.category}, error_code = ${error.code}, error_message = ${error.message},
          error_retryable = ${error.retryable},
          attempt_history = attempt_history || ${historyEntry(task.attempts, error)}::jsonb,
          lease_token = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE id = ${task.id}::uuid AND lease_token = ${task.leaseToken}::uuid AND status = 'running'`;
    return updated > 0;
  }

  async fail(task: ClaimedTask, error: CarrierError): Promise<boolean> {
    const updated = await this.prisma.$executeRaw`
      UPDATE pull_tasks
      SET status = 'failed', completed_at = now(),
          error_category = ${error.category}, error_code = ${error.code}, error_message = ${error.message},
          error_retryable = ${error.retryable},
          attempt_history = attempt_history || ${historyEntry(task.attempts, error)}::jsonb,
          encrypted_credentials = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE id = ${task.id}::uuid AND lease_token = ${task.leaseToken}::uuid AND status = 'running'`;
    return updated > 0;
  }

  /** Returns an interrupted task (graceful shutdown) to the queue without consuming an attempt. */
  async release(task: ClaimedTask): Promise<boolean> {
    const updated = await this.prisma.$executeRaw`
      UPDATE pull_tasks
      SET status = 'pending', attempts = GREATEST(attempts - 1, 0), available_at = now(),
          lease_token = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE id = ${task.id}::uuid AND lease_token = ${task.leaseToken}::uuid AND status = 'running'`;
    return updated > 0;
  }

  /**
   * Recovers tasks whose worker died (lease expired without heartbeat): they are re-queued,
   * or failed if out of attempts. Returns the affected pull IDs so they can be finalized.
   */
  async recoverExpiredLeases(): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ pull_id: string }>>`
      WITH expired AS (
        SELECT id FROM pull_tasks
        WHERE status = 'running' AND lease_expires_at < now()
        FOR UPDATE SKIP LOCKED
      )
      UPDATE pull_tasks t
      SET status = CASE WHEN t.attempts >= t.max_attempts THEN 'failed'::"TaskStatus" ELSE 'pending'::"TaskStatus" END,
          completed_at = CASE WHEN t.attempts >= t.max_attempts THEN now() ELSE NULL END,
          encrypted_credentials = CASE WHEN t.attempts >= t.max_attempts THEN NULL ELSE t.encrypted_credentials END,
          error_category = 'internal', error_code = 'lease_expired',
          error_message = 'Worker stopped heartbeating before the task completed', error_retryable = true,
          attempt_history = t.attempt_history || jsonb_build_array(jsonb_build_object(
            'attempt', t.attempts, 'category', 'internal', 'code', 'lease_expired',
            'message', 'Worker stopped heartbeating before the task completed', 'retryable', true,
            'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))),
          lease_token = NULL, lease_expires_at = NULL, available_at = now(), updated_at = now()
      FROM expired e
      WHERE t.id = e.id
      RETURNING t.pull_id::text AS pull_id`;
    return [...new Set(rows.map((r) => r.pull_id))];
  }

  /**
   * Recomputes the pull's status from its tasks under a row lock, so concurrent task
   * completions for the same pull serialize instead of racing to write the final status.
   */
  finalizePull(pullId: string): Promise<PullStatus | null> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ status: PullStatus }>>`
        SELECT status FROM pulls WHERE id = ${pullId}::uuid FOR UPDATE`;
      const current = locked[0]?.status;
      if (!current || isTerminalPullStatus(current)) return current ?? null;
      const tasks = await tx.pullTask.findMany({ where: { pullId }, select: { status: true } });
      const next = derivePullStatus(tasks.map((t) => t.status as TaskStatus));
      if (next !== current) {
        await tx.pull.update({
          where: { id: pullId },
          data: { status: next, ...(isTerminalPullStatus(next) ? { completedAt: new Date() } : {}) },
        });
      }
      return next;
    });
  }
}
