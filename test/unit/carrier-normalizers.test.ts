import { describe, expect, it } from 'vitest';
import { normalizeCarrierAPolicy } from '../../src/carriers/carrier-a/normalize.js';
import { PolicyDetailSchema } from '../../src/carriers/carrier-a/schemas.js';
import { normalizeCarrierBPolicy } from '../../src/carriers/carrier-b/normalize.js';
import { normalizeCarrierCPolicy } from '../../src/carriers/carrier-c/normalize.js';
import type { RawPortalPolicy } from '../../src/carriers/carrier-c/portal/pages.js';
import { RecordRejectedError } from '../../src/carriers/shared/policy-builder.js';
import { NormalizedPolicySchema } from '../../src/contracts/index.js';
import { CARRIER_A_POLICIES } from '../../mock-carriers/data/carrier-a.js';
import { CARRIER_B_POLICIES } from '../../mock-carriers/data/carrier-b.js';

const meta = (carrierId: string, integrationType: 'rest_api' | 'legacy_api' | 'browser') => ({
  carrierId,
  integrationType,
  adapterVersion: '1.0.0',
  retrievedAt: '2026-10-28T12:00:00.000Z',
});
const codes = (p: { source: { warnings: Array<{ code: string }> } }) => p.source.warnings.map((w) => w.code);

describe('Carrier A normalizer (modern REST)', () => {
  const normalize = (raw: unknown) => normalizeCarrierAPolicy(PolicyDetailSchema.parse(raw), meta('carrier-a', 'rest_api'));
  const fixture = (n: string) => structuredClone([...CARRIER_A_POLICIES.alex, ...CARRIER_A_POLICIES.jordan, ...CARRIER_A_POLICIES.sam].find((p) => p.policyNumber === n)!);

  it('maps a complete auto policy, converting decimal strings to integer cents', () => {
    const policy = normalize(fixture('APX-AUTO-100234'));
    expect(NormalizedPolicySchema.parse(policy)).toEqual(policy);
    expect(policy).toMatchObject({
      schemaVersion: '1.0.0',
      carrierId: 'carrier-a',
      externalPolicyId: 'APX-AUTO-100234',
      policyType: 'auto',
      status: 'active',
      effectiveDate: '2026-03-01',
      expirationDate: '2026-09-01',
      premium: { amountCents: 64218, currency: 'USD', term: 'semi_annual' },
      policyholder: { fullName: 'Alex Rivera', firstName: 'Alex', lastName: 'Rivera' },
    });
    expect(policy.coverages?.[0]).toEqual({
      type: 'bodily_injury_liability',
      carrierCode: 'BODILY_INJURY',
      limitCents: 10_000_000,
      perOccurrenceLimitCents: 30_000_000,
      deductibleCents: null,
    });
    expect(policy.coverages?.find((c) => c.type === 'collision')?.deductibleCents).toBe(50_000);
    expect(policy.vehicles).toEqual([
      { vin: '2T3P1RFV3MW123456', year: 2021, make: 'Toyota', model: 'RAV4' },
      { vin: '5YJ3E1EA2NF204118', year: 2022, make: 'Tesla', model: 'Model 3' },
    ]);
    expect(policy.drivers?.map((d) => d.fullName)).toEqual(['Alex Rivera', 'Morgan Rivera']);
    expect(policy.source.warnings).toEqual([]);
    expect(policy.source.rawValues).toMatchObject({ status: 'IN_FORCE', policyType: 'PERSONAL_AUTO' });
  });

  it('distinguishes omitted lists (null = unknown) from explicitly empty lists ([] = none)', () => {
    expect(normalize(fixture('APX-RENT-300456'))).toMatchObject({ policyType: 'renters', vehicles: null, drivers: null });
    expect(normalize(fixture('APX-HOME-200871'))).toMatchObject({ policyType: 'homeowners', vehicles: [], drivers: [] });
  });

  it('maps unknown coverage codes to "other" and keeps the carrier code', () => {
    const policy = normalize(fixture('APX-AUTO-100877'));
    expect(policy.status).toBe('pending');
    expect(policy.coverages?.at(-1)).toEqual({
      type: 'other',
      carrierCode: 'ACCIDENT_FORGIVENESS',
      limitCents: null,
      perOccurrenceLimitCents: null,
      deductibleCents: null,
    });
    expect(codes(policy)).toEqual(['unmapped_value']);
  });

  it('does not invent a premium when the carrier omits it', () => {
    const raw = fixture('APX-AUTO-100234');
    delete raw.premium;
    const policy = normalize(raw);
    expect(policy.premium).toBeNull();
    expect(codes(policy)).toContain('missing_field');
  });

  it('drops the premium (with a warning) rather than assume a currency', () => {
    const raw = fixture('APX-AUTO-100234');
    raw.premium = { total: { amount: '642.18', currency: '' } };
    const policy = normalize(raw);
    expect(policy.premium).toBeNull();
    expect(policy.source.warnings).toContainEqual(expect.objectContaining({ field: 'premium.currency' }));
  });

  it('maps unrecognized statuses to "unknown" and preserves the raw code', () => {
    const raw = fixture('APX-AUTO-100234');
    raw.status = 'UNDER_REVIEW';
    const policy = normalize(raw);
    expect(policy.status).toBe('unknown');
    expect(policy.source.rawValues.status).toBe('UNDER_REVIEW');
  });

  it('rejects records without a policy number', () => {
    const { policyNumber: _omitted, ...raw } = fixture('APX-AUTO-100234');
    expect(() => normalize(raw)).toThrow(RecordRejectedError);
  });
});

describe('Carrier B normalizer (legacy, XML-bridged)', () => {
  const normalize = (raw: Record<string, unknown>) => normalizeCarrierBPolicy(raw, meta('carrier-b', 'legacy_api'));
  const [jordanAuto, jordanExpired, jordanBoat, jordanNoId] = CARRIER_B_POLICIES.jordan as [
    Record<string, unknown>,
    Record<string, unknown>,
    Record<string, unknown>,
    Record<string, unknown>,
  ];

  it('normalizes mixed date formats, "$1,284.6" premiums, and limits in thousands', () => {
    const policy = normalize(jordanAuto);
    expect(NormalizedPolicySchema.parse(policy)).toEqual(policy);
    expect(policy).toMatchObject({
      externalPolicyId: 'BL-90311-02',
      policyType: 'auto',
      status: 'active',
      effectiveDate: '2026-02-01', // EFF_DT "02/01/2026"
      expirationDate: '2026-08-01', // EXP_DT "20260801"
      premium: { amountCents: 128_460, currency: 'USD', term: 'semi_annual' },
      policyholder: { fullName: 'Jordan Lee', firstName: 'Jordan', lastName: 'Lee' },
    });
    const byCode = Object.fromEntries((policy.coverages ?? []).map((c) => [c.carrierCode, c]));
    expect(byCode.BI).toMatchObject({ type: 'bodily_injury_liability', limitCents: 10_000_000, perOccurrenceLimitCents: 30_000_000 });
    expect(byCode.MED).toMatchObject({ limitCents: 500_000, perOccurrenceLimitCents: null });
    expect(byCode.COLL).toMatchObject({ type: 'collision', limitCents: null, deductibleCents: 100_000 });
    expect(policy.source.rawValues['coverages[4].limit']).toBe('ACV');
  });

  it('flags (and does not repair) an invalid VIN while keeping the rest of the vehicle', () => {
    const policy = normalize(jordanAuto);
    expect(policy.vehicles).toEqual([
      { vin: 'JF2SKAEC6KH501234', year: 2019, make: 'Subaru', model: 'FORESTER' },
      { vin: null, year: 2021, make: 'Ford', model: 'F-150' },
    ]);
    expect(policy.source.warnings).toContainEqual(expect.objectContaining({ field: 'vehicles[1].vin', code: 'invalid_vin' }));
    expect(policy.source.rawValues['vehicles[1].vin']).toBe('1FTEW1EP0MFA4452');
    expect(policy.drivers?.map((d) => d.fullName)).toEqual(['Jordan Lee', 'Casey M Lee']);
  });

  it('handles single-object collections, empty-string collections, and absent collections', () => {
    const [motorcycle, umbrella] = CARRIER_B_POLICIES.alex as [Record<string, unknown>, Record<string, unknown>];
    expect(normalize(motorcycle)).toMatchObject({
      policyType: 'motorcycle',
      vehicles: [{ vin: '1HD1KTP19NB612903', year: 2022, make: 'Harley-Davidson', model: 'Street Glide' }],
      drivers: [{ fullName: 'Alex J Rivera' }],
    });
    const umb = normalize(umbrella);
    expect(umb.vehicles).toEqual([]); // VEH_LIST: "" -> explicitly none
    expect(umb.drivers).toBeNull(); // DRV_LIST absent -> unknown
    expect(umb.coverages).toEqual([
      { type: 'umbrella_liability', carrierCode: 'UMB', limitCents: 100_000_000, perOccurrenceLimitCents: null, deductibleCents: null },
    ]);
    expect(normalize(jordanExpired)).toMatchObject({ status: 'expired', drivers: null, premium: { amountCents: 119_910 } });
  });

  it('maps unknown line-of-business and status codes to other/unknown', () => {
    const policy = normalize(jordanBoat);
    expect(policy).toMatchObject({ policyType: 'other', status: 'unknown', coverages: null, vehicles: null });
    expect(policy.source.rawValues).toMatchObject({ policyType: 'BOAT', status: 'Z' });
  });

  it('nulls an impossible date and an unparseable premium, with warnings, instead of failing the record', () => {
    const policy = normalize(CARRIER_B_POLICIES.sam[0] as Record<string, unknown>);
    expect(policy).toMatchObject({ status: 'cancelled', effectiveDate: null, expirationDate: '2026-02-28', premium: null });
    expect(policy.source.rawValues).toMatchObject({ status: 'L', effectiveDate: '02/30/2025', 'premium.amount': 'TBD' });
    expect(codes(policy)).toEqual(expect.arrayContaining(['invalid_date', 'invalid_amount']));
    expect(policy.coverages?.[0]).toMatchObject({ type: 'dwelling', limitCents: 38_500_000, deductibleCents: 250_000 });
  });

  it('rejects records without POL_NBR', () => {
    expect(() => normalize(jordanNoId)).toThrow(RecordRejectedError);
  });
});

describe('Carrier C normalizer (scraped portal strings)', () => {
  const base: RawPortalPolicy = {
    summary: {
      'Policy Number': 'CP-A-88120',
      Product: 'Auto Insurance',
      Status: 'In Force',
      'Policy Period': 'May 12, 2026 – Nov 12, 2026',
      Premium: '$588.10 every 6 months',
      'Named Insured': 'Alex Rivera',
    },
    coverages: [
      { name: 'Bodily Injury Liability', limit: '$250,000 / $500,000', deductible: '—' },
      { name: 'Collision', limit: 'Actual Cash Value', deductible: '$1,000' },
      { name: 'Roadside Assistance', limit: 'Included', deductible: '—' },
    ],
    vehicles: [{ description: '2021 Mazda CX-5', vin: 'VIN: JM1BPBDLXM1301122' }],
    drivers: ['Alex Rivera'],
  };
  const normalize = (raw: RawPortalPolicy) => normalizeCarrierCPolicy(raw, meta('carrier-c', 'browser'));

  it('parses display strings: date ranges, premium phrases, split limits, and vehicles', () => {
    const policy = normalize(base);
    expect(NormalizedPolicySchema.parse(policy)).toEqual(policy);
    expect(policy).toMatchObject({
      externalPolicyId: 'CP-A-88120',
      policyType: 'auto',
      status: 'active',
      effectiveDate: '2026-05-12',
      expirationDate: '2026-11-12',
      premium: { amountCents: 58_810, currency: 'USD', term: 'semi_annual' },
      vehicles: [{ vin: 'JM1BPBDLXM1301122', year: 2021, make: 'Mazda', model: 'CX-5' }],
      drivers: [{ fullName: 'Alex Rivera', firstName: 'Alex', lastName: 'Rivera' }],
    });
    expect(policy.coverages).toEqual([
      { type: 'bodily_injury_liability', carrierCode: 'Bodily Injury Liability', limitCents: 25_000_000, perOccurrenceLimitCents: 50_000_000, deductibleCents: null },
      { type: 'collision', carrierCode: 'Collision', limitCents: null, perOccurrenceLimitCents: null, deductibleCents: 100_000 },
      { type: 'roadside_assistance', carrierCode: 'Roadside Assistance', limitCents: null, perOccurrenceLimitCents: null, deductibleCents: null },
    ]);
    expect(policy.source.warnings).toEqual([]);
  });

  it('represents hidden sections as null and "Not available" premiums as null with a warning', () => {
    const policy = normalize({ ...base, summary: { ...base.summary, Premium: 'Not available' }, vehicles: null, drivers: null });
    expect(policy).toMatchObject({ premium: null, vehicles: null, drivers: null });
    expect(codes(policy)).toEqual(['missing_field']);
  });

  it('maps premium phrases to terms and keeps the amount when the phrase is unknown', () => {
    expect(normalize({ ...base, summary: { ...base.summary, Premium: '$97.40 per month' } }).premium?.term).toBe('monthly');
    const odd = normalize({ ...base, summary: { ...base.summary, Premium: '$40.00 per fortnight' } });
    expect(odd.premium).toEqual({ amountCents: 4000, currency: 'USD', term: null });
    expect(codes(odd)).toEqual(['unmapped_value']);
  });

  it('maps lapsed to cancelled and rejects pages without a policy number', () => {
    expect(normalize({ ...base, summary: { ...base.summary, Status: 'Lapsed' } }).status).toBe('cancelled');
    const { ['Policy Number']: _omit, ...rest } = base.summary;
    expect(() => normalize({ ...base, summary: rest })).toThrow(RecordRejectedError);
  });
});
