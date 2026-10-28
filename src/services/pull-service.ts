import { randomUUID } from 'node:crypto';
import type { Policy } from '@prisma/client';
import type { CarrierRegistry } from '../carriers/registry.js';
import { ApiError } from '../domain/errors.js';
import { isUniqueViolation } from '../persistence/prisma.js';
import type { PullRepository, PullWithTasks } from '../persistence/pull-repository.js';
import type { CredentialCipher } from '../security/credential-cipher.js';
import type { RequestFingerprinter } from '../security/fingerprint.js';

export interface CreatePullInput {
  connections: Array<{ carrierId: string; credentials: Record<string, unknown> }>;
}

export interface PullServiceDeps {
  repo: PullRepository;
  registry: CarrierRegistry;
  cipher: CredentialCipher;
  fingerprinter: RequestFingerprinter;
  maxAttempts: number;
  /** Lets an in-process worker start immediately instead of waiting for its next poll. */
  onPullCreated?: () => void;
}

/** Business logic for pulls. Knows nothing about HTTP beyond throwing ApiError. */
export class PullService {
  constructor(private readonly deps: PullServiceDeps) {}

  /**
   * Creates a pull, or replays the existing one for a repeated Idempotency-Key.
   * The unique index on idempotency_key is the real guard: two concurrent requests with
   * the same key race to insert, one wins, and the loser re-reads and replays the winner.
   */
  async createPull(
    input: CreatePullInput,
    idempotencyKey: string | undefined,
    correlationId: string,
  ): Promise<{ pull: PullWithTasks; replayed: boolean }> {
    this.validateConnections(input);
    const fingerprint = this.deps.fingerprinter.fingerprint(input);

    if (idempotencyKey) {
      const existing = await this.deps.repo.findByIdempotencyKey(idempotencyKey);
      if (existing) return this.replay(existing, fingerprint);
    }

    const tasks = input.connections.map((connection) => {
      const id = randomUUID();
      return {
        id,
        carrierId: connection.carrierId,
        encryptedCredentials: this.deps.cipher.seal(JSON.stringify(connection.credentials), id),
        maxAttempts: this.deps.maxAttempts,
      };
    });

    try {
      const pull = await this.deps.repo.createPullWithTasks({
        idempotencyKey: idempotencyKey ?? null,
        requestFingerprint: fingerprint,
        correlationId,
        tasks,
      });
      this.deps.onPullCreated?.();
      return { pull, replayed: false };
    } catch (error) {
      if (idempotencyKey && isUniqueViolation(error)) {
        const winner = await this.deps.repo.findByIdempotencyKey(idempotencyKey);
        if (winner) return this.replay(winner, fingerprint);
      }
      throw error;
    }
  }

  private replay(existing: PullWithTasks, fingerprint: string) {
    if (existing.requestFingerprint !== fingerprint) {
      throw ApiError.unprocessable(
        'idempotency_key_reused',
        'This Idempotency-Key was already used with a different request body',
      );
    }
    return { pull: existing, replayed: true };
  }

  private validateConnections(input: CreatePullInput): void {
    const errors: Array<{ path: string; message: string }> = [];
    const seen = new Set<string>();
    input.connections.forEach((connection, i) => {
      const carrier = this.deps.registry.get(connection.carrierId);
      if (!carrier) {
        errors.push({ path: `connections.${i}.carrierId`, message: `Unknown carrier '${connection.carrierId}'. See GET /carriers.` });
        return;
      }
      if (seen.has(connection.carrierId)) {
        errors.push({ path: `connections.${i}.carrierId`, message: 'Each carrier may appear only once per pull' });
      }
      seen.add(connection.carrierId);
      for (const issue of carrier.validateCredentials(connection.credentials)) {
        errors.push({ path: `connections.${i}.credentials${issue.path ? `.${issue.path}` : ''}`, message: issue.message });
      }
    });
    if (errors.length > 0) throw ApiError.badRequest('validation_error', 'Request body failed validation', errors);
  }

  async getPull(id: string): Promise<PullWithTasks> {
    const pull = await this.deps.repo.findById(id);
    if (!pull) throw ApiError.notFound('Pull', id);
    return pull;
  }

  async listPolicies(
    pullId: string,
    query: { carrierId?: string; limit: number; cursor?: string },
  ): Promise<{ policies: Policy[]; nextCursor: string | null }> {
    await this.getPull(pullId);
    if (query.cursor && !(await this.deps.repo.policyExistsInPull(pullId, query.cursor))) {
      throw ApiError.badRequest('invalid_cursor', 'cursor does not refer to a policy in this pull');
    }
    // Fetch one extra row to learn whether another page exists without a COUNT query.
    const rows = await this.deps.repo.listPolicies(pullId, { ...query, limit: query.limit + 1 });
    const policies = rows.slice(0, query.limit);
    return { policies, nextCursor: rows.length > query.limit ? (policies.at(-1)?.id ?? null) : null };
  }

  async getPolicy(id: string): Promise<Policy> {
    const policy = await this.deps.repo.findPolicy(id);
    if (!policy) throw ApiError.notFound('Policy', id);
    return policy;
  }
}
