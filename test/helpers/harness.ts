import supertest from 'supertest';
import type { Response } from 'supertest';
import type { CarrierRegistry } from '../../src/carriers/registry.js';
import type { BrowserManager } from '../../src/carriers/shared/browser-manager.js';
import type { Logger } from '../../src/logging/logger.js';
import type { PrismaClient } from '../../src/persistence/prisma.js';
import { createRuntime, type Runtime } from '../../src/runtime.js';
import { type MockCarrierOptions, type MockCarriers, startMockCarriers } from '../../mock-carriers/index.js';
import { testConfig } from './config.js';

export interface Harness {
  runtime: Runtime;
  mocks: MockCarriers;
  request: ReturnType<typeof supertest>;
  stop(): Promise<void>;
}

export interface HarnessOptions {
  env?: Record<string, string>;
  mocks?: MockCarrierOptions;
  logger?: Logger;
  registry?: (browser: BrowserManager) => CarrierRegistry;
  startWorker?: boolean;
}

/** Boots mocks + the full runtime (API, worker, Postgres) in-process on ephemeral ports. */
export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const mocks = await startMockCarriers(options.mocks);
  const config = testConfig({
    CARRIER_A_BASE_URL: mocks.urls['carrier-a'],
    CARRIER_B_BASE_URL: mocks.urls['carrier-b'],
    CARRIER_C_BASE_URL: mocks.urls['carrier-c'],
    ...options.env,
  });
  const runtime = createRuntime(config, { logger: options.logger, registry: options.registry });
  if (options.startWorker ?? true) runtime.worker.start();
  return {
    runtime,
    mocks,
    request: supertest(runtime.app),
    async stop() {
      await runtime.worker.stop(2_000);
      await runtime.close();
      await mocks.close();
    },
  };
}

export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE policies, pull_tasks, pulls RESTART IDENTITY CASCADE');
}

const TERMINAL = new Set(['succeeded', 'partially_succeeded', 'failed']);

/** Polls GET /pulls/:id until the pull reaches a terminal status. */
export async function waitForPull(request: Harness['request'], id: string, timeoutMs = 25_000): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await request.get(`/pulls/${id}`);
    if (TERMINAL.has((res.body as { status: string }).status)) return res;
    if (Date.now() > deadline) throw new Error(`pull ${id} did not finish; last status ${(res.body as { status: string }).status}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('condition not met before timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}
