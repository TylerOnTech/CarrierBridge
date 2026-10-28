import { Router } from 'express';
import type { PrismaClient } from '../../persistence/prisma.js';
import type { z } from 'zod';
import type { HealthSchema } from '../schemas.js';
import { APP_VERSION } from '../../version.js';


export function healthRouter(deps: { prisma: PrismaClient; isShuttingDown: () => boolean }): Router {
  const router = Router();
  router.get('/health', async (_req, res) => {
    let database: 'ok' | 'error' = 'ok';
    try {
      await deps.prisma.$queryRaw`SELECT 1`;
    } catch {
      database = 'error';
    }
    const status = deps.isShuttingDown() ? 'shutting_down' : database === 'ok' ? 'ok' : 'degraded';
    const body: z.infer<typeof HealthSchema> = {
      status,
      version: APP_VERSION,
      uptimeSeconds: Math.round(process.uptime()),
      checks: { database },
    };
    // Non-200 while draining lets a load balancer stop routing before connections close.
    res.status(status === 'ok' ? 200 : 503).json(body);
  });
  return router;
}
