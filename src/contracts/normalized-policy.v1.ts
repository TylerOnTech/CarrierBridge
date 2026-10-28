import { z } from 'zod';

/**
 * NormalizedPolicy v1 — the carrier-agnostic policy contract.
 *
 * Versioning rules (see docs/normalized-policy.md):
 *  - Additive, optional changes bump the minor version (1.0.0 -> 1.1.0).
 *  - Removing/renaming fields or changing semantics requires a new major
 *    version in a new module (normalized-policy.v2.ts); v1 stays importable.
 *
 * Null semantics: `null` always means "the carrier did not provide this (or it was
 * unparseable)". For lists, `null` means unknown while `[]` means the carrier
 * explicitly reported none. Normalizers never fabricate values to fill gaps.
 */
export const NORMALIZED_POLICY_SCHEMA_VERSION = '1.0.0' as const;

export const POLICY_TYPES = ['auto', 'motorcycle', 'homeowners', 'condo', 'renters', 'umbrella', 'other'] as const;
export const POLICY_STATUSES = ['active', 'pending', 'cancelled', 'expired', 'unknown'] as const;
export const PREMIUM_TERMS = ['monthly', 'quarterly', 'semi_annual', 'annual'] as const;
export const COVERAGE_TYPES = [
  'bodily_injury_liability',
  'property_damage_liability',
  'combined_single_limit',
  'uninsured_motorist',
  'underinsured_motorist',
  'medical_payments',
  'personal_injury_protection',
  'collision',
  'comprehensive',
  'rental_reimbursement',
  'roadside_assistance',
  'dwelling',
  'other_structures',
  'personal_property',
  'loss_of_use',
  'personal_liability',
  'umbrella_liability',
  'other',
] as const;
export const INTEGRATION_TYPES = ['rest_api', 'legacy_api', 'browser'] as const;

const IsoDate = z.iso.date().describe('Calendar date, YYYY-MM-DD. Policy dates carry no time zone.');
const Cents = z.number().int().nonnegative().describe('Integer minor units (cents). Never floating point.');

export const PolicyTypeSchema = z.enum(POLICY_TYPES);
export const PolicyStatusSchema = z.enum(POLICY_STATUSES);
export const PremiumTermSchema = z.enum(PREMIUM_TERMS);
export const CoverageTypeSchema = z.enum(COVERAGE_TYPES);

export const PersonNameSchema = z
  .strictObject({
    fullName: z.string().min(1),
    firstName: z.string().min(1).nullable(),
    lastName: z.string().min(1).nullable(),
  })
  .meta({ id: 'PersonName' });

export const PremiumSchema = z
  .strictObject({
    amountCents: Cents,
    currency: z.string().regex(/^[A-Z]{3}$/).describe('ISO 4217 currency code'),
    term: PremiumTermSchema.nullable().describe('Billing term the amount covers; null if not stated'),
  })
  .meta({ id: 'Premium' });

export const CoverageSchema = z
  .strictObject({
    type: CoverageTypeSchema,
    /** Carrier's own code, kept for traceability when `type` is `other` or mapping is lossy. */
    carrierCode: z.string().nullable(),
    limitCents: Cents.nullable().describe('Per-person / primary limit'),
    perOccurrenceLimitCents: Cents.nullable().describe('Second half of a split limit (e.g. 100/300)'),
    deductibleCents: Cents.nullable(),
  })
  .meta({ id: 'Coverage' });

export const VehicleSchema = z
  .strictObject({
    vin: z
      .string()
      .regex(/^[A-HJ-NPR-Z0-9]{17}$/)
      .nullable(),
    year: z.number().int().min(1900).max(2100).nullable(),
    make: z.string().min(1).nullable(),
    model: z.string().min(1).nullable(),
  })
  .meta({ id: 'Vehicle' });

export const NormalizationWarningSchema = z
  .strictObject({
    field: z.string(),
    code: z.string(),
    message: z.string(),
  })
  .meta({ id: 'NormalizationWarning' });

export const SourceMetadataSchema = z
  .strictObject({
    integrationType: z.enum(INTEGRATION_TYPES),
    adapterVersion: z.string(),
    /** Carrier-native values for enumerations and lossy fields, for debugging mappings. */
    rawValues: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
    warnings: z.array(NormalizationWarningSchema),
  })
  .meta({ id: 'SourceMetadata' });

export const NormalizedPolicySchema = z
  .strictObject({
    schemaVersion: z.literal(NORMALIZED_POLICY_SCHEMA_VERSION),
    carrierId: z.string().min(1),
    externalPolicyId: z.string().min(1),
    policyholder: PersonNameSchema.nullable(),
    policyType: PolicyTypeSchema,
    status: PolicyStatusSchema,
    effectiveDate: IsoDate.nullable(),
    expirationDate: IsoDate.nullable(),
    premium: PremiumSchema.nullable(),
    coverages: z.array(CoverageSchema).nullable(),
    vehicles: z.array(VehicleSchema).nullable(),
    drivers: z.array(PersonNameSchema).nullable(),
    retrievedAt: z.iso.datetime().describe('When CarrierBridge retrieved the data (UTC instant)'),
    source: SourceMetadataSchema,
  })
  .meta({ id: 'NormalizedPolicy', description: 'Carrier-agnostic insurance policy, contract v1' });

export type PolicyType = z.infer<typeof PolicyTypeSchema>;
export type PolicyStatus = z.infer<typeof PolicyStatusSchema>;
export type PremiumTerm = z.infer<typeof PremiumTermSchema>;
export type CoverageType = z.infer<typeof CoverageTypeSchema>;
export type IntegrationType = (typeof INTEGRATION_TYPES)[number];
export type PersonName = z.infer<typeof PersonNameSchema>;
export type Premium = z.infer<typeof PremiumSchema>;
export type Coverage = z.infer<typeof CoverageSchema>;
export type Vehicle = z.infer<typeof VehicleSchema>;
export type NormalizationWarning = z.infer<typeof NormalizationWarningSchema>;
export type SourceMetadata = z.infer<typeof SourceMetadataSchema>;
export type NormalizedPolicy = z.infer<typeof NormalizedPolicySchema>;
