import { abortToCarrierError, TaskAbortError } from '../carriers/shared/abort.js';
import type { CarrierRegistry } from '../carriers/registry.js';
import type { RetrievalWarning } from '../carriers/types.js';
import { type NormalizedPolicy, NormalizedPolicySchema } from '../contracts/index.js';
import { CarrierError, isCarrierError } from '../domain/errors.js';
import type { Logger } from '../logging/logger.js';
import type { ClaimedTask, TaskQueue } from '../persistence/task-queue.js';
import type { CredentialCipher } from '../security/credential-cipher.js';

export interface TaskRunnerOptions {
  leaseMs: number;
  taskTimeoutMs: number;
  retryBaseDelayMs: number;
  /** Upper bound on durable retry backoff. */
  retryMaxDelayMs?: number;
}

export interface TaskRunnerDeps {
  queue: TaskQueue;
  registry: CarrierRegistry;
  cipher: CredentialCipher;
  logger: Logger;
  options: TaskRunnerOptions;
}

/**
 * Executes one claimed task end to end: decrypt credentials, call the adapter under a
 * deadline, enforce the output contract, persist, and decide retry vs. fail.
 */
export class TaskRunner {
  constructor(private readonly deps: TaskRunnerDeps) {}

  async run(task: ClaimedTask, controller: AbortController): Promise<void> {
    const { queue, options } = this.deps;
    const log = this.deps.logger.child({
      pullId: task.pullId,
      taskId: task.id,
      carrierId: task.carrierId,
      attempt: task.attempts,
      correlationId: task.correlationId,
    });
    const startedAt = performance.now();
    const deadline = setTimeout(() => controller.abort(new TaskAbortError('task_timeout')), options.taskTimeoutMs);
    const heartbeat = setInterval(() => {
      queue
        .heartbeat(task, options.leaseMs)
        .then((held) => {
          if (!held) controller.abort(new TaskAbortError('lease_lost'));
        })
        .catch((error: unknown) => log.warn({ err: error }, 'lease heartbeat failed'));
    }, Math.max(50, Math.floor(options.leaseMs / 3)));

    try {
      log.info('task started');
      const { policies, warnings, stats } = await this.retrieve(task, controller, log);
      const held = await queue.complete(task, policies, warnings);
      const durationMs = Math.round(performance.now() - startedAt);
      if (held) {
        log.info({ policyCount: policies.length, warningCount: warnings.length, durationMs, stats }, 'task succeeded');
      } else {
        log.warn({ durationMs }, 'lease lost before completion; result discarded');
      }
    } catch (error) {
      await this.handleFailure(task, this.classify(error, task, controller.signal), log, startedAt);
    } finally {
      clearTimeout(deadline);
      clearInterval(heartbeat);
    }

    const status = await queue.finalizePull(task.pullId);
    if (status && status !== 'running' && status !== 'pending') log.info({ pullStatus: status }, 'pull finished');
  }

  private async retrieve(task: ClaimedTask, controller: AbortController, log: Logger) {
    const carrier = this.deps.registry.get(task.carrierId);
    if (!carrier) {
      throw new CarrierError({ carrierId: task.carrierId, category: 'internal', code: 'unknown_carrier', message: 'No adapter is registered for this carrier' });
    }
    if (!task.encryptedCredentials) {
      throw new CarrierError({ carrierId: task.carrierId, category: 'internal', code: 'credentials_unavailable', message: 'Credentials were purged before the task ran' });
    }
    const credentials: unknown = JSON.parse(this.deps.cipher.open(task.encryptedCredentials, task.id));
    const result = await carrier.retrieve(credentials, {
      logger: log,
      signal: controller.signal,
      correlationId: task.correlationId,
      now: () => new Date(),
    });
    // An adapter that ignored the signal must still not report success after a deadline.
    if (controller.signal.aborted) throw abortToCarrierError(task.carrierId, controller.signal);
    return { ...this.enforceContract(result.policies, result.warnings, log), stats: result.stats };
  }

  /**
   * The contract is enforced at the boundary even though adapters build typed objects:
   * a strict-schema failure here means an adapter bug, and it must never reach consumers.
   */
  private enforceContract(policies: NormalizedPolicy[], adapterWarnings: RetrievalWarning[], log: Logger) {
    const warnings = [...adapterWarnings];
    const accepted = new Map<string, NormalizedPolicy>();
    for (const policy of policies) {
      const parsed = NormalizedPolicySchema.safeParse(policy);
      if (!parsed.success) {
        log.error({ externalPolicyId: policy.externalPolicyId, issues: parsed.error.issues.map((i) => i.path.join('.')) }, 'adapter produced a contract-invalid policy');
        warnings.push({ code: 'contract_violation', message: 'Policy failed contract validation and was dropped', externalPolicyId: policy.externalPolicyId });
        continue;
      }
      if (accepted.has(parsed.data.externalPolicyId)) {
        warnings.push({ code: 'duplicate_record', message: 'Duplicate policy dropped', externalPolicyId: parsed.data.externalPolicyId });
        continue;
      }
      accepted.set(parsed.data.externalPolicyId, parsed.data);
    }
    return { policies: [...accepted.values()], warnings };
  }

  private classify(error: unknown, task: ClaimedTask, signal: AbortSignal): CarrierError {
    if (isCarrierError(error)) return error;
    if (signal.aborted) return abortToCarrierError(task.carrierId, signal);
    return new CarrierError({
      carrierId: task.carrierId,
      category: 'internal',
      code: 'unexpected_error',
      message: 'Unexpected internal error while retrieving policies',
      cause: error,
    });
  }

  private async handleFailure(task: ClaimedTask, error: CarrierError, log: Logger, startedAt: number): Promise<void> {
    const { queue, options } = this.deps;
    const durationMs = Math.round(performance.now() - startedAt);
    const errorFields = { category: error.category, code: error.code, retryable: error.retryable, durationMs };

    if (error.category === 'cancelled') {
      if (error.code === 'lease_lost') {
        log.warn(errorFields, 'lease lost; another worker owns this task now');
        return;
      }
      const released = await queue.release(task);
      log.warn(errorFields, released ? 'task interrupted; returned to queue' : 'task interrupted; lease already gone');
      return;
    }

    if (error.retryable && task.attempts < task.maxAttempts) {
      const backoff = options.retryBaseDelayMs * 2 ** (task.attempts - 1);
      const delayMs = Math.min(Math.max(error.retryAfterMs ?? 0, backoff), options.retryMaxDelayMs ?? 5 * 60_000);
      await queue.reschedule(task, error, delayMs);
      log.warn({ ...errorFields, delayMs, maxAttempts: task.maxAttempts }, 'task failed; retry scheduled');
      return;
    }

    await queue.fail(task, error);
    const level = error.category === 'internal' ? 'error' : 'warn';
    log[level]({ ...errorFields, err: error.category === 'internal' ? error.cause : undefined }, 'task failed permanently');
  }
}
