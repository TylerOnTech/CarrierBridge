import type { Coverage, CoverageType, NormalizedPolicy, PolicyStatus, PolicyType } from '../../contracts/index.js';
import {
  describeRaw,
  FieldNormalizer,
  isBlank,
  nameFromFull,
  normalizeMake,
  normalizeVin,
  termFromMonths,
  thousandsToCents,
} from '../../normalization/index.js';
import { asArray, buildPolicy, type PolicyMeta, RecordRejectedError } from '../shared/policy-builder.js';
import type { LegacyPolicyRecord } from './schemas.js';

const POLICY_TYPES: Record<string, PolicyType> = {
  PAUTO: 'auto',
  MCYC: 'motorcycle',
  HOME: 'homeowners',
  CONDO: 'condo',
  RENT: 'renters',
  UMB: 'umbrella',
};

/** "L" (lapsed for non-payment) is a cancellation in contract terms; the raw code is preserved. */
const STATUSES: Record<string, PolicyStatus> = { A: 'active', P: 'pending', C: 'cancelled', L: 'cancelled', E: 'expired' };

const COVERAGES: Record<string, CoverageType> = {
  BI: 'bodily_injury_liability',
  PD: 'property_damage_liability',
  CSL: 'combined_single_limit',
  UM: 'uninsured_motorist',
  UIM: 'underinsured_motorist',
  MED: 'medical_payments',
  PIP: 'personal_injury_protection',
  COLL: 'collision',
  COMP: 'comprehensive',
  RENT: 'rental_reimbursement',
  ROAD: 'roadside_assistance',
  DWELL: 'dwelling',
  OTH_STRUCT: 'other_structures',
  PERS_PROP: 'personal_property',
  LOU: 'loss_of_use',
  LIAB: 'personal_liability',
  UMB: 'umbrella_liability',
};

/** Limits that are meaningful but not a dollar amount (actual cash value, included). */
const NON_NUMERIC_LIMITS = new Set(['ACV', 'INCL']);
/** Carrier B's EFF_DT and EXP_DT come from different subsystems; accept either documented format. */
const DATE_FORMATS = ['mdy_slash', 'ymd_compact'] as const;
/** Carrier B is a US-only carrier whose integration guide specifies USD for all amounts. */
const CARRIER_B_CURRENCY = 'USD';

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const obj = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

function normalizeLimit(n: FieldNormalizer, field: string, raw: unknown): Pick<Coverage, 'limitCents' | 'perOccurrenceLimitCents'> {
  const none = { limitCents: null, perOccurrenceLimitCents: null };
  if (isBlank(raw)) return none;
  const value = describeRaw(raw).trim().toUpperCase();
  if (NON_NUMERIC_LIMITS.has(value)) {
    n.raw(field, value);
    return none;
  }
  const [first, second, ...rest] = value.split('/');
  const limitCents = first === undefined ? null : thousandsToCents(first);
  const perOccurrenceLimitCents = second === undefined ? null : thousandsToCents(second);
  if (limitCents === null || (second !== undefined && perOccurrenceLimitCents === null) || rest.length > 0) {
    n.raw(field, describeRaw(raw));
    n.warn(field, 'invalid_amount', `${field} is not a limit in thousands (e.g. "100" or "100/300")`);
    return none;
  }
  return { limitCents, perOccurrenceLimitCents };
}

/** Pure mapping from a Carrier B legacy record to NormalizedPolicy v1. */
export function normalizeCarrierBPolicy(raw: LegacyPolicyRecord, meta: PolicyMeta): NormalizedPolicy {
  const n = new FieldNormalizer();
  const externalPolicyId = n.text('externalPolicyId', raw.POL_NBR);
  if (!externalPolicyId) throw new RecordRejectedError('missing_policy_number', 'Legacy record has no POL_NBR');

  const policyType = n.enumValue('policyType', raw.LOB_CD, POLICY_TYPES, 'other');
  const status = n.enumValue('status', raw.POL_STAT_CD, STATUSES, 'unknown');
  const effectiveDate = n.date('effectiveDate', raw.EFF_DT, DATE_FORMATS, { required: true });
  const expirationDate = n.date('expirationDate', raw.EXP_DT, DATE_FORMATS, { required: true });

  const amountCents = n.money('premium.amount', raw.TOT_PREM, { required: true });
  const termMonths = n.integer('premium.term', raw.TERM_MO, { min: 1, max: 36 });
  const premium = amountCents === null ? null : { amountCents, currency: CARRIER_B_CURRENCY, term: termFromMonths(termMonths) };

  const insuredName = str(obj(raw.INSD).NM);
  const policyholder = insuredName ? nameFromFull(insuredName) : null;
  if (!policyholder) n.warn('policyholder', 'missing_field', 'policyholder name was not provided by the carrier');

  const coverages =
    raw.COV_LIST === undefined
      ? null
      : asArray(obj(raw.COV_LIST).COV).map((item, i): Coverage => {
          const c = obj(item);
          const code = str(c.COV_CD)?.trim() ?? null;
          return {
            type: n.enumValue(`coverages[${i}].type`, code, COVERAGES, 'other'),
            carrierCode: code,
            ...normalizeLimit(n, `coverages[${i}].limit`, c.LIM),
            deductibleCents: n.money(`coverages[${i}].deductible`, c.DED),
          };
        });

  const vehicles =
    raw.VEH_LIST === undefined
      ? null
      : asArray(obj(raw.VEH_LIST).VEH).map((item, i) => {
          const v = obj(item);
          let vin: string | null = null;
          const rawVin = str(v.VIN);
          if (rawVin && !isBlank(rawVin)) {
            const result = normalizeVin(rawVin);
            vin = result.vin;
            if (result.issue) {
              n.raw(`vehicles[${i}].vin`, rawVin);
              n.warn(`vehicles[${i}].vin`, result.issue, `VIN failed validation (${result.issue})`);
            }
          }
          const make = n.text(`vehicles[${i}].make`, v.MAKE);
          return {
            vin,
            year: n.integer(`vehicles[${i}].year`, v.YR, { min: 1900, max: 2100 }),
            make: make ? normalizeMake(make) : null,
            // Model names have irregular casing (RAV4, CR-V); they are passed through, never recased.
            model: n.text(`vehicles[${i}].model`, v.MODEL),
          };
        });

  const drivers =
    raw.DRV_LIST === undefined
      ? null
      : asArray(obj(raw.DRV_LIST).DRV).flatMap((item) => {
          const name = str(obj(item).DRV_NM);
          const parsed = name ? nameFromFull(name) : null;
          return parsed ? [parsed] : [];
        });

  return buildPolicy(meta, n, {
    externalPolicyId,
    policyholder,
    policyType,
    status,
    effectiveDate,
    expirationDate,
    premium,
    coverages,
    vehicles,
    drivers,
  });
}
