import type { PersonaKey } from './personas.js';

/**
 * Carrier B ("legacy REST") records. The JSON is produced by an XML-to-JSON bridge,
 * which is why repeated elements collapse to a single object when there is only one,
 * empty elements become "", and every scalar is a string. Limits are in thousands of
 * dollars ("100/300" = $100,000 per person / $300,000 per occurrence); deductibles are
 * whole dollars. EFF_DT and EXP_DT come from different subsystems and use different formats.
 */
export type LegacyRecord = Record<string, unknown>;

export const CARRIER_B_POLICIES: Record<PersonaKey, LegacyRecord[]> = {
  alex: [
    {
      POL_NBR: 'BL-77812-03',
      LOB_CD: 'MCYC',
      POL_STAT_CD: 'A',
      EFF_DT: '04/01/2026',
      EXP_DT: '20270401',
      TERM_MO: '12',
      TOT_PREM: '$412.00',
      INSD: { NM: 'RIVERA, ALEX J' },
      COV_LIST: {
        COV: [
          { COV_CD: 'BI', LIM: '25/50', DED: '' },
          { COV_CD: 'PD', LIM: '25', DED: '' },
          { COV_CD: 'COLL', LIM: 'ACV', DED: '500' },
        ],
      },
      VEH_LIST: { VEH: { VIN: '1HD1KTP19NB612903', YR: '2022', MAKE: 'HARLEY-DAVIDSON', MODEL: 'Street Glide' } },
      DRV_LIST: { DRV: { DRV_NM: 'RIVERA, ALEX J' } },
    },
    {
      POL_NBR: 'BL-55120-01',
      LOB_CD: 'UMB',
      POL_STAT_CD: 'A',
      EFF_DT: '01/15/2026',
      EXP_DT: '20270115',
      TERM_MO: '12',
      TOT_PREM: '$318.50',
      INSD: { NM: 'RIVERA, ALEX J' },
      COV_LIST: { COV: { COV_CD: 'UMB', LIM: '1000', DED: '' } },
      VEH_LIST: '',
    },
  ],
  jordan: [
    {
      POL_NBR: 'BL-90311-02',
      LOB_CD: 'PAUTO',
      POL_STAT_CD: 'A',
      EFF_DT: '02/01/2026',
      EXP_DT: '20260801',
      TERM_MO: '6',
      TOT_PREM: '$1,284.6',
      INSD: { NM: 'LEE, JORDAN' },
      COV_LIST: {
        COV: [
          { COV_CD: 'BI', LIM: '100/300', DED: '' },
          { COV_CD: 'PD', LIM: '100', DED: '' },
          { COV_CD: 'UM', LIM: '100/300', DED: '' },
          { COV_CD: 'MED', LIM: '5', DED: '' },
          { COV_CD: 'COLL', LIM: 'ACV', DED: '1,000' },
          { COV_CD: 'COMP', LIM: 'ACV', DED: '500' },
          { COV_CD: 'ROAD', LIM: 'INCL', DED: '' },
        ],
      },
      VEH_LIST: {
        VEH: [
          { VIN: 'JF2SKAEC6KH501234', YR: '2019', MAKE: 'SUBARU', MODEL: 'FORESTER' },
          // 16 characters: a data-entry error at the carrier. Must not be "fixed" by us.
          { VIN: '1FTEW1EP0MFA4452', YR: '2021', MAKE: 'FORD', MODEL: 'F-150' },
        ],
      },
      DRV_LIST: { DRV: [{ DRV_NM: 'LEE, JORDAN' }, { DRV_NM: 'LEE, CASEY M' }] },
    },
    {
      POL_NBR: 'BL-90311-01',
      LOB_CD: 'PAUTO',
      POL_STAT_CD: 'E',
      EFF_DT: '08/01/2025',
      EXP_DT: '20260201',
      TERM_MO: '6',
      TOT_PREM: '1199.10',
      INSD: { NM: 'LEE, JORDAN' },
      COV_LIST: { COV: { COV_CD: 'BI', LIM: '100/300', DED: '' } },
      VEH_LIST: { VEH: { VIN: 'JF2SKAEC6KH501234', YR: '2019', MAKE: 'SUBARU', MODEL: 'FORESTER' } },
    },
    {
      // Unknown line of business and status code: must map to other/unknown, keeping raw codes.
      POL_NBR: 'BL-90311-05',
      LOB_CD: 'BOAT',
      POL_STAT_CD: 'Z',
      EFF_DT: '05/01/2026',
      EXP_DT: '20270501',
      TERM_MO: '12',
      TOT_PREM: '$240.00',
      INSD: { NM: 'LEE, JORDAN' },
    },
    {
      // No policy number: cannot be identified, so the record is rejected (with a warning).
      LOB_CD: 'PAUTO',
      POL_STAT_CD: 'A',
      EFF_DT: '03/01/2026',
      EXP_DT: '20260901',
      INSD: { NM: 'LEE, JORDAN' },
    },
  ],
  sam: [
    {
      // Sam has exactly one policy, so the XML bridge emits PolicyList.Policy as an object.
      POL_NBR: 'BL-61001-07',
      LOB_CD: 'HOME',
      POL_STAT_CD: 'L',
      EFF_DT: '02/30/2025',
      EXP_DT: '20260228',
      TERM_MO: '12',
      TOT_PREM: 'TBD',
      INSD: { NM: 'PATEL, SAM' },
      COV_LIST: {
        COV: [
          { COV_CD: 'DWELL', LIM: '385', DED: '2,500' },
          { COV_CD: 'PERS_PROP', LIM: '190', DED: '2,500' },
          { COV_CD: 'LIAB', LIM: '300', DED: '' },
        ],
      },
    },
  ],
};
