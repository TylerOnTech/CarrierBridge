import type { NormalizationWarning, PremiumTerm } from '../contracts/index.js';
import { type DateFormat, parseCalendarDate } from './dates.js';
import { parseMoneyToCents } from './money.js';

type RawScalar = string | number | boolean | null;

const BLANK_TOKENS = new Set(['', 'N/A', 'NA', 'NULL', '-', '—', '–']);

/** Renders an unknown raw value for messages without "[object Object]". */
export function describeRaw(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? String(value as undefined);
}

/** True for values that carry no information: null/undefined, empty, or placeholder tokens. */
export function isBlank(value: unknown): value is null | undefined | '' {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return BLANK_TOKENS.has(value.trim().toUpperCase());
  return false;
}

interface FieldOptions {
  /** When true, a missing value is itself worth a warning. */
  required?: boolean;
}

/**
 * Per-record normalization helper. Every method follows the same rule:
 *   missing  -> null (plus a `missing_field` warning if the field is required)
 *   invalid  -> null plus an `invalid_value` warning; the raw value goes into rawValues
 *   valid    -> normalized value
 * so callers never have to choose between crashing and silently inventing data.
 */
export class FieldNormalizer {
  readonly warnings: NormalizationWarning[] = [];
  readonly rawValues: Record<string, RawScalar> = {};

  warn(field: string, code: string, message: string): void {
    this.warnings.push({ field, code, message });
  }

  raw(key: string, value: unknown): void {
    if (value === undefined) return;
    this.rawValues[key] =
      value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? value
        : JSON.stringify(value);
  }

  private missing(field: string, opts?: FieldOptions): null {
    if (opts?.required) this.warn(field, 'missing_field', `${field} was not provided by the carrier`);
    return null;
  }

  text(field: string, value: unknown, opts?: FieldOptions): string | null {
    if (isBlank(value)) return this.missing(field, opts);
    if (typeof value === 'number') return String(value);
    if (typeof value !== 'string') {
      this.warn(field, 'invalid_value', `${field} has unexpected type ${typeof value}`);
      return null;
    }
    return value.trim().replace(/\s+/g, ' ');
  }

  date(field: string, value: unknown, formats: readonly DateFormat[], opts?: FieldOptions): string | null {
    if (isBlank(value)) return this.missing(field, opts);
    const parsed = typeof value === 'string' ? parseCalendarDate(value, formats) : null;
    if (parsed === null) {
      this.raw(field, value);
      this.warn(field, 'invalid_date', `${field} is not a valid date in formats [${formats.join(', ')}]`);
    }
    return parsed;
  }

  money(field: string, value: unknown, opts?: FieldOptions): number | null {
    if (isBlank(value)) return this.missing(field, opts);
    const result = parseMoneyToCents(value);
    if (!result.ok) {
      this.raw(field, value);
      this.warn(field, 'invalid_amount', `${field} could not be parsed as money: ${result.reason}`);
      return null;
    }
    return result.cents;
  }

  integer(field: string, value: unknown, range: { min: number; max: number }, opts?: FieldOptions): number | null {
    if (isBlank(value)) return this.missing(field, opts);
    const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
    if (!Number.isInteger(n) || n < range.min || n > range.max) {
      this.raw(field, value);
      this.warn(field, 'invalid_value', `${field} must be an integer in [${range.min}, ${range.max}]`);
      return null;
    }
    return n;
  }

  /**
   * Maps a carrier code onto a contract enum via an explicit table (case-insensitive).
   * The raw code is always preserved; unmapped codes fall back (e.g. to `unknown`) with a warning.
   */
  enumValue<T extends string>(field: string, value: unknown, mapping: Readonly<Record<string, T>>, fallback: NoInfer<T>): T {
    this.raw(field, value ?? null);
    if (isBlank(value)) {
      this.warn(field, 'missing_field', `${field} was not provided by the carrier`);
      return fallback;
    }
    const key = describeRaw(value).trim().toUpperCase();
    const mapped = mapping[key];
    if (mapped === undefined) {
      this.warn(field, 'unmapped_value', `${field} value '${describeRaw(value)}' has no mapping; using '${fallback}'`);
      return fallback;
    }
    return mapped;
  }
}

export function termFromMonths(months: number | null): PremiumTerm | null {
  switch (months) {
    case 1:
      return 'monthly';
    case 3:
      return 'quarterly';
    case 6:
      return 'semi_annual';
    case 12:
      return 'annual';
    case null:
    default:
      return null;
  }
}
