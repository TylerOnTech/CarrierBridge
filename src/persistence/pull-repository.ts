import type { Policy, Pull, PullTask } from '@prisma/client';
import type { PrismaClient } from './prisma.js';

export type PullWithTasks = Pull & { tasks: PullTask[] };

export interface NewTask {
  id: string;
  carrierId: string;
  encryptedCredentials: string;
  maxAttempts: number;
}

export class PullRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** Pull and all its tasks are created atomically: a pull never exists without its work items. */
  createPullWithTasks(input: {
    idempotencyKey: string | null;
    requestFingerprint: string;
    correlationId: string;
    tasks: NewTask[];
  }): Promise<PullWithTasks> {
    return this.prisma.pull.create({
      data: {
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: input.requestFingerprint,
        correlationId: input.correlationId,
        tasks: { create: input.tasks },
      },
      include: { tasks: { orderBy: { carrierId: 'asc' } } },
    });
  }

  findById(id: string): Promise<PullWithTasks | null> {
    return this.prisma.pull.findUnique({ where: { id }, include: { tasks: { orderBy: { carrierId: 'asc' } } } });
  }

  findByIdempotencyKey(key: string): Promise<PullWithTasks | null> {
    return this.prisma.pull.findUnique({
      where: { idempotencyKey: key },
      include: { tasks: { orderBy: { carrierId: 'asc' } } },
    });
  }

  /** Keyset pagination in a stable order (carrier, external id, id). */
  listPolicies(pullId: string, opts: { carrierId?: string; limit: number; cursor?: string }): Promise<Policy[]> {
    return this.prisma.policy.findMany({
      where: { pullId, ...(opts.carrierId ? { carrierId: opts.carrierId } : {}) },
      orderBy: [{ carrierId: 'asc' }, { externalPolicyId: 'asc' }, { id: 'asc' }],
      take: opts.limit,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
  }

  findPolicy(id: string): Promise<Policy | null> {
    return this.prisma.policy.findUnique({ where: { id } });
  }

  async policyExistsInPull(pullId: string, policyId: string): Promise<boolean> {
    return (await this.prisma.policy.count({ where: { id: policyId, pullId } })) > 0;
  }
}
