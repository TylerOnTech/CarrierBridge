import { z } from 'zod';

const int = (fallback: number, min = 0) => z.coerce.number().int().min(min).default(fallback);
const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(fallback ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PROCESS_ROLE: z.enum(['all', 'api', 'worker']).default('all'),
  HOST: z.string().default('0.0.0.0'),
  PORT: int(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: bool(false),

  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// connection string'),
  CREDENTIALS_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 random bytes, base64-encoded'),

  WORKER_CONCURRENCY: int(4, 1),
  WORKER_POLL_INTERVAL_MS: int(500, 10),
  TASK_LEASE_MS: int(60_000, 500),
  TASK_TIMEOUT_MS: int(45_000, 100),
  TASK_MAX_ATTEMPTS: int(3, 1),
  TASK_RETRY_BASE_DELAY_MS: int(2_000, 0),

  CARRIER_HTTP_TIMEOUT_MS: int(10_000, 50),
  CARRIER_HTTP_MAX_RETRIES: int(3, 0),
  CARRIER_HTTP_RETRY_BASE_DELAY_MS: int(200, 0),
  CARRIER_HTTP_RETRY_MAX_DELAY_MS: int(5_000, 0),
  CARRIER_HTTP_MAX_RETRY_AFTER_MS: int(30_000, 0),

  BROWSER_HEADLESS: bool(true),
  BROWSER_NAVIGATION_TIMEOUT_MS: int(15_000, 100),
  BROWSER_EXECUTABLE_PATH: z.string().min(1).optional(),

  CARRIER_A_BASE_URL: z.url().default('http://localhost:4001'),
  CARRIER_B_BASE_URL: z.url().default('http://localhost:4002'),
  CARRIER_C_BASE_URL: z.url().default('http://localhost:4003'),
  CARRIER_A_CONCURRENCY: int(4, 1),
  CARRIER_B_CONCURRENCY: int(2, 1),
  CARRIER_C_CONCURRENCY: int(2, 1),

  SHUTDOWN_TIMEOUT_MS: int(15_000, 0),
});

export interface CarrierEndpointConfig {
  baseUrl: string;
  /** Max tasks for this carrier running concurrently in one worker process. */
  concurrency: number;
}

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  role: 'all' | 'api' | 'worker';
  http: { host: string; port: number };
  log: { level: string; pretty: boolean };
  databaseUrl: string;
  credentialsKey: Buffer;
  worker: {
    concurrency: number;
    pollIntervalMs: number;
    leaseMs: number;
    taskTimeoutMs: number;
    maxAttempts: number;
    retryBaseDelayMs: number;
  };
  carrierHttp: {
    timeoutMs: number;
    maxRetries: number;
    retryBaseDelayMs: number;
    retryMaxDelayMs: number;
    maxRetryAfterMs: number;
  };
  browser: { headless: boolean; navigationTimeoutMs: number; executablePath: string | undefined };
  carriers: Record<'carrier-a' | 'carrier-b' | 'carrier-c', CarrierEndpointConfig>;
  shutdownTimeoutMs: number;
}

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Parses and validates environment variables. Error messages name the offending
 * variable and rule but never echo its value, so secrets cannot leak into crash logs.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const e = parsed.data;
  return {
    env: e.NODE_ENV,
    role: e.PROCESS_ROLE,
    http: { host: e.HOST, port: e.PORT },
    log: { level: e.LOG_LEVEL, pretty: e.LOG_PRETTY },
    databaseUrl: e.DATABASE_URL,
    credentialsKey: Buffer.from(e.CREDENTIALS_ENCRYPTION_KEY, 'base64'),
    worker: {
      concurrency: e.WORKER_CONCURRENCY,
      pollIntervalMs: e.WORKER_POLL_INTERVAL_MS,
      leaseMs: e.TASK_LEASE_MS,
      taskTimeoutMs: e.TASK_TIMEOUT_MS,
      maxAttempts: e.TASK_MAX_ATTEMPTS,
      retryBaseDelayMs: e.TASK_RETRY_BASE_DELAY_MS,
    },
    carrierHttp: {
      timeoutMs: e.CARRIER_HTTP_TIMEOUT_MS,
      maxRetries: e.CARRIER_HTTP_MAX_RETRIES,
      retryBaseDelayMs: e.CARRIER_HTTP_RETRY_BASE_DELAY_MS,
      retryMaxDelayMs: e.CARRIER_HTTP_RETRY_MAX_DELAY_MS,
      maxRetryAfterMs: e.CARRIER_HTTP_MAX_RETRY_AFTER_MS,
    },
    browser: {
      headless: e.BROWSER_HEADLESS,
      navigationTimeoutMs: e.BROWSER_NAVIGATION_TIMEOUT_MS,
      executablePath: e.BROWSER_EXECUTABLE_PATH,
    },
    carriers: {
      'carrier-a': { baseUrl: e.CARRIER_A_BASE_URL, concurrency: e.CARRIER_A_CONCURRENCY },
      'carrier-b': { baseUrl: e.CARRIER_B_BASE_URL, concurrency: e.CARRIER_B_CONCURRENCY },
      'carrier-c': { baseUrl: e.CARRIER_C_BASE_URL, concurrency: e.CARRIER_C_CONCURRENCY },
    },
    shutdownTimeoutMs: e.SHUTDOWN_TIMEOUT_MS,
  };
}
