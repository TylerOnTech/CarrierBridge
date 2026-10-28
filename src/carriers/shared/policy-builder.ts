import {
  NORMALIZED_POLICY_SCHEMA_VERSION,
  type IntegrationType,
  type NormalizedPolicy,
} from '../../contracts/index.js';
import type { FieldNormalizer } from '../../normalization/index.js';

export interface PolicyMeta {
  carrierId: string;
  integrationType: IntegrationType;
  adapterVersion: string;
  retrievedAt: string;
}

export type PolicyCore = Omit<NormalizedPolicy, 'schemaVersion' | 'carrierId' | 'retrievedAt' | 'source'>;

/** Thrown by normalizers when a record cannot be identified and must be skipped. */
export class RecordRejectedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RecordRejectedError';
  }
}

/** Assembles a NormalizedPolicy and attaches the normalizer's warnings and raw values as source metadata. */
export function buildPolicy(meta: PolicyMeta, n: FieldNormalizer, core: PolicyCore): NormalizedPolicy {
  if (core.effectiveDate && core.expirationDate && core.expirationDate < core.effectiveDate) {
    n.warn('expirationDate', 'date_order', 'expirationDate is before effectiveDate');
  }
  return {
    schemaVersion: NORMALIZED_POLICY_SCHEMA_VERSION,
    carrierId: meta.carrierId,
    ...core,
    retrievedAt: meta.retrievedAt,
    source: {
      integrationType: meta.integrationType,
      adapterVersion: meta.adapterVersion,
      rawValues: n.rawValues,
      warnings: n.warnings,
    },
  };
}

/** XML-to-JSON bridges emit a lone child as an object and an empty element as "". */
export function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  return [value];
}
