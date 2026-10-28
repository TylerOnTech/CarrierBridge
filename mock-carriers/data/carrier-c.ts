import type { PersonaKey } from './personas.js';

/**
 * Carrier C ("browser-only portal") policies in display form: these are the strings
 * the portal renders into HTML. Optional sections (vehicles, drivers) are omitted from
 * the page entirely when undefined, mirroring real portals that hide empty panels.
 */
export interface PortalPolicy {
  policyNumber: string;
  product: string;
  status: string;
  periodStart: string;
  periodEnd: string;
  /** e.g. "$588.10 every 6 months"; null renders "Not available". */
  premium: string | null;
  namedInsured: string;
  coverages: Array<{ name: string; limit: string; deductible: string }>;
  vehicles?: Array<{ year: number; make: string; model: string; vin: string }>;
  drivers?: string[];
}

export const CARRIER_C_POLICIES: Record<PersonaKey, PortalPolicy[]> = {
  alex: [
    {
      policyNumber: 'CP-A-88120',
      product: 'Auto Insurance',
      status: 'In Force',
      periodStart: 'May 12, 2026',
      periodEnd: 'Nov 12, 2026',
      premium: '$588.10 every 6 months',
      namedInsured: 'Alex Rivera',
      coverages: [
        { name: 'Bodily Injury Liability', limit: '$250,000 / $500,000', deductible: '—' },
        { name: 'Property Damage Liability', limit: '$100,000', deductible: '—' },
        { name: 'Collision', limit: 'Actual Cash Value', deductible: '$1,000' },
        { name: 'Comprehensive', limit: 'Actual Cash Value', deductible: '$500' },
        { name: 'Roadside Assistance', limit: 'Included', deductible: '—' },
      ],
      vehicles: [{ year: 2021, make: 'Mazda', model: 'CX-5', vin: 'JM1BPBDLXM1301122' }],
      drivers: ['Alex Rivera'],
    },
    {
      policyNumber: 'CP-C-55021',
      product: 'Condo Insurance',
      status: 'In Force',
      periodStart: 'Feb 1, 2026',
      periodEnd: 'Feb 1, 2027',
      premium: null,
      namedInsured: 'Alex Rivera',
      coverages: [
        { name: 'Walls-In Coverage', limit: '$60,000', deductible: '$1,000' },
        { name: 'Personal Property', limit: '$40,000', deductible: '$1,000' },
        { name: 'Personal Liability', limit: '$300,000', deductible: '—' },
      ],
    },
    {
      policyNumber: 'CP-A-77002',
      product: 'Auto Insurance',
      status: 'Expired',
      periodStart: 'May 12, 2025',
      periodEnd: 'Nov 12, 2025',
      premium: '$561.75 every 6 months',
      namedInsured: 'Alex Rivera',
      coverages: [{ name: 'Bodily Injury Liability', limit: '$100,000 / $300,000', deductible: '—' }],
      vehicles: [{ year: 2021, make: 'Mazda', model: 'CX-5', vin: 'JM1BPBDLXM1301122' }],
    },
  ],
  jordan: [
    {
      policyNumber: 'CP-A-91003',
      product: 'Auto Insurance',
      status: 'Pending',
      periodStart: 'Dec 1, 2026',
      periodEnd: 'Jun 1, 2027',
      premium: '$97.40 per month',
      namedInsured: 'Jordan Lee',
      coverages: [
        { name: 'Bodily Injury Liability', limit: '$100,000 / $300,000', deductible: '—' },
        { name: 'Property Damage Liability', limit: '$100,000', deductible: '—' },
        { name: 'Collision', limit: 'Actual Cash Value', deductible: '$500' },
      ],
      vehicles: [{ year: 2019, make: 'Volkswagen', model: 'Jetta', vin: '3VWC57BUXKM098765' }],
      drivers: ['Jordan Lee'],
    },
  ],
  sam: [
    {
      policyNumber: 'CP-R-40017',
      product: 'Renters Insurance',
      status: 'Cancelled',
      periodStart: 'Sep 1, 2025',
      periodEnd: 'Sep 1, 2026',
      premium: '$164.00 per year',
      namedInsured: 'Sam Patel',
      coverages: [
        { name: 'Personal Property', limit: '$25,000', deductible: '$500' },
        { name: 'Personal Liability', limit: '$100,000', deductible: '—' },
      ],
    },
    {
      policyNumber: 'CP-A-40018',
      product: 'Auto Insurance',
      status: 'In Force',
      periodStart: 'Apr 1, 2026',
      periodEnd: 'Oct 1, 2026',
      premium: '$702.33 every 6 months',
      namedInsured: 'Sam Patel',
      coverages: [
        { name: 'Bodily Injury Liability', limit: '$50,000 / $100,000', deductible: '—' },
        { name: 'Property Damage Liability', limit: '$50,000', deductible: '—' },
      ],
      vehicles: [{ year: 2022, make: 'Kia', model: 'Telluride', vin: 'KNDJ23AU9N7123456' }],
      drivers: ['Sam Patel', 'Priya Patel'],
    },
  ],
};
