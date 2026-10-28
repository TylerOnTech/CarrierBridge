import { TaskAbortError } from '../carriers/shared/abort.js';
import type { CarrierRegistry } from '../carriers/registry.js';
import type { Logger } from '../logging/logger.js';
import { sleep } from '../lib/sleep.js';
import type { ClaimedTask, TaskQueue } from '../persistence/task-queue.js';
import type { TaskRunner } from './task-runner.js';

export interface WorkerOptions {
  /** Max tasks in flight across all carriers in this process. */
  concurrency: number;
  pollIntervalMs: number;
  leaseMs: number;
  /** How often to sweep for tasks abandoned by crashed workers. */
  recoveryIntervalMs?: number;
}

interface InFlight {
  carrierId: string;
  controller: AbortController;
  promise: Promise<void>;
}

/**
 * Polls the task queue and runs tasks with two levels of bounded concurrency: a global cap
 * (protects this process: memory, sockets, browser contexts) and a per-carrier cap from the
 * registry (protects each carrier from us, e.g. one browser session at a time per portal).
 * Carriers are visited round-robin so a backlog for one carrier cannot starve the others.
 */
export class PullWorker {
  private running = false;
  private timer: NodeJS.Timeout | undefined;
  private currentTick: Promise<void> | undefined;
  private wakeRequested = false;
  private rotation = 0;
  private lastRecovery = 0;
  private readonly inFlight = new Map<string, InFlight>();

  constructor(
    private readonly deps: {
      queue: TaskQueue;
      registry: CarrierRegistry;
      runner: TaskRunner;
      logger: Logger;
      options: WorkerOptions;
    },
  ) {}

  get activeTasks(): number {
    return this.inFlight.size;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.deps.logger.info({ concurrency: this.deps.options.concurrency }, 'worker started');
    this.schedule(0);
  }

  /** Called when new work is enqueued in-process, to skip the poll delay. */
  wake(): void {
    if (!this.running) return;
    if (this.currentTick) this.wakeRequested = true;
    else this.schedule(0);
  }

  private schedule(delayMs: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.currentTick = this.tick().finally(() => {
        this.currentTick = undefined;
        if (!this.running) return;
        this.schedule(this.wakeRequested ? 0 : this.deps.options.pollIntervalMs);
        this.wakeRequested = false;
      });
    }, delayMs);
  }

  private async tick(): Promise<void> {
    const { queue, registry, logger, options } = this.deps;
    try {
      const recoveryInterval = options.recoveryIntervalMs ?? Math.max(1_000, Math.floor(options.leaseMs / 2));
      if (Date.now() - this.lastRecovery >= recoveryInterval) {
        this.lastRecovery = Date.now();
        const pullIds = await queue.recoverExpiredLeases();
        if (pullIds.length > 0) logger.warn({ pullIds }, 'recovered tasks with expired leases');
        for (const pullId of pullIds) await queue.finalizePull(pullId);
      }

      const carriers = registry.list();
      const offset = this.rotation++ % Math.max(1, carriers.length);
      const ordered = [...carriers.slice(offset), ...carriers.slice(0, offset)];
      for (const carrier of ordered) {
        const globalFree = options.concurrency - this.inFlight.size;
        if (globalFree <= 0 || !this.running) break;
        const carrierFree = carrier.concurrency - this.countInFlight(carrier.descriptor.id);
        const limit = Math.min(globalFree, carrierFree);
        if (limit <= 0) continue;
        for (const task of await queue.claim(carrier.descriptor.id, limit, options.leaseMs)) {
          if (this.running) this.launch(task);
          else await queue.release(task); // shutdown began while we were claiming
        }
      }
    } catch (error) {
      logger.error({ err: error }, 'worker tick failed');
    }
  }

  private countInFlight(carrierId: string): number {
    let count = 0;
    for (const task of this.inFlight.values()) if (task.carrierId === carrierId) count++;
    return count;
  }

  private launch(task: ClaimedTask): void {
    const controller = new AbortController();
    const promise = this.deps.runner
      .run(task, controller)
      .catch((error: unknown) => this.deps.logger.error({ err: error, taskId: task.id }, 'task runner crashed'))
      .finally(() => {
        this.inFlight.delete(task.id);
        this.wake();
      });
    this.inFlight.set(task.id, { carrierId: task.carrierId, controller, promise });
  }

  /**
   * Graceful stop: claim nothing new, give in-flight tasks `timeoutMs` to finish, then abort
   * them. Aborted tasks are released back to the queue (attempt not consumed) so another
   * worker, or this one after restart, picks them up.
   */
  async stop(timeoutMs: number): Promise<void> {
    if (!this.running) return;
    this.running = false;
    clearTimeout(this.timer);
    await this.currentTick;

    const pending = () => Promise.allSettled([...this.inFlight.values()].map((t) => t.promise));
    if (this.inFlight.size > 0) {
      this.deps.logger.info({ inFlight: this.inFlight.size, timeoutMs }, 'waiting for in-flight tasks');
      const drained = await Promise.race([pending().then(() => true), sleep(timeoutMs).then(() => false)]);
      if (!drained) {
        this.deps.logger.warn({ inFlight: this.inFlight.size }, 'shutdown timeout reached; aborting in-flight tasks');
        for (const task of this.inFlight.values()) task.controller.abort(new TaskAbortError('shutdown'));
        await pending();
      }
    }
    this.deps.logger.info('worker stopped');
  }
}
