import type { Coverage, CoverageType, NormalizedPolicy, PolicyStatus, PolicyType, PremiumTerm } from '../../contracts/index.js';
import { FieldNormalizer, isBlank, nameFromFull, normalizeMake, normalizeVin } from '../../normalization/index.js';
import { buildPolicy, type PolicyMeta, RecordRejectedError } from '../shared/policy-builder.js';
import type { RawPortalPolicy } from './portal/pages.js';
import { LABELS } from './portal/selectors.js';

const POLICY_TYPES: Record<string, PolicyType> = {
  'AUTO INSURANCE': 'auto',
  'MOTORCYCLE INSURANCE': 'motorcycle',
  'HOMEOWNERS INSURANCE': 'homeowners',
  'CONDO INSURANCE': 'condo',
  'RENTERS INSURANCE': 'renters',
  'UMBRELLA INSURANCE': 'umbrella',
};

const STATUSES: Record<string, PolicyStatus> = {
  'IN FORCE': 'active',
  PENDING: 'pending',
  CANCELLED: 'cancelled',
  LAPSED: 'cancelled',
  EXPIRED: 'expired',
};

const COVERAGES: Record<string, CoverageType> = {
  'BODILY INJURY LIABILITY': 'bodily_injury_liability',
  'PROPERTY DAMAGE LIABILITY': 'property_damage_liability',
  'UNINSURED MOTORIST': 'uninsured_motorist',
  'MEDICAL PAYMENTS': 'medical_payments',
  COLLISION: 'collision',
  COMPREHENSIVE: 'comprehensive',
  'ROADSIDE ASSISTANCE': 'roadside_assistance',
  'RENTAL REIMBURSEMENT': 'rental_reimbursement',
  DWELLING: 'dwelling',
  'OTHER STRUCTURES': 'other_structures',
  'PERSONAL PROPERTY': 'personal_property',
  'LOSS OF USE': 'loss_of_use',
  'PERSONAL LIABILITY': 'personal_liability',
};

const TERM_PHRASES: Record<string, PremiumTerm> = {
  'PER MONTH': 'monthly',
  'EVERY 3 MONTHS': 'quarterly',
  'EVERY 6 MONTHS': 'semi_annual',
  'PER YEAR': 'annual',
};

/** Display values that mean "no dollar amount" rather than "missing". */
const NON_NUMERIC_AMOUNTS = new Set(['INCLUDED', 'ACTUAL CASH VALUE']);
const NOT_AVAILABLE = 'NOT AVAILABLE';

function parseAmountPair(n: FieldNormalizer, field: string, raw: string): Pick<Coverage, 'limitCents' | 'perOccurrenceLimitCents'> {
  if (isBlank(raw) || NON_NUMERIC_AMOUNTS.has(raw.trim().toUpperCase())) {
    if (!isBlank(raw)) n.raw(field, raw);
    return { limitCents: null, perOccurrenceLimitCents: null };
  }
  const [first = '', second] = raw.split('/').map((part) => part.trim());
  return {
    limitCents: n.money(field, first),
    perOccurrenceLimitCents: second === undefined ? null : n.money(`${field}.perOccurrence`, second),
  };
}

function parsePremium(n: FieldNormalizer, raw: string | undefined): NormalizedPolicy['premium'] {
  if (raw === undefined || isBlank(raw) || raw.trim().toUpperCase() === NOT_AVAILABLE) {
    n.warn('premium', 'missing_field', 'premium was not provided by the carrier');
    return null;
  }
  const match = /^(\$[\d,]+(?:\.\d{1,2})?)\s*(.*)$/.exec(raw.trim());
  const amountCents = match ? n.money('premium.amount', match[1]) : null;
  if (!match || amountCents === null) {
    if (!match) {
      n.raw('premium', raw);
      n.warn('premium', 'invalid_amount', 'premium text did not start with a dollar amount');
    }
    return null;
  }
  const phrase = (match[2] ?? '').trim().toUpperCase();
  const term = TERM_PHRASES[phrase] ?? null;
  if (phrase && !term) {
    n.raw('premium.term', match[2] ?? null);
    n.warn('premium.term', 'unmapped_value', `premium term '${match[2]}' has no mapping`);
  }
  return { amountCents, currency: 'USD', term };
}

/** Pure mapping from scraped portal strings to NormalizedPolicy v1. */
export function normalizeCarrierCPolicy(raw: RawPortalPolicy, meta: PolicyMeta): NormalizedPolicy {
  const n = new FieldNormalizer();
  const s = raw.summary;
  const externalPolicyId = n.text('externalPolicyId', s[LABELS.policyNumber]);
  if (!externalPolicyId) throw new RecordRejectedError('missing_policy_number', 'Policy page has no policy number');

  const policyType = n.enumValue('policyType', s[LABELS.product], POLICY_TYPES, 'other');
  const status = n.enumValue('status', s[LABELS.status], STATUSES, 'unknown');

  // "May 12, 2026 – Nov 12, 2026"
  const [start, end] = (s[LABELS.period] ?? '').split(/\s+[–—-]\s+/);
  const effectiveDate = n.date('effectiveDate', start, ['month_name'], { required: true });
  const expirationDate = n.date('expirationDate', end, ['month_name'], { required: true });

  const insured = s[LABELS.namedInsured];
  const policyholder = insured && !isBlank(insured) ? nameFromFull(insured) : null;
  if (!policyholder) n.warn('policyholder', 'missing_field', 'policyholder name was not provided by the carrier');

  const coverages = raw.coverages.map(
    (c, i): Coverage => ({
      type: n.enumValue(`coverages[${i}].type`, c.name, COVERAGES, 'other'),
      carrierCode: c.name || null,
      ...parseAmountPair(n, `coverages[${i}].limit`, c.limit),
      deductibleCents: n.money(`coverages[${i}].deductible`, c.deductible),
    }),
  );

  const vehicles =
    raw.vehicles?.map((v, i) => {
      // "2021 Mazda CX-5": year, single-token make, remainder as model.
      const match = /^(\d{4})\s+(\S+)\s+(.+)$/.exec(v.description);
      if (!match) {
        n.raw(`vehicles[${i}].description`, v.description);
        n.warn(`vehicles[${i}]`, 'invalid_value', 'vehicle description is not "<year> <make> <model>"');
      }
      const vinText = v.vin.replace(/^VIN:\s*/i, '');
      let vin: string | null = null;
      if (!isBlank(vinText)) {
        const result = normalizeVin(vinText);
        vin = result.vin;
        if (result.issue) {
          n.raw(`vehicles[${i}].vin`, vinText);
          n.warn(`vehicles[${i}].vin`, result.issue, `VIN failed validation (${result.issue})`);
        }
      }
      return {
        vin,
        year: match ? n.integer(`vehicles[${i}].year`, match[1], { min: 1900, max: 2100 }) : null,
        make: match?.[2] ? normalizeMake(match[2]) : null,
        model: match?.[3]?.trim() ?? null,
      };
    }) ?? null;

  const drivers = raw.drivers?.flatMap((d) => {
    const name = nameFromFull(d);
    return name ? [name] : [];
  }) ?? null;

  return buildPolicy(meta, n, {
    externalPolicyId,
    policyholder,
    policyType,
    status,
    effectiveDate,
    expirationDate,
    premium: parsePremium(n, s[LABELS.premium]),
    coverages,
    vehicles,
    drivers,
  });
}
