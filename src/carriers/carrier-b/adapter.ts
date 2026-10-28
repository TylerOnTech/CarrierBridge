import type { AppConfig } from '../../config/env.js';
import type { NormalizedPolicy } from '../../contracts/index.js';
import { type UsernamePasswordCredentials, USERNAME_PASSWORD_FIELDS, usernamePasswordSchema } from '../shared/credentials.js';
import { CarrierHttpClient } from '../shared/http-client.js';
import { RecordRejectedError } from '../shared/policy-builder.js';
import type { CarrierAdapter, CarrierDescriptor, RetrievalWarning } from '../types.js';
import { CarrierBClient } from './client.js';
import { normalizeCarrierBPolicy } from './normalize.js';
import { LegacyPolicyRecordSchema } from './schemas.js';

export const CARRIER_B_ID = 'carrier-b';

export const carrierBDescriptor: CarrierDescriptor = {
  id: CARRIER_B_ID,
  displayName: 'Carrier B (Legacy REST API)',
  integrationType: 'legacy_api',
  adapterVersion: '1.0.0',
  description: 'Form-encoded session login, HTTP-200 error envelopes, XML-bridge JSON quirks, intermittent 503s.',
  credentialFields: USERNAME_PASSWORD_FIELDS,
};

export interface CarrierBAdapterConfig {
  baseUrl: string;
  http: AppConfig['carrierHttp'];
}

export function createCarrierBAdapter(config: CarrierBAdapterConfig): CarrierAdapter<UsernamePasswordCredentials> {
  return {
    descriptor: carrierBDescriptor,
    credentialsSchema: usernamePasswordSchema,

    async retrievePolicies(credentials, ctx) {
      const http = new CarrierHttpClient({
        carrierId: CARRIER_B_ID,
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
        // The legacy API puts the session key in the query string; keep it out of logs.
        sensitiveQueryParams: ['SessionKey'],
      });
      const client = new CarrierBClient(CARRIER_B_ID, http, credentials, ctx.logger);
      await client.authenticate();
      const records = await client.getPolicyList();

      const meta = {
        carrierId: CARRIER_B_ID,
        integrationType: 'legacy_api' as const,
        adapterVersion: carrierBDescriptor.adapterVersion,
        retrievedAt: ctx.now().toISOString(),
      };
      const policies: NormalizedPolicy[] = [];
      const warnings: RetrievalWarning[] = [];
      records.forEach((record, index) => {
        const parsed = LegacyPolicyRecordSchema.safeParse(record);
        if (!parsed.success) {
          warnings.push({ code: 'invalid_record', message: `Record at index ${index} is not an object` });
          return;
        }
        try {
          policies.push(normalizeCarrierBPolicy(parsed.data, meta));
        } catch (error) {
          if (!(error instanceof RecordRejectedError)) throw error;
          warnings.push({ code: error.code, message: `${error.message} (record index ${index})`, externalPolicyId: null });
        }
      });

      return { policies, warnings, stats: { records: records.length, requests: http.stats.requests, retries: http.stats.retries, ...client.stats } };
    },
  };
}
