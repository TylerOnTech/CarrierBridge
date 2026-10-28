import { describe, expect, it } from 'vitest';
import { inspect } from 'node:util';
import { ConfigError, loadConfig } from '../../src/config/env.js';
import { normalizedPolicyJsonSchema } from '../../src/contracts/json-schema.js';
import { CarrierError, isRetryableCategory } from '../../src/domain/errors.js';
import { derivePullStatus, type TaskStatus } from '../../src/domain/pull-status.js';
import { buildOpenApiDocument } from '../../src/http/openapi.js';
import { canonicalJson } from '../../src/lib/canonical-json.js';
import { mapWithConcurrency } from '../../src/lib/concurrency.js';
import { Secret } from '../../src/lib/secret.js';
import { CredentialCipher } from '../../src/security/credential-cipher.js';
import { RequestFingerprinter } from '../../src/security/fingerprint.js';
import { readFileSync } from 'node:fs';
import { captureLogger } from '../helpers/logs.js';

describe('derivePullStatus', () => {
  it.each<[TaskStatus[], string]>([
    [['pending', 'pending'], 'pending'],
    [['running', 'pending'], 'running'],
    [['succeeded', 'pending'], 'running'], // a retry is scheduled
    [['succeeded', 'succeeded', 'succeeded'], 'succeeded'],
    [['succeeded', 'failed', 'succeeded'], 'partially_succeeded'],
    [['failed', 'failed'], 'failed'],
    [['failed', 'running'], 'running'],
  ])('%j -> %s', (tasks, expected) => {
    expect(derivePullStatus(tasks)).toBe(expected);
  });
});

describe('error taxonomy', () => {
  it('derives retryability from the category unless overridden', () => {
    expect(isRetryableCategory('authentication')).toBe(false);
    expect(isRetryableCategory('carrier_unavailable')).toBe(true);
    expect(new CarrierError({ carrierId: 'x', category: 'invalid_response', code: 'c', message: 'm' }).retryable).toBe(false);
    expect(new CarrierError({ carrierId: 'x', category: 'internal', code: 'c', message: 'm', retryable: true }).retryable).toBe(true);
  });
});

describe('CredentialCipher', () => {
  const key = Buffer.alloc(32, 1);
  const cipher = new CredentialCipher(key);

  it('round-trips and never repeats a ciphertext', () => {
    const a = cipher.seal('{"password":"hunter2"}', 'task-1');
    const b = cipher.seal('{"password":"hunter2"}', 'task-1');
    expect(a).not.toBe(b);
    expect(a).not.toContain('hunter2');
    expect(cipher.open(a, 'task-1')).toBe('{"password":"hunter2"}');
  });

  it('fails closed on tampering, a different bound task, or a different key', () => {
    const sealed = cipher.seal('secret', 'task-1');
    const [v, iv, tag, ct = ''] = sealed.split('.');
    const flipped = `${v}.${iv}.${tag}.${ct.slice(0, -2)}${ct.endsWith('A') ? 'B' : 'A'}${ct.slice(-1)}`;
    expect(() => cipher.open(flipped, 'task-1')).toThrow();
    expect(() => cipher.open(sealed, 'task-2')).toThrow();
    expect(() => new CredentialCipher(Buffer.alloc(32, 2)).open(sealed, 'task-1')).toThrow();
  });
});

describe('RequestFingerprinter', () => {
  it('is stable under key reordering and sensitive to values and server key', () => {
    const f = new RequestFingerprinter(Buffer.alloc(32, 1));
    const body = { connections: [{ carrierId: 'a', credentials: { username: 'u', password: 'p' } }] };
    const reordered = { connections: [{ credentials: { password: 'p', username: 'u' }, carrierId: 'a' }] };
    expect(f.fingerprint(body)).toBe(f.fingerprint(reordered));
    expect(f.fingerprint(body)).not.toBe(f.fingerprint({ connections: [{ carrierId: 'a', credentials: { username: 'u', password: 'q' } }] }));
    expect(f.fingerprint(body)).not.toBe(new RequestFingerprinter(Buffer.alloc(32, 2)).fingerprint(body));
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
  });
});

describe('secret handling in logs', () => {
  it('Secret never serializes its value', () => {
    const s = new Secret('hunter2');
    expect(`${String(s)} ${JSON.stringify({ s })} ${inspect({ s })}`).not.toContain('hunter2');
    expect(s.reveal()).toBe('hunter2');
  });

  it('logger redacts sensitive keys at any common depth', () => {
    const { logger, text } = captureLogger('info');
    logger.info({ password: 'p1', credentials: { username: 'u', password: 'p2' }, nested: { auth: { access_token: 't1' } } }, 'event');
    logger.info({ req: { headers: { authorization: 'Bearer t2', cookie: 'sid=t3' } } }, 'request');
    for (const secret of ['p1', 'p2', 't1', 't2', 't3']) expect(text()).not.toContain(`"${secret}"`);
    expect(text()).toContain('[REDACTED]');
  });
});

describe('loadConfig', () => {
  it('reports every invalid variable by name without echoing values', () => {
    let error: unknown;
    try {
      loadConfig({ DATABASE_URL: 'mysql://nope', CREDENTIALS_ENCRYPTION_KEY: 'TOO-SHORT-SECRET', WORKER_CONCURRENCY: '0' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as Error).message;
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('CREDENTIALS_ENCRYPTION_KEY');
    expect(message).toContain('WORKER_CONCURRENCY');
    expect(message).not.toContain('TOO-SHORT-SECRET');
  });

  it('applies defaults', () => {
    const config = loadConfig({ DATABASE_URL: 'postgresql://x', CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64') });
    expect(config.worker.concurrency).toBe(4);
    expect(config.carriers['carrier-c'].concurrency).toBe(2);
  });
});

describe('mapWithConcurrency', () => {
  it('bounds in-flight work and preserves order', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapWithConcurrency([5, 1, 4, 2, 3], 2, async (n) => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, n));
      active--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30]);
    expect(peak).toBe(2);
  });
});

describe('published artifacts are in sync with the code', () => {
  it('docs/openapi.json matches the generated document (run npm run generate:openapi)', () => {
    const committed: unknown = JSON.parse(readFileSync(new URL('../../docs/openapi.json', import.meta.url), 'utf8'));
    expect(committed).toEqual(buildOpenApiDocument());
  });

  it('docs/contracts/normalized-policy.v1.schema.json matches the contract (run npm run generate:contract)', () => {
    const committed: unknown = JSON.parse(readFileSync(new URL('../../docs/contracts/normalized-policy.v1.schema.json', import.meta.url), 'utf8'));
    expect(committed).toEqual(normalizedPolicyJsonSchema());
  });
});
