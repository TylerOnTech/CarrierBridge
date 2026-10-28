import { once } from 'node:events';
import type { Server } from 'node:http';
import { ConfigError, loadConfig } from './config/env.js';
import { createRuntime } from './runtime.js';

/**
 * Process entry point. PROCESS_ROLE selects api, worker, or both, so the same image can
 * run as a combined process locally or as separately scaled tiers in production.
 */
async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    process.stderr.write(`${error instanceof ConfigError ? error.message : String(error)}\n`);
    process.exit(1);
  }

  const runtime = createRuntime(config);
  const { logger } = runtime;
  let server: Server | undefined;

  if (config.role !== 'worker') {
    server = runtime.app.listen(config.http.port, config.http.host);
    await once(server, 'listening');
    server.keepAliveTimeout = 5_000;
    logger.info({ host: config.http.host, port: config.http.port, role: config.role }, 'http server listening');
  }
  if (config.role !== 'api') runtime.worker.start();

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'graceful shutdown started');
    runtime.markShuttingDown();
    // Hard stop if something hangs, so orchestrators are never left waiting forever.
    const force = setTimeout(() => {
      logger.error('graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, config.shutdownTimeoutMs + 5_000);
    force.unref();

    const httpClosed = server
      ? new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeIdleConnections();
          setTimeout(() => server.closeAllConnections(), config.shutdownTimeoutMs).unref();
        })
      : Promise.resolve();
    await Promise.all([httpClosed, runtime.worker.stop(config.shutdownTimeoutMs)]);
    await runtime.close();
    logger.info('graceful shutdown complete');
    logger.flush();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'unhandled promise rejection'));
}

void main();
