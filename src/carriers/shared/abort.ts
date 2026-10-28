import { CarrierError } from '../../domain/errors.js';

export type AbortCause = 'task_timeout' | 'shutdown' | 'lease_lost';

/** Reason attached to a task's AbortSignal so adapters can tell a deadline from a shutdown. */
export class TaskAbortError extends Error {
  constructor(readonly abortCause: AbortCause) {
    super(`task aborted: ${abortCause}`);
    this.name = 'TaskAbortError';
  }
}

export function abortToCarrierError(carrierId: string, signal: AbortSignal): CarrierError {
  const reason: unknown = signal.reason;
  if (reason instanceof TaskAbortError && reason.abortCause === 'task_timeout') {
    return new CarrierError({
      carrierId,
      category: 'timeout',
      code: 'task_deadline_exceeded',
      message: 'Retrieval exceeded the task deadline',
    });
  }
  return new CarrierError({
    carrierId,
    category: 'cancelled',
    code: reason instanceof TaskAbortError ? reason.abortCause : 'aborted',
    message: 'Retrieval was cancelled before completion',
  });
}
