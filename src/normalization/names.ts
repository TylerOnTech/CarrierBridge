import type { PersonName } from '../contracts/index.js';

const SUFFIXES = new Set(['JR', 'JR.', 'SR', 'SR.', 'II', 'III', 'IV']);

/**
 * Legacy systems often store names in ALL CAPS. We title-case only all-caps input and
 * leave mixed-case input untouched, so "McDonald" from a modern API is never mangled.
 */
export function smartCase(value: string): string {
  const s = value.trim().replace(/\s+/g, ' ');
  if (s !== s.toUpperCase() || !/[A-Z]/.test(s)) return s;
  return s
    .toLowerCase()
    .replace(/(^|[\s'-])([a-z])/g, (_m, sep: string, ch: string) => sep + ch.toUpperCase())
    .replace(/\b(Ii|Iii|Iv)\b/g, (m) => m.toUpperCase());
}

function build(first: string | null, last: string | null, suffix: string | null = null): PersonName | null {
  const fullName = [first, last, suffix].filter(Boolean).join(' ');
  if (!fullName) return null;
  return { fullName, firstName: first || null, lastName: last || null };
}

/** From separate given/family name fields. */
export function nameFromParts(first: string | null | undefined, last: string | null | undefined): PersonName | null {
  return build(first ? smartCase(first) : null, last ? smartCase(last) : null);
}

/**
 * From a single display string, either "First Middle Last" or "LAST, FIRST MIDDLE".
 * When a single token is given we cannot tell first from last, so both stay null.
 */
export function nameFromFull(raw: string): PersonName | null {
  const value = smartCase(raw);
  if (!value) return null;

  if (value.includes(',')) {
    const [last = '', ...rest] = value.split(',');
    return build(rest.join(',').trim() || null, last.trim() || null);
  }

  const tokens = value.split(' ');
  let suffix: string | null = null;
  if (tokens.length > 2 && SUFFIXES.has((tokens.at(-1) ?? '').toUpperCase())) suffix = tokens.pop() ?? null;
  if (tokens.length === 1) return { fullName: value, firstName: null, lastName: null };
  const last = tokens.pop() ?? null;
  return build(tokens.join(' '), last, suffix);
}
