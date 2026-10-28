import { CarrierError } from '../../domain/errors.js';
import type { Logger } from '../../logging/logger.js';
import { type SleepFn, sleep as defaultSleep } from '../../lib/sleep.js';
import { abortToCarrierError } from './abort.js';

export interface RetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** A Retry-After longer than this is not waited out in-process; the task is rescheduled instead. */
  maxRetryAfterMs: number;
}

export interface HttpClientOptions {
  carrierId: string;
  baseUrl: string;
  timeoutMs: number;
  retry: RetryPolicy;
  logger: Logger;
  signal: AbortSignal;
  /** Query parameters that carry secrets (e.g. legacy session keys) and must never be logged. */
  sensitiveQueryParams?: readonly string[];
  maxResponseBytes?: number;
  sleep?: SleepFn;
  random?: () => number;
  fetchImpl?: typeof fetch;
}

export interface HttpRequest {
  /** Label used in logs and error details, e.g. "list_policies". */
  operation: string;
  method?: 'GET' | 'POST';
  path: string;
  query?: Record<string, string | number | undefined>;
  headers?: Record<string, string>;
  json?: unknown;
  form?: Record<string, string>;
  /** Only idempotent requests are retried automatically. Defaults to true for GET. */
  idempotent?: boolean;
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export class HttpResponse {
  constructor(
    readonly carrierId: string,
    readonly operation: string,
    readonly status: number,
    readonly headers: Headers,
    readonly text: string,
  ) {}

  get ok(): boolean {
    return this.status >= 200 && this.status < 300;
  }

  /** Parses JSON defensively: wrong content type or malformed bodies become invalid_response. */
  json(): unknown {
    const contentType = this.headers.get('content-type') ?? '';
    if (!contentType.includes('json')) {
      throw new CarrierError({
        carrierId: this.carrierId,
        category: 'invalid_response',
        code: 'unexpected_content_type',
        message: `Expected JSON from ${this.operation} but received '${contentType || 'none'}'`,
        details: { operation: this.operation, status: this.status },
      });
    }
    try {
      return JSON.parse(this.text) as unknown;
    } catch (cause) {
      throw new CarrierError({
        carrierId: this.carrierId,
        category: 'invalid_response',
        code: 'malformed_json',
        message: `Response from ${this.operation} is not valid JSON`,
        details: { operation: this.operation, status: this.status, bytes: this.text.length },
        cause,
      });
    }
  }
}

export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - nowMs);
}

/**
 * Thin fetch wrapper shared by API-based adapters. It owns the cross-cutting transport
 * concerns (per-request timeouts, cancellation, bounded retries with exponential backoff
 * and full jitter, Retry-After, response size limits, redacted logging) so adapters only
 * contain carrier semantics. 4xx responses are returned, not thrown: whether a 401 means
 * "bad password" or "token expired" is the adapter's call.
 */
export class CarrierHttpClient {
  readonly stats = { requests: 0, retries: 0 };
  private readonly sleep: SleepFn;
  private readonly random: () => number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: HttpClientOptions) {
    this.sleep = opts.sleep ?? defaultSleep;
    this.random = opts.random ?? Math.random;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    const idempotent = req.idempotent ?? (req.method ?? 'GET') === 'GET';
    for (let attempt = 0; ; attempt++) {
      const outcome = await this.attempt(req);
      if (outcome instanceof HttpResponse) return outcome;

      const { retry } = this.opts;
      const retryAfter = outcome.retryAfterMs;
      const canRetry =
        idempotent &&
        outcome.retryable &&
        attempt < retry.maxRetries &&
        (retryAfter === undefined || retryAfter <= retry.maxRetryAfterMs);
      if (!canRetry) throw outcome;

      const delayMs = retryAfter ?? this.backoffMs(attempt);
      this.stats.retries++;
      this.opts.logger.warn(
        { operation: req.operation, attempt: attempt + 1, delayMs, category: outcome.category, code: outcome.code },
        'retrying carrier request',
      );
      try {
        await this.sleep(delayMs, this.opts.signal);
      } catch {
        throw abortToCarrierError(this.opts.carrierId, this.opts.signal);
      }
    }
  }

  /** Exponential backoff with full jitter: uniform in [0, min(max, base * 2^attempt)]. */
  backoffMs(attempt: number): number {
    const ceiling = Math.min(this.opts.retry.maxDelayMs, this.opts.retry.baseDelayMs * 2 ** attempt);
    return Math.round(this.random() * ceiling);
  }

  private buildUrl(req: HttpRequest): URL {
    const url = new URL(req.path, this.opts.baseUrl);
    for (const [key, value] of Object.entries(req.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url;
  }

  private redact(url: URL): string {
    const copy = new URL(url);
    for (const key of this.opts.sensitiveQueryParams ?? []) {
      if (copy.searchParams.has(key)) copy.searchParams.set(key, 'REDACTED');
    }
    return copy.pathname + copy.search;
  }

  private async attempt(req: HttpRequest): Promise<HttpResponse | CarrierError> {
    const { carrierId, logger } = this.opts;
    if (this.opts.signal.aborted) throw abortToCarrierError(carrierId, this.opts.signal);

    const url = this.buildUrl(req);
    const headers: Record<string, string> = { accept: 'application/json', ...req.headers };
    let body: string | undefined;
    if (req.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(req.json);
    } else if (req.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(req.form).toString();
    }

    const started = performance.now();
    this.stats.requests++;
    try {
      const res = await this.fetchImpl(url, {
        method: req.method ?? 'GET',
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.any([this.opts.signal, AbortSignal.timeout(this.opts.timeoutMs)]),
      });
      const text = await res.text();
      const durationMs = Math.round(performance.now() - started);
      logger.debug(
        { operation: req.operation, method: req.method ?? 'GET', path: this.redact(url), status: res.status, durationMs },
        'carrier request completed',
      );

      const maxBytes = this.opts.maxResponseBytes ?? 5 * 1024 * 1024;
      if (text.length > maxBytes) {
        return new CarrierError({
          carrierId,
          category: 'invalid_response',
          code: 'response_too_large',
          message: `Response from ${req.operation} exceeded ${maxBytes} bytes`,
        });
      }

      if (RETRYABLE_STATUSES.has(res.status)) {
        const rateLimited = res.status === 429;
        return new CarrierError({
          carrierId,
          category: rateLimited ? 'rate_limited' : 'carrier_unavailable',
          code: `http_${res.status}`,
          message: rateLimited
            ? `Carrier rate limited ${req.operation}`
            : `Carrier returned HTTP ${res.status} for ${req.operation}`,
          retryAfterMs: parseRetryAfter(res.headers.get('retry-after'), Date.now()),
          details: { operation: req.operation, status: res.status },
        });
      }
      return new HttpResponse(carrierId, req.operation, res.status, res.headers, text);
    } catch (error) {
      if (this.opts.signal.aborted) throw abortToCarrierError(carrierId, this.opts.signal);
      const isTimeout = error instanceof Error && error.name === 'TimeoutError';
      return new CarrierError({
        carrierId,
        category: isTimeout ? 'timeout' : 'carrier_unavailable',
        code: isTimeout ? 'request_timeout' : 'network_error',
        message: isTimeout
          ? `${req.operation} timed out after ${this.opts.timeoutMs}ms`
          : `Network error during ${req.operation}: ${error instanceof Error ? error.message : String(error)}`,
        details: { operation: req.operation },
        cause: error,
      });
    }
  }
}
