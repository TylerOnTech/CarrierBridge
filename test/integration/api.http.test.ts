import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CarrierListSchema, HealthSchema, ProblemSchema } from '../../src/http/schemas.js';
import { type Harness, resetDatabase, startHarness } from '../helpers/harness.js';

const valid = { connections: [{ carrierId: 'carrier-a', credentials: { username: 'u', password: 'p' } }] };

describe('HTTP contract: validation, errors, and operational endpoints', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness({ startWorker: false });
  });
  afterAll(async () => {
    await h.stop();
  });
  beforeEach(async () => {
    await resetDatabase(h.runtime.prisma);
  });

  const expectProblem = (res: { status: number; headers: Record<string, string>; body: unknown }, status: number, code: string) => {
    expect(res.status).toBe(status);
    expect(res.headers['content-type']).toContain('application/problem+json');
    const problem = ProblemSchema.parse(res.body);
    expect(problem).toMatchObject({ status, code, type: `urn:carrierbridge:problem:${code}` });
    expect(problem.requestId).toBe(res.headers['x-request-id']);
    return problem;
  };

  it('GET /health reports database status', async () => {
    const res = await h.request.get('/health');
    expect(res.status).toBe(200);
    expect(HealthSchema.parse(res.body)).toMatchObject({ status: 'ok', checks: { database: 'ok' } });
  });

  it('GET /health returns 503 while draining for shutdown', async () => {
    h.runtime.markShuttingDown();
    const res = await h.request.get('/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('shutting_down');
  });

  it('GET /carriers lists every registered adapter with its credential fields', async () => {
    const res = await h.request.get('/carriers');
    const body = CarrierListSchema.parse(res.body);
    expect(body.data.map((c) => [c.id, c.integrationType])).toEqual([
      ['carrier-a', 'rest_api'],
      ['carrier-b', 'legacy_api'],
      ['carrier-c', 'browser'],
    ]);
    expect(body.data[0]?.credentialFields).toContainEqual({ name: 'password', label: 'Password', secret: true });
  });

  it.each([
    ['missing connections', {}, 'body.connections'],
    ['empty connections', { connections: [] }, 'body.connections'],
    ['unknown top-level field', { ...valid, extra: true }, 'body'],
    ['credentials not an object', { connections: [{ carrierId: 'carrier-a', credentials: 'u:p' }] }, 'body.connections.0.credentials'],
  ])('POST /pulls rejects %s with field-level errors', async (_name, body, path) => {
    const problem = expectProblem(await h.request.post('/pulls').send(body), 400, 'validation_error');
    expect(problem.errors?.map((e) => e.path)).toContain(path);
  });

  it('POST /pulls validates carriers and per-carrier credentials', async () => {
    const res = await h.request.post('/pulls').send({
      connections: [
        { carrierId: 'carrier-z', credentials: {} },
        { carrierId: 'carrier-a', credentials: { username: 'u' } },
        { carrierId: 'carrier-a', credentials: { username: 'u', password: 'p' } },
      ],
    });
    const problem = expectProblem(res, 400, 'validation_error');
    expect(problem.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'connections.0.carrierId', message: expect.stringContaining('Unknown carrier') }),
        expect.objectContaining({ path: 'connections.1.credentials.password' }),
        expect.objectContaining({ path: 'connections.2.carrierId', message: expect.stringContaining('only once') }),
      ]),
    );
    expect(await h.runtime.prisma.pull.count()).toBe(0);
  });

  it('POST /pulls rejects malformed JSON, wrong media types, and bad idempotency keys', async () => {
    expectProblem(await h.request.post('/pulls').set('content-type', 'application/json').send('{"connections": ['), 400, 'malformed_json');
    expectProblem(await h.request.post('/pulls').set('content-type', 'text/plain').send('hello'), 415, 'unsupported_media_type');
    expectProblem(await h.request.post('/pulls').set('Idempotency-Key', 'has spaces').send(valid), 400, 'validation_error');
  });

  it('returns 400 for malformed ids and 404 for unknown resources', async () => {
    expectProblem(await h.request.get('/pulls/not-a-uuid'), 400, 'validation_error');
    expectProblem(await h.request.get('/pulls/00000000-0000-4000-8000-000000000000'), 404, 'not_found');
    expectProblem(await h.request.get('/pulls/00000000-0000-4000-8000-000000000000/policies'), 404, 'not_found');
    expectProblem(await h.request.get('/policies/00000000-0000-4000-8000-000000000000'), 404, 'not_found');
    expectProblem(await h.request.get('/nope'), 404, 'route_not_found');
  });

  it('validates pagination parameters', async () => {
    const created = await h.request.post('/pulls').send(valid);
    expectProblem(await h.request.get(`/pulls/${created.body.id}/policies`).query({ limit: 500 }), 400, 'validation_error');
    expectProblem(
      await h.request.get(`/pulls/${created.body.id}/policies`).query({ cursor: '00000000-0000-4000-8000-000000000000' }),
      400,
      'invalid_cursor',
    );
  });

  it('echoes a safe X-Request-Id and replaces an unsafe one', async () => {
    const echoed = await h.request.get('/health').set('X-Request-Id', 'client-req-42');
    expect(echoed.headers['x-request-id']).toBe('client-req-42');
    for (const unsafe of ['has spaces <script>', 'x'.repeat(200)]) {
      const replaced = await h.request.get('/health').set('X-Request-Id', unsafe);
      expect(replaced.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('records the request ID on the pull for log correlation', async () => {
    const res = await h.request.post('/pulls').set('X-Request-Id', 'corr-abc').send(valid);
    const row = await h.runtime.prisma.pull.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.correlationId).toBe('corr-abc');
  });

  it('serves the OpenAPI document and Swagger UI', async () => {
    const spec = await h.request.get('/openapi.json');
    expect(spec.body.openapi).toBe('3.1.0');
    expect(Object.keys(spec.body.paths)).toEqual(['/health', '/carriers', '/pulls', '/pulls/{id}', '/pulls/{id}/policies', '/policies/{id}']);
    expect(spec.body.components.schemas.NormalizedPolicy).toBeDefined();
    const ui = await h.request.get('/docs/');
    expect(ui.status).toBe(200);
    expect(ui.text).toContain('swagger-ui');
  });
});
