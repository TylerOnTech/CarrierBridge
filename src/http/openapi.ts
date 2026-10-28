import { z } from 'zod';
import './schemas.js';
import { APP_VERSION } from '../version.js';

const ref = (id: string) => ({ $ref: `#/components/schemas/${id}` });
const json = (schemaId: string, description: string) => ({
  description,
  content: { 'application/json': { schema: ref(schemaId) } },
});
const problem = (description: string) => ({
  description,
  content: { 'application/problem+json': { schema: ref('Problem') } },
});
const requestIdHeader = {
  'X-Request-Id': { description: 'Correlation ID (echoed or generated)', schema: { type: 'string' } },
};
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };

/**
 * Builds the OpenAPI 3.1 document. Component schemas are generated from the same Zod
 * schemas that validate requests and responses, so the docs cannot drift from the code.
 */
export function buildOpenApiDocument(): Record<string, unknown> {
  const { schemas } = z.toJSONSchema(z.globalRegistry, {
    target: 'draft-2020-12',
    uri: (id) => `#/components/schemas/${id}`,
    unrepresentable: 'any',
  });
  for (const schema of Object.values(schemas)) delete (schema as Record<string, unknown>).$schema;

  return {
    openapi: '3.1.0',
    info: {
      title: 'CarrierBridge API',
      version: APP_VERSION,
      description:
        'Retrieve insurance policies from heterogeneous carriers (REST, legacy, browser portal) and read them back in one normalized, versioned schema. Pulls run asynchronously: create one, poll it, then page through its policies.',
    },
    servers: [{ url: 'http://localhost:3000' }],
    tags: [{ name: 'Pulls' }, { name: 'Policies' }, { name: 'Carriers' }, { name: 'Operations' }],
    paths: {
      '/health': {
        get: {
          tags: ['Operations'],
          summary: 'Liveness and readiness',
          responses: { '200': json('Health', 'Healthy'), '503': json('Health', 'Degraded or shutting down') },
        },
      },
      '/carriers': {
        get: {
          tags: ['Carriers'],
          summary: 'List supported carriers and the credentials each expects',
          responses: { '200': json('CarrierList', 'Registered carriers') },
        },
      },
      '/pulls': {
        post: {
          tags: ['Pulls'],
          summary: 'Start an asynchronous policy pull across one or more carriers',
          parameters: [
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: false,
              description:
                'Retries with the same key and body return the original pull (200). Reusing a key with a different body is rejected (422).',
              schema: { type: 'string', maxLength: 255 },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: ref('CreatePullRequest'),
                example: {
                  connections: [
                    { carrierId: 'carrier-a', credentials: { username: 'alex.rivera@example.com', password: 'apex-demo-1' } },
                    { carrierId: 'carrier-b', credentials: { username: 'ARIVERA', password: 'Legacy#2024' } },
                    { carrierId: 'carrier-c', credentials: { username: 'arivera', password: 'portal-demo-1' } },
                  ],
                },
              },
            },
          },
          responses: {
            '202': { ...json('Pull', 'Pull accepted; poll the Location header'), headers: { Location: { schema: { type: 'string' } }, ...requestIdHeader } },
            '200': json('Pull', 'Idempotent replay of an existing pull'),
            '400': problem('Validation error'),
            '415': problem('Content-Type is not application/json'),
            '422': problem('Idempotency-Key reused with a different body'),
          },
        },
      },
      '/pulls/{id}': {
        get: {
          tags: ['Pulls'],
          summary: 'Get pull status, per-carrier outcome, and errors',
          parameters: [idParam],
          responses: { '200': json('Pull', 'The pull'), '400': problem('Invalid id'), '404': problem('Not found') },
        },
      },
      '/pulls/{id}/policies': {
        get: {
          tags: ['Policies'],
          summary: 'List normalized policies retrieved by a pull (keyset paginated)',
          parameters: [
            idParam,
            { name: 'carrierId', in: 'query', schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 } },
            { name: 'cursor', in: 'query', description: 'Opaque cursor from pagination.nextCursor', schema: { type: 'string' } },
          ],
          responses: { '200': json('PolicyList', 'A page of policies'), '400': problem('Invalid query'), '404': problem('Pull not found') },
        },
      },
      '/policies/{id}': {
        get: {
          tags: ['Policies'],
          summary: 'Get one normalized policy',
          parameters: [idParam],
          responses: { '200': json('PolicyResource', 'The policy'), '400': problem('Invalid id'), '404': problem('Not found') },
        },
      },
    },
    components: { schemas },
  };
}
