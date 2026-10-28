export type TaskStatus = 'pending' | 'running' | 'succeeded' | 'failed';
export type PullStatus = 'pending' | 'running' | 'succeeded' | 'partially_succeeded' | 'failed';

export const TERMINAL_PULL_STATUSES: readonly PullStatus[] = ['succeeded', 'partially_succeeded', 'failed'];

/**
 * A pull's status is a pure function of its carrier tasks:
 *   all pending                  -> pending
 *   any not yet terminal         -> running
 *   all terminal, all succeeded  -> succeeded
 *   all terminal, none succeeded -> failed
 *   otherwise                    -> partially_succeeded
 * One carrier failing never discards another carrier's successful results.
 */
export function derivePullStatus(tasks: readonly TaskStatus[]): PullStatus {
  if (tasks.length === 0) return 'failed';
  if (tasks.every((s) => s === 'pending')) return 'pending';
  if (tasks.some((s) => s === 'pending' || s === 'running')) return 'running';
  const succeeded = tasks.filter((s) => s === 'succeeded').length;
  if (succeeded === tasks.length) return 'succeeded';
  return succeeded === 0 ? 'failed' : 'partially_succeeded';
}

export function isTerminalPullStatus(status: PullStatus): boolean {
  return TERMINAL_PULL_STATUSES.includes(status);
}
