import type { AppConfig } from '../../config/env.js';
import type { NormalizedPolicy } from '../../contracts/index.js';
import { CarrierError } from '../../domain/errors.js';
import { mapWithConcurrency } from '../../lib/concurrency.js';
import { type UsernamePasswordCredentials, USERNAME_PASSWORD_FIELDS, usernamePasswordSchema } from '../shared/credentials.js';
import { CarrierHttpClient } from '../shared/http-client.js';
import { RecordRejectedError } from '../shared/policy-builder.js';
import type { CarrierAdapter, CarrierDescriptor, RetrievalWarning } from '../types.js';
import { CarrierAClient } from './client.js';
import { normalizeCarrierAPolicy } from './normalize.js';
import { PolicyDetailSchema, PolicyListPageSchema } from './schemas.js';

export const CARRIER_A_ID = 'carrier-a';
const MAX_PAGES = 100;

export const carrierADescriptor: CarrierDescriptor = {
  id: CARRIER_A_ID,
  displayName: 'Carrier A (Modern REST API)',
  integrationType: 'rest_api',
  adapterVersion: '1.0.0',
  description: 'OAuth2 password grant with rotating refresh tokens, cursor pagination, and rate limiting.',
  credentialFields: USERNAME_PASSWORD_FIELDS,
};

export interface CarrierAAdapterConfig {
  baseUrl: string;
  http: AppConfig['carrierHttp'];
  /** Parallel detail requests per retrieval. Kept low to stay under the carrier's rate limit. */
  detailConcurrency?: number;
}

export function createCarrierAAdapter(config: CarrierAAdapterConfig): CarrierAdapter<UsernamePasswordCredentials> {
  return {
    descriptor: carrierADescriptor,
    credentialsSchema: usernamePasswordSchema,

    async retrievePolicies(credentials, ctx) {
      const http = new CarrierHttpClient({
        carrierId: CARRIER_A_ID,
        baseUrl: config.baseUrl,
        timeoutMs: config.http.timeoutMs,
        retry: {
          maxRetries: config.http.maxRetries,
          baseDelayMs: config.http.retryBaseDelayMs,
          maxDelayMs: config.http.retryMaxDelayMs,
          maxRetryAfterMs: config.http.maxRetryAfterMs,
        },
        logger: ctx.logger,
        signal: ctx.signal,
      });
      const client = new CarrierAClient(CARRIER_A_ID, http, credentials, ctx.logger);
      await client.login();

      // 1. Walk the cursor-paginated listing, guarding against cycles and runaway pagination.
      const policyNumbers: string[] = [];
      const warnings: RetrievalWarning[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      let pages = 0;
      do {
        if (++pages > MAX_PAGES) throw invalid('pagination_limit_exceeded', `More than ${MAX_PAGES} pages returned`);
        const page = PolicyListPageSchema.safeParse(await client.getJson('list_policies', '/v1/policies', { cursor }));
        if (!page.success) throw invalid('invalid_policy_list', 'Policy list response did not match the expected shape');
        for (const { policyNumber } of page.data.data) {
          if (policyNumbers.includes(policyNumber)) {
            warnings.push({ code: 'duplicate_record', message: 'Policy listed more than once across pages', externalPolicyId: policyNumber });
          } else {
            policyNumbers.push(policyNumber);
          }
        }
        const next = page.data.page.nextCursor ?? undefined;
        if (next && seenCursors.has(next)) throw invalid('pagination_cycle', 'Carrier returned a cursor that was already visited');
        if (next) seenCursors.add(next);
        cursor = next;
      } while (cursor);

      // 2. Fetch details with bounded concurrency; one bad record never sinks the batch.
      const retrievedAt = ctx.now().toISOString();
      const meta = { carrierId: CARRIER_A_ID, integrationType: 'rest_api' as const, adapterVersion: carrierADescriptor.adapterVersion, retrievedAt };
      const details = await mapWithConcurrency(policyNumbers, config.detailConcurrency ?? 2, (policyNumber) =>
        client.getJson('get_policy', `/v1/policies/${encodeURIComponent(policyNumber)}`),
      );

      const policies: NormalizedPolicy[] = [];
      details.forEach((detail, i) => {
        const externalPolicyId = policyNumbers[i] ?? null;
        if (detail === null) {
          warnings.push({ code: 'record_not_found', message: 'Listed policy returned 404 on detail fetch', externalPolicyId });
          return;
        }
        const parsed = PolicyDetailSchema.safeParse(detail);
        if (!parsed.success) {
          warnings.push({ code: 'invalid_record', message: 'Policy detail did not match the expected shape', externalPolicyId });
          return;
        }
        try {
          policies.push(normalizeCarrierAPolicy(parsed.data, meta));
        } catch (error) {
          if (!(error instanceof RecordRejectedError)) throw error;
          warnings.push({ code: error.code, message: error.message, externalPolicyId });
        }
      });

      return {
        policies,
        warnings,
        stats: { pages, requests: http.stats.requests, retries: http.stats.retries, ...client.stats },
      };
    },
  };
}

function invalid(code: string, message: string): CarrierError {
  return new CarrierError({ carrierId: CARRIER_A_ID, category: 'invalid_response', code, message });
}
