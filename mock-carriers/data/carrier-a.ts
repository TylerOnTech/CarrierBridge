import type { PersonaKey } from './personas.js';

/** Carrier A ("modern REST") native policy representation, as served by GET /v1/policies/:id. */
export interface CarrierAMoney {
  amount: string;
  currency: string;
}

export interface CarrierAPolicyRecord {
  policyNumber: string;
  lineOfBusiness: string;
  status: string;
  term: { effectiveDate: string; expirationDate: string; lengthMonths: number };
  premium?: { total: CarrierAMoney };
  insured: { givenName: string; familyName: string };
  coverages: Array<{
    code: string;
    limit?: { perPerson?: CarrierAMoney; perOccurrence?: CarrierAMoney; amount?: CarrierAMoney } | null;
    deductible?: CarrierAMoney | null;
  }>;
  vehicles?: Array<{ vin: string; year: number; make: string; model: string }>;
  drivers?: Array<{ givenName: string; familyName: string; relationship: string }>;
  updatedAt: string;
}

const usd = (amount: string): CarrierAMoney => ({ amount, currency: 'USD' });

export const CARRIER_A_POLICIES: Record<PersonaKey, CarrierAPolicyRecord[]> = {
  alex: [
    {
      policyNumber: 'APX-AUTO-100234',
      lineOfBusiness: 'PERSONAL_AUTO',
      status: 'IN_FORCE',
      term: { effectiveDate: '2026-03-01', expirationDate: '2026-09-01', lengthMonths: 6 },
      premium: { total: usd('642.18') },
      insured: { givenName: 'Alex', familyName: 'Rivera' },
      coverages: [
        { code: 'BODILY_INJURY', limit: { perPerson: usd('100000.00'), perOccurrence: usd('300000.00') } },
        { code: 'PROPERTY_DAMAGE', limit: { amount: usd('100000.00') } },
        { code: 'UNINSURED_MOTORIST', limit: { perPerson: usd('100000.00'), perOccurrence: usd('300000.00') } },
        { code: 'COLLISION', deductible: usd('500.00') },
        { code: 'COMPREHENSIVE', deductible: usd('250.00') },
      ],
      vehicles: [
        { vin: '2T3P1RFV3MW123456', year: 2021, make: 'Toyota', model: 'RAV4' },
        { vin: '5YJ3E1EA2NF204118', year: 2022, make: 'Tesla', model: 'Model 3' },
      ],
      drivers: [
        { givenName: 'Alex', familyName: 'Rivera', relationship: 'PRIMARY' },
        { givenName: 'Morgan', familyName: 'Rivera', relationship: 'SPOUSE' },
      ],
      updatedAt: '2026-03-01T08:15:00Z',
    },
    {
      policyNumber: 'APX-HOME-200871',
      lineOfBusiness: 'HOMEOWNERS',
      status: 'IN_FORCE',
      term: { effectiveDate: '2025-11-15', expirationDate: '2026-11-15', lengthMonths: 12 },
      premium: { total: usd('1318.00') },
      insured: { givenName: 'Alex', familyName: 'Rivera' },
      coverages: [
        { code: 'DWELLING', limit: { amount: usd('450000.00') }, deductible: usd('1000.00') },
        { code: 'OTHER_STRUCTURES', limit: { amount: usd('45000.00') }, deductible: usd('1000.00') },
        { code: 'PERSONAL_PROPERTY', limit: { amount: usd('225000.00') }, deductible: usd('1000.00') },
        { code: 'LOSS_OF_USE', limit: { amount: usd('90000.00') } },
        { code: 'PERSONAL_LIABILITY', limit: { amount: usd('300000.00') } },
      ],
      vehicles: [],
      drivers: [],
      updatedAt: '2025-11-15T12:00:00Z',
    },
    {
      policyNumber: 'APX-AUTO-099120',
      lineOfBusiness: 'PERSONAL_AUTO',
      status: 'EXPIRED',
      term: { effectiveDate: '2025-03-01', expirationDate: '2025-09-01', lengthMonths: 6 },
      premium: { total: usd('598.40') },
      insured: { givenName: 'Alex', familyName: 'Rivera' },
      coverages: [{ code: 'BODILY_INJURY', limit: { perPerson: usd('50000.00'), perOccurrence: usd('100000.00') } }],
      vehicles: [{ vin: '2T3P1RFV3MW123456', year: 2021, make: 'Toyota', model: 'RAV4' }],
      drivers: [{ givenName: 'Alex', familyName: 'Rivera', relationship: 'PRIMARY' }],
      updatedAt: '2025-09-01T00:00:00Z',
    },
  ],
  jordan: [
    {
      // Renters policy: the API omits `vehicles` and `drivers` entirely (not applicable).
      policyNumber: 'APX-RENT-300456',
      lineOfBusiness: 'RENTERS',
      status: 'IN_FORCE',
      term: { effectiveDate: '2026-01-10', expirationDate: '2027-01-10', lengthMonths: 12 },
      premium: { total: usd('186.00') },
      insured: { givenName: 'Jordan', familyName: 'Lee' },
      coverages: [
        { code: 'PERSONAL_PROPERTY', limit: { amount: usd('30000.00') }, deductible: usd('500.00') },
        { code: 'PERSONAL_LIABILITY', limit: { amount: usd('100000.00') } },
      ],
      updatedAt: '2026-01-10T09:30:00Z',
    },
  ],
  sam: [
    {
      policyNumber: 'APX-AUTO-100877',
      lineOfBusiness: 'PERSONAL_AUTO',
      status: 'PENDING_ACTIVATION',
      term: { effectiveDate: '2026-11-01', expirationDate: '2027-05-01', lengthMonths: 6 },
      premium: { total: usd('731.92') },
      insured: { givenName: 'Sam', familyName: 'Patel' },
      coverages: [
        { code: 'BODILY_INJURY', limit: { perPerson: usd('50000.00'), perOccurrence: usd('100000.00') } },
        { code: 'PROPERTY_DAMAGE', limit: { amount: usd('50000.00') } },
        // A carrier-specific endorsement with no contract equivalent -> type "other".
        { code: 'ACCIDENT_FORGIVENESS', limit: null },
      ],
      vehicles: [{ vin: '1HGCV1F37LA012345', year: 2020, make: 'Honda', model: 'Accord' }],
      drivers: [{ givenName: 'Sam', familyName: 'Patel', relationship: 'PRIMARY' }],
      updatedAt: '2026-10-20T16:45:00Z',
    },
    {
      policyNumber: 'APX-UMB-400112',
      lineOfBusiness: 'PERSONAL_UMBRELLA',
      status: 'CANCELLED',
      term: { effectiveDate: '2025-06-01', expirationDate: '2026-06-01', lengthMonths: 12 },
      premium: { total: usd('289.00') },
      insured: { givenName: 'Sam', familyName: 'Patel' },
      coverages: [{ code: 'UMBRELLA_LIABILITY', limit: { amount: usd('1000000.00') } }],
      updatedAt: '2025-12-02T10:00:00Z',
    },
  ],
};
