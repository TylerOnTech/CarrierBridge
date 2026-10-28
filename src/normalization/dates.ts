/**
 * Calendar-date parsing. Policy effective/expiration dates are *dates*, not instants:
 * converting "2025-03-01" through a JS Date in a non-UTC zone can silently shift it
 * to Feb 28. Everything here works on integer year/month/day and emits YYYY-MM-DD.
 */
export type DateFormat =
  /** 2025-03-01 (a trailing time component is ignored: the carrier's calendar date is kept) */
  | 'iso'
  /** 03/01/2025 or 3/1/2025 (US month-first) */
  | 'mdy_slash'
  /** 20250301 */
  | 'ymd_compact'
  /** Mar 1, 2025 / March 1, 2025 */
  | 'month_name';

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

type Ymd = [year: number, month: number, day: number];

const PARSERS: Record<DateFormat, (s: string) => Ymd | undefined> = {
  iso: (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(s);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
  },
  mdy_slash: (s) => {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    return m ? [Number(m[3]), Number(m[1]), Number(m[2])] : undefined;
  },
  ymd_compact: (s) => {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
  },
  month_name: (s) => {
    const m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
    if (!m) return undefined;
    const month = MONTHS[(m[1] ?? '').toLowerCase()];
    return month ? [Number(m[3]), month, Number(m[2])] : undefined;
  },
};

export function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || year < 1900 || year > 2200) return false;
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Number.isInteger(day) && day >= 1 && day <= daysInMonth;
}

/**
 * Parses `raw` using the first matching format. Returns null when no format matches or the
 * date does not exist (e.g. 02/30/2024). Formats are tried in order, so callers should list
 * only the formats a carrier is documented to use; ambiguous inputs are not guessed.
 */
export function parseCalendarDate(raw: string, formats: readonly DateFormat[]): string | null {
  const input = raw.trim();
  for (const format of formats) {
    const ymd = PARSERS[format](input);
    if (!ymd) continue;
    const [y, m, d] = ymd;
    if (!isValidCalendarDate(y, m, d)) return null;
    return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
}
