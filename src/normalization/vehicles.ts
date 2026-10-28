const VIN_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/;
const TRANSLITERATION: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5,
  P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

export function computeVinCheckDigit(vin: string): string {
  const sum = [...vin].reduce((acc, ch, i) => {
    const value = /\d/.test(ch) ? Number(ch) : (TRANSLITERATION[ch] ?? 0);
    return acc + value * (WEIGHTS[i] ?? 0);
  }, 0);
  const remainder = sum % 11;
  return remainder === 10 ? 'X' : String(remainder);
}

export type VinResult =
  | { vin: string; issue?: 'check_digit_mismatch' }
  | { vin: null; issue: 'invalid_vin' };

/**
 * Normalizes case and separators, then validates structure. A failed check digit is
 * reported but the VIN is kept: non-North-American VINs legitimately skip the check digit,
 * and dropping a plausible VIN would lose real data.
 */
export function normalizeVin(raw: string): VinResult {
  const vin = raw.toUpperCase().replace(/[\s-]/g, '');
  if (!VIN_PATTERN.test(vin)) return { vin: null, issue: 'invalid_vin' };
  if (computeVinCheckDigit(vin) !== vin[8]) return { vin, issue: 'check_digit_mismatch' };
  return { vin };
}

const MAKES: Record<string, string> = {
  ACURA: 'Acura', AUDI: 'Audi', BMW: 'BMW', BUICK: 'Buick', CHEVROLET: 'Chevrolet', CHEVY: 'Chevrolet',
  CHRYSLER: 'Chrysler', DODGE: 'Dodge', FORD: 'Ford', GMC: 'GMC', HONDA: 'Honda', HYUNDAI: 'Hyundai',
  JEEP: 'Jeep', KIA: 'Kia', LEXUS: 'Lexus', MAZDA: 'Mazda', 'MERCEDES-BENZ': 'Mercedes-Benz',
  MERCEDES: 'Mercedes-Benz', NISSAN: 'Nissan', RAM: 'Ram', SUBARU: 'Subaru', TESLA: 'Tesla',
  TOYOTA: 'Toyota', VOLKSWAGEN: 'Volkswagen', VW: 'Volkswagen', VOLVO: 'Volvo', 'HARLEY-DAVIDSON': 'Harley-Davidson',
  HARLEY: 'Harley-Davidson', YAMAHA: 'Yamaha', KAWASAKI: 'Kawasaki',
};

/** Canonicalizes well-known makes; unknown makes pass through trimmed and otherwise untouched. */
export function normalizeMake(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  return MAKES[trimmed.toUpperCase()] ?? trimmed;
}
