import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';

/** Derives purpose-specific subkeys so one master key is never used for two different jobs. */
export function deriveKey(masterKey: Buffer, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), `carrierbridge:${purpose}`, 32));
}

/**
 * Seals carrier credentials while they wait in the queue.
 *
 * AES-256-GCM gives confidentiality plus tamper detection. The task ID is bound in as
 * additional authenticated data, so a ciphertext copied onto another task row will not
 * decrypt. The `v1.` prefix leaves room for key rotation. Ciphertexts are deleted as soon
 * as a task reaches a terminal state, so credentials exist at rest only while needed.
 */
export class CredentialCipher {
  private readonly key: Buffer;

  constructor(masterKey: Buffer) {
    if (masterKey.length !== 32) throw new Error('credential encryption key must be 32 bytes');
    this.key = deriveKey(masterKey, 'credentials');
  }

  seal(plaintext: string, boundTo: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    cipher.setAAD(Buffer.from(boundTo));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [VERSION, iv, cipher.getAuthTag(), ciphertext].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
  }

  open(sealed: string, boundTo: string): string {
    const [version, iv, tag, ciphertext] = sealed.split('.');
    if (version !== VERSION || !iv || !tag || ciphertext === undefined) throw new Error('unsupported credential envelope');
    const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(boundTo));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
  }
}
