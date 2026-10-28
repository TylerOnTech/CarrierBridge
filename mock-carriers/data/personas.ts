/**
 * Synthetic personas shared by all three mock carriers. Every name, credential, VIN,
 * and policy number in this directory is fictional and exists only for local testing.
 * Emails use the IANA-reserved example.com domain.
 */
export const PERSONAS = {
  alex: {
    fullName: 'Alex Rivera',
    carrierA: { username: 'alex.rivera@example.com', password: 'apex-demo-1' },
    carrierB: { username: 'ARIVERA', password: 'Legacy#2024' },
    carrierC: { username: 'arivera', password: 'portal-demo-1' },
  },
  jordan: {
    fullName: 'Jordan Lee',
    carrierA: { username: 'jordan.lee@example.com', password: 'apex-demo-2' },
    carrierB: { username: 'JLEE', password: 'Legacy#2025' },
    carrierC: { username: 'jlee', password: 'portal-demo-2' },
  },
  sam: {
    fullName: 'Sam Patel',
    carrierA: { username: 'sam.patel@example.com', password: 'apex-demo-3' },
    carrierB: { username: 'SPATEL', password: 'Legacy#2026' },
    carrierC: { username: 'spatel', password: 'portal-demo-3' },
  },
} as const;

export type PersonaKey = keyof typeof PERSONAS;
