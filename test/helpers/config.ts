import { type AppConfig, loadConfig } from '../../src/config/env.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/carrierbridge_test';

/** Fixed, obviously-fake key so ciphertexts are reproducible across runs. */
export const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

/** Fast timings so retry/backoff paths run in milliseconds instead of seconds. */
export function testConfig(env: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    CREDENTIALS_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    LOG_LEVEL: 'silent',
    WORKER_POLL_INTERVAL_MS: '20',
    WORKER_CONCURRENCY: '4',
    TASK_LEASE_MS: '3000',
    TASK_TIMEOUT_MS: '20000',
    TASK_MAX_ATTEMPTS: '3',
    TASK_RETRY_BASE_DELAY_MS: '10',
    CARRIER_HTTP_TIMEOUT_MS: '3000',
    CARRIER_HTTP_MAX_RETRIES: '2',
    CARRIER_HTTP_RETRY_BASE_DELAY_MS: '1',
    CARRIER_HTTP_RETRY_MAX_DELAY_MS: '5',
    CARRIER_HTTP_MAX_RETRY_AFTER_MS: '2000',
    BROWSER_NAVIGATION_TIMEOUT_MS: '5000',
    ...env,
  });
}

export const TEST_HTTP: AppConfig['carrierHttp'] = {
  timeoutMs: 3000,
  maxRetries: 2,
  retryBaseDelayMs: 1,
  retryMaxDelayMs: 5,
  maxRetryAfterMs: 2000,
};
