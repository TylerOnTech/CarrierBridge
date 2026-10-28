import type { z } from 'zod';
import type { IntegrationType, NormalizedPolicy } from '../contracts/index.js';
import type { Logger } from '../logging/logger.js';

/**
 * The seam between the core engine and carrier-specific code.
 *
 * The worker knows nothing about OAuth, legacy session keys, or browsers: it hands an
 * adapter decrypted credentials plus a context (logger, deadline signal) and receives
 * contract-valid policies or a classified CarrierError. Adding a carrier means writing
 * one adapter and registering it; the queue, API, and persistence are untouched.
 */
export interface CredentialField {
  name: string;
  label: string;
  secret: boolean;
}

export interface CarrierDescriptor {
  id: string;
  displayName: string;
  integrationType: IntegrationType;
  adapterVersion: string;
  description: string;
  credentialFields: CredentialField[];
}

export interface RetrievalContext {
  logger: Logger;
  /** Aborted when the task deadline passes, the worker shuts down, or the lease is lost. */
  signal: AbortSignal;
  correlationId: string;
  now: () => Date;
}

/** Retrieval-level findings that are not fatal, e.g. a record that had to be skipped. */
export interface RetrievalWarning {
  code: string;
  message: string;
  externalPolicyId?: string | null;
}

export interface RetrievalResult {
  policies: NormalizedPolicy[];
  warnings: RetrievalWarning[];
  /** Diagnostic counters (requests, pages, re-authentications) surfaced in logs. */
  stats: Record<string, number>;
}

export interface CarrierAdapter<TCredentials> {
  readonly descriptor: CarrierDescriptor;
  /** Parses raw credential input. Used at the API boundary and again after decryption. */
  readonly credentialsSchema: z.ZodType<TCredentials>;
  retrievePolicies(credentials: TCredentials, ctx: RetrievalContext): Promise<RetrievalResult>;
}
