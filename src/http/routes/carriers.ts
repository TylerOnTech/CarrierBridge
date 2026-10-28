import { Router } from 'express';
import type { CarrierRegistry } from '../../carriers/registry.js';

export function carriersRouter(registry: CarrierRegistry): Router {
  const router = Router();
  router.get('/carriers', (_req, res) => {
    res.json({
      data: registry.list().map(({ descriptor, concurrency }) => ({
        id: descriptor.id,
        displayName: descriptor.displayName,
        integrationType: descriptor.integrationType,
        adapterVersion: descriptor.adapterVersion,
        description: descriptor.description,
        maxConcurrentRetrievals: concurrency,
        credentialFields: descriptor.credentialFields,
      })),
    });
  });
  return router;
}
