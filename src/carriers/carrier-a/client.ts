import { CarrierError } from '../../domain/errors.js';
import type { Logger } from '../../logging/logger.js';
import { Secret } from '../../lib/secret.js';
import type { UsernamePasswordCredentials } from '../shared/credentials.js';
import type { CarrierHttpClient, HttpResponse } from '../shared/http-client.js';
import { OAuthErrorSchema, TokenResponseSchema } from './schemas.js';

/** Refresh slightly before expiry so a token never dies mid-request. */
const EXPIRY_SKEW_MS = 30_000;

interface TokenState {
  accessToken: Secret;
  refreshToken: Secret | undefined;
  expiresAt: number;
}

/**
 * OAuth2 password-grant client with proactive and reactive token refresh:
 *  - proactive: refresh when the token is within EXPIRY_SKEW_MS of `expires_in`
 *  - reactive:  a 401 invalid_token triggers one refresh (or re-login) and a single replay
 * Refresh tokens rotate, so a rejected refresh token falls back to a fresh password grant.
 */
export class CarrierAClient {
  readonly stats = { logins: 0, tokenRefreshes: 0 };
  private tokens: TokenState | undefined;

  constructor(
    private readonly carrierId: string,
    private readonly http: CarrierHttpClient,
    private readonly credentials: UsernamePasswordCredentials,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  async login(): Promise<void> {
    const res = await this.http.request({
      operation: 'token_password_grant',
      method: 'POST',
      path: '/oauth/token',
      idempotent: true,
      json: {
        grant_type: 'password',
        username: this.credentials.username,
        password: this.credentials.password.reveal(),
        client_id: 'carrierbridge',
      },
    });
    if (res.status === 400 || res.status === 401) {
      const oauthError = OAuthErrorSchema.safeParse(safeJson(res));
      throw new CarrierError({
        carrierId: this.carrierId,
        category: 'authentication',
        code: oauthError.success && oauthError.data.error === 'invalid_grant' ? 'invalid_credentials' : 'login_rejected',
        message: 'Carrier rejected the supplied credentials',
        details: { status: res.status },
      });
    }
    this.storeTokens(res);
    this.stats.logins++;
  }

  /** Returns false when the refresh token is missing or rejected (caller should re-login). */
  private async refresh(): Promise<boolean> {
    const refreshToken = this.tokens?.refreshToken;
    if (!refreshToken) return false;
    const res = await this.http.request({
      operation: 'token_refresh_grant',
      method: 'POST',
      path: '/oauth/token',
      idempotent: true,
      json: { grant_type: 'refresh_token', refresh_token: refreshToken.reveal(), client_id: 'carrierbridge' },
    });
    if (res.status === 400 || res.status === 401) {
      this.logger.info('refresh token rejected; falling back to password grant');
      this.tokens = undefined;
      return false;
    }
    this.storeTokens(res);
    this.stats.tokenRefreshes++;
    return true;
  }

  private storeTokens(res: HttpResponse): void {
    if (!res.ok) {
      throw new CarrierError({
        carrierId: this.carrierId,
        category: 'invalid_response',
        code: 'unexpected_status',
        message: `Token endpoint returned HTTP ${res.status}`,
      });
    }
    const parsed = TokenResponseSchema.safeParse(res.json());
    if (!parsed.success) {
      throw new CarrierError({
        carrierId: this.carrierId,
        category: 'invalid_response',
        code: 'invalid_token_response',
        message: 'Token response did not match the expected shape',
      });
    }
    this.tokens = {
      accessToken: new Secret(parsed.data.access_token),
      refreshToken: parsed.data.refresh_token ? new Secret(parsed.data.refresh_token) : this.tokens?.refreshToken,
      expiresAt: this.now() + parsed.data.expires_in * 1000,
    };
  }

  private async renew(): Promise<void> {
    if (!(await this.refresh())) await this.login();
  }

  private async ensureFreshToken(): Promise<Secret> {
    if (!this.tokens) await this.login();
    else if (this.tokens.expiresAt - EXPIRY_SKEW_MS <= this.now()) await this.renew();
    if (!this.tokens) throw new Error('token state missing after authentication');
    return this.tokens.accessToken;
  }

  /** GET with bearer auth. Returns parsed JSON, or null for 404. */
  async getJson(operation: string, path: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.ensureFreshToken();
      const res = await this.http.request({
        operation,
        path,
        query,
        headers: { authorization: `Bearer ${token.reveal()}` },
      });
      if (res.status === 401) {
        if (attempt === 0) {
          this.logger.info({ operation }, 'access token rejected; renewing session');
          await this.renew();
          continue;
        }
        break;
      }
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new CarrierError({
          carrierId: this.carrierId,
          category: 'invalid_response',
          code: 'unexpected_status',
          message: `${operation} returned HTTP ${res.status}`,
          details: { operation, status: res.status },
        });
      }
      return res.json();
    }
    throw new CarrierError({
      carrierId: this.carrierId,
      category: 'session_expired',
      code: 'token_rejected_after_renewal',
      message: 'Carrier rejected a freshly issued access token',
      details: { operation },
    });
  }
}

function safeJson(res: HttpResponse): unknown {
  try {
    return res.json();
  } catch {
    return undefined;
  }
}
