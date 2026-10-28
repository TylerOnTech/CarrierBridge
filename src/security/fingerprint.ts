import { createHmac } from 'node:crypto';
import { canonicalJson } from '../lib/canonical-json.js';
import { deriveKey } from './credential-cipher.js';

/**
 * Keyed fingerprint of a request body for idempotency checks. A plain SHA-256 of a body
 * containing a password would let anyone with database access brute-force weak passwords;
 * an HMAC under a server-side key does not.
 */
export class RequestFingerprinter {
  private readonly key: Buffer;

  constructor(masterKey: Buffer) {
    this.key = deriveKey(masterKey, 'request-fingerprint');
  }

  fingerprint(body: unknown): string {
    return createHmac('sha256', this.key).update(canonicalJson(body)).digest('hex');
  }
}
