import { createDefaultRegistry, type CarrierRegistry } from './carriers/registry.js';
import { BrowserManager } from './carriers/shared/browser-manager.js';
import type { AppConfig } from './config/env.js';
import { createApp } from './http/app.js';
import { createLogger, type Logger } from './logging/logger.js';
import { createPrismaClient } from './persistence/prisma.js';
import { PullRepository } from './persistence/pull-repository.js';
import { TaskQueue } from './persistence/task-queue.js';
import { CredentialCipher } from './security/credential-cipher.js';
import { RequestFingerprinter } from './security/fingerprint.js';
import { PullService } from './services/pull-service.js';
import { TaskRunner } from './worker/task-runner.js';
import { PullWorker } from './worker/worker.js';

export interface RuntimeOverrides {
  logger?: Logger;
  /** Tests inject fake adapters to exercise the engine deterministically. */
  registry?: (browser: BrowserManager) => CarrierRegistry;
}

/** Composition root: the only place that knows how the pieces are wired together. */
export function createRuntime(config: AppConfig, overrides: RuntimeOverrides = {}) {
  const logger = overrides.logger ?? createLogger(config.log);
  const prisma = createPrismaClient(config.databaseUrl);
  const browser = new BrowserManager({
    headless: config.browser.headless,
    executablePath: config.browser.executablePath,
    logger: logger.child({ component: 'browser' }),
  });
  const registry = overrides.registry ? overrides.registry(browser) : createDefaultRegistry(config, browser);
  const cipher = new CredentialCipher(config.credentialsKey);
  const queue = new TaskQueue(prisma);

  const runner = new TaskRunner({
    queue,
    registry,
    cipher,
    logger: logger.child({ component: 'task' }),
    options: {
      leaseMs: config.worker.leaseMs,
      taskTimeoutMs: config.worker.taskTimeoutMs,
      retryBaseDelayMs: config.worker.retryBaseDelayMs,
    },
  });
  const worker = new PullWorker({
    queue,
    registry,
    runner,
    logger: logger.child({ component: 'worker' }),
    options: {
      concurrency: config.worker.concurrency,
      pollIntervalMs: config.worker.pollIntervalMs,
      leaseMs: config.worker.leaseMs,
    },
  });

  const pullService = new PullService({
    repo: new PullRepository(prisma),
    registry,
    cipher,
    fingerprinter: new RequestFingerprinter(config.credentialsKey),
    maxAttempts: config.worker.maxAttempts,
    onPullCreated: () => worker.wake(),
  });

  let shuttingDown = false;
  const app = createApp({ logger, prisma, registry, pullService, isShuttingDown: () => shuttingDown });

  return {
    config,
    logger,
    prisma,
    browser,
    registry,
    queue,
    worker,
    pullService,
    app,
    markShuttingDown: () => {
      shuttingDown = true;
    },
    /** Releases external resources. Call after the HTTP server and worker have stopped. */
    close: async () => {
      await browser.close();
      await prisma.$disconnect();
    },
  };
}

export type Runtime = ReturnType<typeof createRuntime>;
