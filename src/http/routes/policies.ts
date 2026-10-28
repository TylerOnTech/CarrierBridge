import { Router } from 'express';
import type { PullService } from '../../services/pull-service.js';
import { parseOrThrow } from '../problem.js';
import { presentPolicy } from '../presenters.js';
import { IdParamSchema } from '../schemas.js';

export function policiesRouter(service: PullService): Router {
  const router = Router();
  router.get('/policies/:id', async (req, res) => {
    const { id } = parseOrThrow(IdParamSchema, req.params, 'params');
    res.json(presentPolicy(await service.getPolicy(id)));
  });
  return router;
}
