import { describe, expect, it } from 'vitest';
import {
  computeVinCheckDigit,
  FieldNormalizer,
  isBlank,
  nameFromFull,
  nameFromParts,
  normalizeMake,
  normalizeVin,
  parseCalendarDate,
  parseMoneyToCents,
  termFromMonths,
  thousandsToCents,
} from '../../src/normalization/index.js';

describe('parseCalendarDate', () => {
  it.each([
    ['2025-03-01', ['iso'], '2025-03-01'],
    ['2025-03-01T23:30:00-08:00', ['iso'], '2025-03-01'],
    ['03/15/2025', ['mdy_slash'], '2025-03-15'],
    ['3/5/2025', ['mdy_slash'], '2025-03-05'],
    ['20250915', ['ymd_compact'], '2025-09-15'],
    ['Jan 5, 2025', ['month_name'], '2025-01-05'],
    ['January 5, 2025', ['month_name'], '2025-01-05'],
    ['Sept 30, 2025', ['month_name'], '2025-09-30'],
    ['  2024-02-29 ', ['iso'], '2024-02-29'],
  ] as const)('parses %s', (input, formats, expected) => {
    expect(parseCalendarDate(input, formats)).toBe(expected);
  });

  it.each([
    ['02/30/2024', ['mdy_slash']],
    ['2023-02-29', ['iso']],
    ['13/01/2025', ['mdy_slash']],
    ['2025-00-10', ['iso']],
    ['20251301', ['ymd_compact']],
    ['Foo 5, 2025', ['month_name']],
    ['', ['iso']],
  ] as const)('rejects impossible or malformed date %s', (input, formats) => {
    expect(parseCalendarDate(input, formats)).toBeNull();
  });

  it('only accepts formats the caller allows (no guessing)', () => {
    expect(parseCalendarDate('03/15/2025', ['iso'])).toBeNull();
    expect(parseCalendarDate('20250315', ['mdy_slash', 'ymd_compact'])).toBe('2025-03-15');
  });

  it('is independent of the process time zone', () => {
    const original = process.env.TZ;
    process.env.TZ = 'Pacific/Kiritimati';
    try {
      expect(parseCalendarDate('2025-03-01', ['iso'])).toBe('2025-03-01');
    } finally {
      process.env.TZ = original;
    }
  });
});

describe('parseMoneyToCents', () => {
  it.each([
    ['$1,234.50', 123450],
    ['1234.5', 123450],
    ['USD 1,234.56', 123456],
    ['1,234 USD', 123400],
    ['$0.99', 99],
    ['1,000,000.00', 100000000],
    [1234.56, 123456],
    [0.1 + 0.2, 30],
    [0, 0],
  ])('parses %s', (input, cents) => {
    expect(parseMoneyToCents(input)).toEqual({ ok: true, cents });
  });

  it.each(['1,23,4.00', '12.345', '-5.00', '(5.00)', 'TBD', '$', '', '1.2.3', 12.345, Number.NaN, -1, null, {}])(
    'rejects %s instead of guessing',
    (input) => {
      expect(parseMoneyToCents(input).ok).toBe(false);
    },
  );

  it('converts thousands-denominated limits', () => {
    expect(thousandsToCents('100')).toBe(10_000_000);
    expect(thousandsToCents('1000')).toBe(100_000_000);
    expect(thousandsToCents('ACV')).toBeNull();
  });
});

describe('names', () => {
  it('parses LAST, FIRST legacy format and title-cases all-caps input', () => {
    expect(nameFromFull('RIVERA, ALEX J')).toEqual({ fullName: 'Alex J Rivera', firstName: 'Alex J', lastName: 'Rivera' });
    expect(nameFromFull("O'BRIEN, SEAN")).toEqual({ fullName: "Sean O'Brien", firstName: 'Sean', lastName: "O'Brien" });
    expect(nameFromFull('SMITH-JONES, ANNA')?.lastName).toBe('Smith-Jones');
  });

  it('parses First Last and keeps generational suffixes out of the surname', () => {
    expect(nameFromFull('Jordan Lee')).toEqual({ fullName: 'Jordan Lee', firstName: 'Jordan', lastName: 'Lee' });
    expect(nameFromFull('Robert Downey Jr')).toEqual({ fullName: 'Robert Downey Jr', firstName: 'Robert', lastName: 'Downey' });
    expect(nameFromFull('JOHN SMITH III')?.fullName).toBe('John Smith III');
  });

  it('never mangles mixed-case input and does not guess single tokens', () => {
    expect(nameFromParts('Ronald', 'McDonald')).toEqual({ fullName: 'Ronald McDonald', firstName: 'Ronald', lastName: 'McDonald' });
    expect(nameFromFull('Cher')).toEqual({ fullName: 'Cher', firstName: null, lastName: null });
    expect(nameFromFull('   ')).toBeNull();
    expect(nameFromParts(null, undefined)).toBeNull();
  });
});

describe('vehicles', () => {
  it('computes the ISO 3779 check digit', () => {
    expect(computeVinCheckDigit('1M8GDM9AXKP042788')).toBe('X');
    expect(computeVinCheckDigit('2T3P1RFV3MW123456')).toBe('3');
  });

  it('normalizes case and separators', () => {
    expect(normalizeVin('1m8gdm9a-xkp042788')).toEqual({ vin: '1M8GDM9AXKP042788' });
  });

  it('rejects structurally invalid VINs rather than repairing them', () => {
    expect(normalizeVin('1FTEW1EP0MFA4452')).toEqual({ vin: null, issue: 'invalid_vin' });
    expect(normalizeVin('1M8GDM9AXKP04278O')).toEqual({ vin: null, issue: 'invalid_vin' }); // contains O
  });

  it('keeps a VIN with a bad check digit but flags it', () => {
    expect(normalizeVin('1M8GDM9A1KP042788')).toEqual({ vin: '1M8GDM9A1KP042788', issue: 'check_digit_mismatch' });
  });

  it('canonicalizes known makes and passes unknown ones through', () => {
    expect(normalizeMake('TOYOTA')).toBe('Toyota');
    expect(normalizeMake('chevy')).toBe('Chevrolet');
    expect(normalizeMake('bmw')).toBe('BMW');
    expect(normalizeMake('  Rivian ')).toBe('Rivian');
  });
});

describe('FieldNormalizer', () => {
  it('returns null without a warning for missing optional fields', () => {
    const n = new FieldNormalizer();
    expect(n.date('expirationDate', undefined, ['iso'])).toBeNull();
    expect(n.money('premium', 'N/A')).toBeNull();
    expect(n.warnings).toEqual([]);
  });

  it('warns when a required field is missing', () => {
    const n = new FieldNormalizer();
    expect(n.date('effectiveDate', '', ['iso'], { required: true })).toBeNull();
    expect(n.warnings).toEqual([expect.objectContaining({ field: 'effectiveDate', code: 'missing_field' })]);
  });

  it('records the raw value and a warning for unparseable values', () => {
    const n = new FieldNormalizer();
    expect(n.date('effectiveDate', '02/30/2025', ['mdy_slash'])).toBeNull();
    expect(n.money('premium.amount', 'TBD')).toBeNull();
    expect(n.rawValues).toEqual({ effectiveDate: '02/30/2025', 'premium.amount': 'TBD' });
    expect(n.warnings.map((w) => w.code)).toEqual(['invalid_date', 'invalid_amount']);
  });

  it('maps enums case-insensitively, preserving raw codes and falling back explicitly', () => {
    const n = new FieldNormalizer();
    const mapping: Record<string, 'active' | 'cancelled' | 'unknown'> = { A: 'active', C: 'cancelled' };
    expect(n.enumValue('status', 'a', mapping, 'unknown')).toBe('active');
    expect(n.enumValue('status2', 'Z', mapping, 'unknown')).toBe('unknown');
    expect(n.rawValues).toEqual({ status: 'a', status2: 'Z' });
    expect(n.warnings).toEqual([expect.objectContaining({ field: 'status2', code: 'unmapped_value' })]);
  });

  it('treats placeholder tokens as blank', () => {
    for (const v of [null, undefined, '', '  ', 'N/A', 'null', '-', '—']) expect(isBlank(v)).toBe(true);
    for (const v of ['0', 0, 'NONE', 'ACV']) expect(isBlank(v)).toBe(false);
  });

  it('maps term lengths to premium terms', () => {
    expect([1, 3, 6, 12, 9, null].map(termFromMonths)).toEqual(['monthly', 'quarterly', 'semi_annual', 'annual', null, null]);
  });
});
