import { Router } from 'express';
import { ApiError } from '../../domain/errors.js';
import type { PullService } from '../../services/pull-service.js';
import { requestIdOf } from '../middleware/request-id.js';
import { parseOrThrow } from '../problem.js';
import { presentPolicy, presentPull } from '../presenters.js';
import { CreatePullRequestSchema, IdempotencyKeySchema, IdParamSchema, ListPoliciesQuerySchema } from '../schemas.js';

export function pullsRouter(service: PullService): Router {
  const router = Router();

  router.post('/pulls', async (req, res) => {
    if (!req.is('application/json')) {
      throw new ApiError(415, 'unsupported_media_type', 'Content-Type must be application/json');
    }
    const rawKey = req.header('idempotency-key');
    const idempotencyKey = rawKey === undefined ? undefined : parseIdempotencyKey(rawKey);
    const body = parseOrThrow(CreatePullRequestSchema, req.body, 'body');

    const { pull, replayed } = await service.createPull(body, idempotencyKey, requestIdOf(req));
    req.log.info({ pullId: pull.id, replayed, carriers: pull.tasks.map((t) => t.carrierId) }, replayed ? 'pull replayed' : 'pull created');
    // 202: accepted for asynchronous processing. A replay returns 200 with the original pull.
    res
      .status(replayed ? 200 : 202)
      .location(`/pulls/${pull.id}`)
      .setHeader('Idempotent-Replayed', String(replayed))
      .json(presentPull(pull));
  });

  router.get('/pulls/:id', async (req, res) => {
    const { id } = parseOrThrow(IdParamSchema, req.params, 'params');
    res.json(presentPull(await service.getPull(id)));
  });

  router.get('/pulls/:id/policies', async (req, res) => {
    const { id } = parseOrThrow(IdParamSchema, req.params, 'params');
    const query = parseOrThrow(ListPoliciesQuerySchema, req.query, 'query');
    const { policies, nextCursor } = await service.listPolicies(id, query);
    res.json({ data: policies.map(presentPolicy), pagination: { limit: query.limit, nextCursor } });
  });

  return router;
}

function parseIdempotencyKey(raw: string): string {
  const result = IdempotencyKeySchema.safeParse(raw);
  if (!result.success) {
    throw ApiError.badRequest('validation_error', 'Idempotency-Key header is invalid', [
      { path: 'headers.idempotency-key', message: result.error.issues[0]?.message ?? 'invalid' },
    ]);
  }
  return result.data;
}
