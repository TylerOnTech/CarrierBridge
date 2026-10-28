import { describe, expect, it, vi } from 'vitest';
import { TaskAbortError } from '../../src/carriers/shared/abort.js';
import { CarrierHttpClient, type HttpClientOptions, parseRetryAfter } from '../../src/carriers/shared/http-client.js';
import { CarrierError } from '../../src/domain/errors.js';
import { createLogger } from '../../src/logging/logger.js';
import { captureLogger } from '../helpers/logs.js';

type FetchStep = Response | Error | ((init: RequestInit) => Promise<Response>);

/** fetch double that replays a scripted sequence and records calls. */
function scriptedFetch(steps: FetchStep[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: URL, init: RequestInit) => {
    calls.push({ url: url.toString(), init });
    const step = steps.shift();
    if (!step) throw new Error('unexpected extra request');
    if (step instanceof Error) throw step;
    if (typeof step === 'function') return step(init);
    return step;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function client(fetchImpl: typeof fetch, overrides: Partial<HttpClientOptions> = {}) {
  const sleep = vi.fn(async () => {});
  const http = new CarrierHttpClient({
    carrierId: 'test-carrier',
    baseUrl: 'http://carrier.test',
    timeoutMs: 1000,
    retry: { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 1000, maxRetryAfterMs: 5000 },
    logger: createLogger({ level: 'silent', pretty: false }),
    signal: new AbortController().signal,
    sleep,
    random: () => 0.5,
    fetchImpl,
    ...overrides,
  });
  return { http, sleep };
}

describe('CarrierHttpClient', () => {
  it('retries transient 5xx responses with exponential backoff and full jitter', async () => {
    const { impl, calls } = scriptedFetch([json(503, {}), json(502, {}), json(200, { ok: true })]);
    const { http, sleep } = client(impl);
    const res = await http.request({ operation: 'list', path: '/v1/policies' });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(3);
    // random()=0.5 -> half of min(max, base * 2^attempt)
    expect(sleep.mock.calls.map((c: unknown[]) => c[0])).toEqual([50, 100]);
    expect(http.stats).toEqual({ requests: 3, retries: 2 });
  });

  it('honors Retry-After on 429 instead of its own backoff', async () => {
    const { impl } = scriptedFetch([json(429, {}, { 'retry-after': '2' }), json(200, {})]);
    const { http, sleep } = client(impl);
    await http.request({ operation: 'list', path: '/x' });
    expect(sleep).toHaveBeenCalledWith(2000, expect.any(AbortSignal));
  });

  it('surfaces Retry-After beyond the in-process cap so the task can be rescheduled durably', async () => {
    const { impl, calls } = scriptedFetch([json(429, {}, { 'retry-after': '120' })]);
    const { http, sleep } = client(impl);
    const error = await http.request({ operation: 'list', path: '/x' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CarrierError);
    expect(error).toMatchObject({ category: 'rate_limited', retryable: true, retryAfterMs: 120_000 });
    expect(calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('gives up after maxRetries and classifies the failure', async () => {
    const { impl, calls } = scriptedFetch([json(503, {}), json(503, {}), json(503, {}), json(503, {})]);
    const { http } = client(impl);
    await expect(http.request({ operation: 'list', path: '/x' })).rejects.toMatchObject({
      category: 'carrier_unavailable',
      code: 'http_503',
      retryable: true,
    });
    expect(calls).toHaveLength(4);
  });

  it('returns 4xx responses to the adapter without retrying', async () => {
    const { impl, calls } = scriptedFetch([json(401, { error: 'invalid_token' })]);
    const { http } = client(impl);
    expect((await http.request({ operation: 'list', path: '/x' })).status).toBe(401);
    expect(calls).toHaveLength(1);
  });

  it('never retries non-idempotent requests', async () => {
    const { impl, calls } = scriptedFetch([json(503, {})]);
    const { http } = client(impl);
    await expect(http.request({ operation: 'submit', method: 'POST', path: '/x', json: {} })).rejects.toMatchObject({
      category: 'carrier_unavailable',
    });
    expect(calls).toHaveLength(1);
  });

  it('retries network errors and classifies them as carrier_unavailable', async () => {
    const { impl, calls } = scriptedFetch([new TypeError('fetch failed'), new TypeError('fetch failed'), json(200, {})]);
    const { http } = client(impl);
    expect((await http.request({ operation: 'list', path: '/x' })).status).toBe(200);
    expect(calls).toHaveLength(3);
  });

  it('enforces the per-request timeout', async () => {
    const hang = (init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error));
      });
    const { impl } = scriptedFetch([hang, hang]);
    const { http } = client(impl, { timeoutMs: 20, retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1, maxRetryAfterMs: 0 } });
    await expect(http.request({ operation: 'slow', path: '/x' })).rejects.toMatchObject({ category: 'timeout', code: 'request_timeout' });
  });

  it('stops immediately when the task deadline aborts the signal', async () => {
    const controller = new AbortController();
    controller.abort(new TaskAbortError('task_timeout'));
    const { impl, calls } = scriptedFetch([]);
    const { http } = client(impl, { signal: controller.signal });
    await expect(http.request({ operation: 'list', path: '/x' })).rejects.toMatchObject({ category: 'timeout', code: 'task_deadline_exceeded' });
    expect(calls).toHaveLength(0);
  });

  it('classifies wrong content types and malformed JSON as invalid_response', async () => {
    const { impl } = scriptedFetch([
      new Response('<html>oops</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      new Response('{"truncated": ', { status: 200, headers: { 'content-type': 'application/json' } }),
    ]);
    const { http } = client(impl);
    const html = await http.request({ operation: 'a', path: '/x' });
    expect(() => html.json()).toThrow(expect.objectContaining({ category: 'invalid_response', code: 'unexpected_content_type' }));
    const truncated = await http.request({ operation: 'b', path: '/x' });
    expect(() => truncated.json()).toThrow(expect.objectContaining({ category: 'invalid_response', code: 'malformed_json' }));
  });

  it('redacts sensitive query parameters from logs', async () => {
    const { impl } = scriptedFetch([json(200, {})]);
    const { logger, text } = captureLogger('debug');
    const { http } = client(impl, { logger, sensitiveQueryParams: ['SessionKey'] });
    await http.request({ operation: 'list', path: '/svc', query: { SessionKey: 'sk_super_secret', page: 2 } });
    expect(text()).toContain('SessionKey=REDACTED');
    expect(text()).not.toContain('sk_super_secret');
  });
});

describe('parseRetryAfter', () => {
  it('parses delta-seconds and HTTP dates', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('3', now)).toBe(3000);
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:05 GMT', now)).toBe(5000);
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });
});
