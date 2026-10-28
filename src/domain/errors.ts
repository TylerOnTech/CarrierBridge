/**
 * Error taxonomy for carrier integrations.
 *
 * Every failure that crosses the adapter boundary is a CarrierError with a category.
 * The category drives retry policy, the HTTP-facing error payload, and alerting:
 * an `authentication` failure is the user's problem, `carrier_unavailable` is the
 * carrier's, and `internal` is ours.
 */
export const ERROR_CATEGORIES = [
  /** Credentials rejected by the carrier. Retrying will not help. */
  'authentication',
  /** Session/token expired and could not be re-established within the attempt. */
  'session_expired',
  /** Carrier throttled us (HTTP 429 or equivalent). */
  'rate_limited',
  /** Carrier returned 5xx, an error page, or the connection failed. */
  'carrier_unavailable',
  /** A request, navigation, or the whole task exceeded its deadline. */
  'timeout',
  /** Carrier responded, but the payload/page did not match the expected shape. */
  'invalid_response',
  /** The task was interrupted (e.g. worker shutdown); it will be re-queued. */
  'cancelled',
  /** Bug or unexpected condition inside CarrierBridge. */
  'internal',
] as const;

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

const DEFAULT_RETRYABLE: Record<ErrorCategory, boolean> = {
  authentication: false,
  session_expired: true,
  rate_limited: true,
  carrier_unavailable: true,
  timeout: true,
  invalid_response: false,
  cancelled: true,
  internal: false,
};

export function isRetryableCategory(category: ErrorCategory): boolean {
  return DEFAULT_RETRYABLE[category];
}

export interface CarrierErrorParams {
  carrierId: string;
  category: ErrorCategory;
  /** Stable machine-readable code, e.g. `invalid_credentials`, `http_503`. */
  code: string;
  message: string;
  retryable?: boolean;
  /** Server-advised delay before retrying (e.g. from Retry-After). */
  retryAfterMs?: number;
  /** Safe-to-log diagnostic details. Never include credentials, tokens, or session IDs. */
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class CarrierError extends Error {
  readonly carrierId: string;
  readonly category: ErrorCategory;
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(params: CarrierErrorParams) {
    super(params.message, params.cause === undefined ? undefined : { cause: params.cause });
    this.name = 'CarrierError';
    this.carrierId = params.carrierId;
    this.category = params.category;
    this.code = params.code;
    this.retryable = params.retryable ?? isRetryableCategory(params.category);
    this.retryAfterMs = params.retryAfterMs;
    this.details = params.details;
  }

  toJSON() {
    return {
      name: this.name,
      carrierId: this.carrierId,
      category: this.category,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      details: this.details,
    };
  }
}

export function isCarrierError(error: unknown): error is CarrierError {
  return error instanceof CarrierError;
}

/** Errors surfaced to API clients, rendered as RFC 9457 problem details. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly errors?: Array<{ path: string; message: string }>,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static badRequest(code: string, message: string, errors?: Array<{ path: string; message: string }>) {
    return new ApiError(400, code, message, errors);
  }

  static notFound(resource: string, id: string) {
    return new ApiError(404, 'not_found', `${resource} '${id}' was not found`);
  }

  static unprocessable(code: string, message: string) {
    return new ApiError(422, code, message);
  }
}
