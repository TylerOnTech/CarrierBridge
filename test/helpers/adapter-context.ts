import type { RetrievalContext } from '../../src/carriers/types.js';
import { Secret } from '../../src/lib/secret.js';
import { createLogger, type Logger } from '../../src/logging/logger.js';

export const FIXED_NOW = new Date('2026-10-28T12:00:00.000Z');

export function adapterContext(overrides: Partial<RetrievalContext> & { logger?: Logger } = {}): RetrievalContext {
  return {
    logger: overrides.logger ?? createLogger({ level: 'silent', pretty: false }),
    signal: overrides.signal ?? new AbortController().signal,
    correlationId: overrides.correlationId ?? 'test-correlation-id',
    now: overrides.now ?? (() => FIXED_NOW),
  };
}

export const creds = (username: string, password: string) => ({ username, password: new Secret(password) });
