import type { CoverageType, NormalizedPolicy, PolicyStatus, PolicyType } from '../../contracts/index.js';
import {
  FieldNormalizer,
  nameFromParts,
  normalizeMake,
  normalizeVin,
  termFromMonths,
} from '../../normalization/index.js';
import { buildPolicy, type PolicyMeta, RecordRejectedError } from '../shared/policy-builder.js';
import type { CarrierAPolicyDetail } from './schemas.js';

const POLICY_TYPES: Record<string, PolicyType> = {
  PERSONAL_AUTO: 'auto',
  MOTORCYCLE: 'motorcycle',
  HOMEOWNERS: 'homeowners',
  CONDO: 'condo',
  RENTERS: 'renters',
  PERSONAL_UMBRELLA: 'umbrella',
};

const STATUSES: Record<string, PolicyStatus> = {
  IN_FORCE: 'active',
  PENDING_ACTIVATION: 'pending',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
  NON_RENEWED: 'expired',
};

const COVERAGES: Record<string, CoverageType> = {
  BODILY_INJURY: 'bodily_injury_liability',
  PROPERTY_DAMAGE: 'property_damage_liability',
  COMBINED_SINGLE_LIMIT: 'combined_single_limit',
  UNINSURED_MOTORIST: 'uninsured_motorist',
  UNDERINSURED_MOTORIST: 'underinsured_motorist',
  MEDICAL_PAYMENTS: 'medical_payments',
  PERSONAL_INJURY_PROTECTION: 'personal_injury_protection',
  COLLISION: 'collision',
  COMPREHENSIVE: 'comprehensive',
  RENTAL_REIMBURSEMENT: 'rental_reimbursement',
  ROADSIDE_ASSISTANCE: 'roadside_assistance',
  DWELLING: 'dwelling',
  OTHER_STRUCTURES: 'other_structures',
  PERSONAL_PROPERTY: 'personal_property',
  LOSS_OF_USE: 'loss_of_use',
  PERSONAL_LIABILITY: 'personal_liability',
  UMBRELLA_LIABILITY: 'umbrella_liability',
};

/** Pure mapping from Carrier A's policy detail to NormalizedPolicy v1. */
export function normalizeCarrierAPolicy(raw: CarrierAPolicyDetail, meta: PolicyMeta): NormalizedPolicy {
  const n = new FieldNormalizer();
  const externalPolicyId = n.text('externalPolicyId', raw.policyNumber);
  if (!externalPolicyId) throw new RecordRejectedError('missing_policy_number', 'Policy record has no policyNumber');

  const policyType = n.enumValue('policyType', raw.lineOfBusiness, POLICY_TYPES, 'other');
  const status = n.enumValue('status', raw.status, STATUSES, 'unknown');
  const effectiveDate = n.date('effectiveDate', raw.term?.effectiveDate, ['iso'], { required: true });
  const expirationDate = n.date('expirationDate', raw.term?.expirationDate, ['iso'], { required: true });
  const termMonths = n.integer('premium.term', raw.term?.lengthMonths, { min: 1, max: 36 });

  let premium: NormalizedPolicy['premium'] = null;
  const total = raw.premium?.total;
  if (total) {
    const amountCents = n.money('premium.amount', total.amount);
    const currency = (total.currency ?? '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      n.warn('premium.currency', 'invalid_value', 'premium currency is missing or not an ISO 4217 code');
    } else if (amountCents !== null) {
      const term = termFromMonths(termMonths);
      if (termMonths !== null && term === null) {
        n.warn('premium.term', 'unmapped_value', `term length of ${termMonths} months has no premium term mapping`);
      }
      premium = { amountCents, currency, term };
    }
  } else {
    n.warn('premium', 'missing_field', 'premium was not provided by the carrier');
  }

  const coverages =
    raw.coverages?.map((c, i) => ({
      type: n.enumValue(`coverages[${i}].type`, c.code, COVERAGES, 'other'),
      carrierCode: c.code ?? null,
      limitCents: n.money(`coverages[${i}].limit`, c.limit?.perPerson?.amount ?? c.limit?.amount?.amount),
      perOccurrenceLimitCents: n.money(`coverages[${i}].perOccurrenceLimit`, c.limit?.perOccurrence?.amount),
      deductibleCents: n.money(`coverages[${i}].deductible`, c.deductible?.amount),
    })) ?? null;

  const vehicles =
    raw.vehicles?.map((v, i) => {
      let vin: string | null = null;
      if (v.vin) {
        const result = normalizeVin(v.vin);
        vin = result.vin;
        if (result.issue) {
          n.raw(`vehicles[${i}].vin`, v.vin);
          n.warn(`vehicles[${i}].vin`, result.issue, `VIN failed validation (${result.issue})`);
        }
      }
      const make = n.text(`vehicles[${i}].make`, v.make);
      return {
        vin,
        year: n.integer(`vehicles[${i}].year`, v.year, { min: 1900, max: 2100 }),
        make: make ? normalizeMake(make) : null,
        model: n.text(`vehicles[${i}].model`, v.model),
      };
    }) ?? null;

  const drivers =
    raw.drivers?.flatMap((d) => {
      const name = nameFromParts(d.givenName, d.familyName);
      return name ? [name] : [];
    }) ?? null;

  const policyholder = nameFromParts(raw.insured?.givenName, raw.insured?.familyName);
  if (!policyholder) n.warn('policyholder', 'missing_field', 'policyholder name was not provided by the carrier');

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
