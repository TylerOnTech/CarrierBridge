import express, { type Router } from 'express';
import { type FaultInjector, FaultRuleSchema } from './faults.js';
import type { RequestLog } from './request-log.js';

/**
 * Test/demo control plane, mounted at /__control only when explicitly enabled.
 * Lets the demo script inject a carrier outage with curl while the engine is running.
 */
export function createControlRouter(params: {
  faults: FaultInjector;
  log: RequestLog;
  reset: () => void;
  actions?: Record<string, () => void>;
}): Router {
  const router = express.Router();
  router.use(express.json());
  router.post('/faults', (req, res) => {
    try {
      params.faults.add(FaultRuleSchema.parse(req.body as unknown));
      res.status(201).json({ pending: params.faults.pending() });
    } catch (error) {
      res.status(400).json({ error: 'invalid_fault', detail: String(error) });
    }
  });
  router.post('/reset', (_req, res) => {
    params.reset();
    res.status(204).end();
  });
  router.get('/requests', (_req, res) => {
    res.json({ requests: params.log.entries });
  });
  for (const [name, action] of Object.entries(params.actions ?? {})) {
    router.post(`/${name}`, (_req, res) => {
      action();
      res.status(204).end();
    });
  }
  return router;
}
