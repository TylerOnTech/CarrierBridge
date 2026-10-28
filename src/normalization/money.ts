/**
 * Money parsing into integer cents without floating-point arithmetic on strings.
 * Accepts "$1,234.50", "1234.5", "USD 1,234.50", "1,234 USD", and finite JS numbers.
 * Rejects negatives, sub-cent precision, malformed thousands separators, and
 * anything else rather than guessing.
 */
export type MoneyParseResult = { ok: true; cents: number } | { ok: false; reason: string };

const STRICT_THOUSANDS = /^\d{1,3}(,\d{3})+(\.\d{1,2})?$/;
const PLAIN = /^\d+(\.\d{1,2})?$/;

export function parseMoneyToCents(raw: unknown): MoneyParseResult {
  if (typeof raw === 'number') return fromNumber(raw);
  if (typeof raw !== 'string') return { ok: false, reason: `unsupported type ${typeof raw}` };

  const stripped = raw
    .trim()
    .replace(/^(USD|US\$|\$)\s*/i, '')
    .replace(/\s*USD$/i, '')
    .trim();

  if (stripped.startsWith('-') || stripped.startsWith('(')) return { ok: false, reason: 'negative amount' };
  if (!STRICT_THOUSANDS.test(stripped) && !PLAIN.test(stripped)) {
    return { ok: false, reason: 'not a monetary amount' };
  }

  const [whole = '0', fraction = ''] = stripped.replace(/,/g, '').split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) return { ok: false, reason: 'amount out of range' };
  return { ok: true, cents };
}

function fromNumber(value: number): MoneyParseResult {
  if (!Number.isFinite(value)) return { ok: false, reason: 'non-finite number' };
  if (value < 0) return { ok: false, reason: 'negative amount' };
  const scaled = value * 100;
  const cents = Math.round(scaled);
  // Tolerate representation error (0.1 + 0.2) but not genuine sub-cent values (12.345).
  if (Math.abs(scaled - cents) > 1e-6) return { ok: false, reason: 'sub-cent precision' };
  if (!Number.isSafeInteger(cents)) return { ok: false, reason: 'amount out of range' };
  return { ok: true, cents };
}

/** Whole-dollar convenience used for limits expressed in thousands ("100" => $100,000). */
export function thousandsToCents(raw: string): number | null {
  const s = raw.trim();
  if (!/^\d{1,6}$/.test(s)) return null;
  return Number(s) * 1000 * 100;
}
