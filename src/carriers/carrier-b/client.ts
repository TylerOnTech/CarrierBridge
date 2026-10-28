import { CarrierError } from '../../domain/errors.js';
import type { Logger } from '../../logging/logger.js';
import { Secret } from '../../lib/secret.js';
import type { UsernamePasswordCredentials } from '../shared/credentials.js';
import type { CarrierHttpClient, HttpResponse } from '../shared/http-client.js';
import { asArray } from '../shared/policy-builder.js';
import { AuthenticateResponseSchema, PolicyListResponseSchema, RETURN_CODES } from './schemas.js';

/** Issued to CarrierBridge by the (fictional) carrier during onboarding; not a user secret. */
export const CARRIER_B_CLIENT_CODE = 'CBRIDGE01';

export class CarrierBClient {
  readonly stats = { logins: 0, reauthentications: 0 };
  private sessionKey: Secret | undefined;

  constructor(
    private readonly carrierId: string,
    private readonly http: CarrierHttpClient,
    private readonly credentials: UsernamePasswordCredentials,
    private readonly logger: Logger,
  ) {}

  async authenticate(): Promise<void> {
    const res = await this.http.request({
      operation: 'authenticate',
      method: 'POST',
      path: '/PolicyService/Authenticate',
      idempotent: true,
      form: {
        UserName: this.credentials.username,
        PassWord: this.credentials.password.reveal(),
        ClientCode: CARRIER_B_CLIENT_CODE,
      },
    });
    const parsed = AuthenticateResponseSchema.safeParse(this.okJson(res));
    if (!parsed.success) throw this.invalid('invalid_auth_response', 'Authenticate response did not match the expected envelope');
    const result = parsed.data.AuthenticateResult;

    switch (result.ReturnCode) {
      case RETURN_CODES.SUCCESS:
        if (!result.SessionKey) throw this.invalid('missing_session_key', 'Authenticate succeeded without a SessionKey');
        this.sessionKey = new Secret(result.SessionKey);
        this.stats.logins++;
        return;
      case RETURN_CODES.INVALID_CREDENTIALS:
      case RETURN_CODES.ACCOUNT_LOCKED:
        throw new CarrierError({
          carrierId: this.carrierId,
          category: 'authentication',
          code: result.ReturnCode === RETURN_CODES.ACCOUNT_LOCKED ? 'account_locked' : 'invalid_credentials',
          message: 'Carrier rejected the supplied credentials',
          details: { returnCode: result.ReturnCode },
        });
      case RETURN_CODES.INVALID_CLIENT_CODE:
        throw new CarrierError({
          carrierId: this.carrierId,
          category: 'internal',
          code: 'invalid_client_code',
          message: 'Carrier rejected the CarrierBridge client code (integration misconfiguration)',
        });
      default:
        throw this.invalid('unexpected_return_code', `Authenticate returned unexpected ReturnCode ${result.ReturnCode}`);
    }
  }

  /** Fetches all policy records, re-authenticating once if the session key has expired. */
  async getPolicyList(): Promise<unknown[]> {
    if (!this.sessionKey) await this.authenticate();
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.http.request({
        operation: 'get_policy_list',
        path: '/PolicyService/GetPolicyList',
        query: { SessionKey: this.sessionKey?.reveal() },
      });
      const parsed = PolicyListResponseSchema.safeParse(this.okJson(res));
      if (!parsed.success) throw this.invalid('invalid_policy_list', 'GetPolicyList response did not match the expected envelope');
      const result = parsed.data.GetPolicyListResult;

      if (result.ReturnCode === RETURN_CODES.SESSION_EXPIRED) {
        this.sessionKey = undefined;
        if (attempt === 0) {
          this.logger.info('legacy session expired; re-authenticating');
          this.stats.reauthentications++;
          await this.authenticate();
          continue;
        }
        throw new CarrierError({
          carrierId: this.carrierId,
          category: 'session_expired',
          code: 'session_expired_after_reauth',
          message: 'Carrier reported the session expired immediately after re-authentication',
        });
      }
      if (result.ReturnCode !== RETURN_CODES.SUCCESS) {
        throw this.invalid('unexpected_return_code', `GetPolicyList returned unexpected ReturnCode ${result.ReturnCode}`);
      }
      return result.PolicyList ? asArray(result.PolicyList.Policy) : [];
    }
    throw new Error('unreachable');
  }

  private okJson(res: HttpResponse): unknown {
    if (!res.ok) throw this.invalid('unexpected_status', `${res.operation} returned HTTP ${res.status}`);
    return res.json();
  }

  private invalid(code: string, message: string): CarrierError {
    return new CarrierError({ carrierId: this.carrierId, category: 'invalid_response', code, message });
  }
}
