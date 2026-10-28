import express, { type Express, type Request, type Response } from 'express';
import { CARRIER_B_POLICIES } from '../data/carrier-b.js';
import { PERSONAS, type PersonaKey } from '../data/personas.js';
import { createControlRouter } from '../shared/control.js';
import { FaultInjector } from '../shared/faults.js';
import { RequestLog } from '../shared/request-log.js';
import { randomToken } from '../shared/tokens.js';

/**
 * Carrier B: a legacy "SOAP-converted-to-REST" service.
 *  - POST /PolicyService/Authenticate   form-encoded UserName/PassWord/ClientCode -> SessionKey
 *  - GET  /PolicyService/GetPolicyList  ?SessionKey=...
 * Quirks: application errors are HTTP 200 with a non-zero ReturnCode; the session key travels
 * in the query string; and the service intermittently answers 503 with an HTML maintenance page.
 */
export const CARRIER_B_CLIENT_CODE = 'CBRIDGE01';

export interface CarrierBOptions {
  sessionTtlMs?: number;
  /** Every Nth policy-list request fails with a 503 HTML page (0 disables). Deterministic. */
  intermittentFailureEvery?: number;
  controlEnabled?: boolean;
  now?: () => number;
}

const MAINTENANCE_PAGE = `<!DOCTYPE html><html><head><title>503 Service Unavailable</title></head>
<body><h1>Service Temporarily Unavailable</h1><p>The policy service is undergoing maintenance.</p></body></html>`;

export function createCarrierBApp(options: CarrierBOptions = {}) {
  const now = options.now ?? Date.now;
  const sessionTtlMs = options.sessionTtlMs ?? 20 * 60_000;
  const failEvery = options.intermittentFailureEvery ?? 0;
  const faults = new FaultInjector();
  const log = new RequestLog();
  const sessions = new Map<string, { persona: PersonaKey; expiresAt: number }>();
  let listRequests = 0;

  const state = {
    faults,
    log,
    expireAllSessions: () => {
      for (const s of sessions.values()) s.expiresAt = 0;
    },
    reset: () => {
      faults.reset();
      log.clear();
      sessions.clear();
      listRequests = 0;
    },
  };

  const app: Express = express();
  app.disable('x-powered-by');
  app.use(log.middleware());
  if (options.controlEnabled) {
    app.use('/__control', createControlRouter({ faults, log, reset: state.reset, actions: { 'expire-sessions': state.expireAllSessions } }));
  }
  app.use(faults.middleware());
  app.use(express.urlencoded({ extended: false }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', carrier: 'carrier-b' });
  });

  app.post('/PolicyService/Authenticate', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    if (body.ClientCode !== CARRIER_B_CLIENT_CODE) {
      res.json({ AuthenticateResult: { ReturnCode: '120', ReturnMsg: 'INVALID CLIENT CODE' } });
      return;
    }
    const persona = (Object.keys(PERSONAS) as PersonaKey[]).find(
      (key) => PERSONAS[key].carrierB.username === body.UserName && PERSONAS[key].carrierB.password === body.PassWord,
    );
    if (!persona) {
      // Legacy behavior: HTTP 200 with an error code in the body.
      res.json({ AuthenticateResult: { ReturnCode: '100', ReturnMsg: 'INVALID USER ID OR PASSWORD' } });
      return;
    }
    const sessionKey = randomToken('sk');
    sessions.set(sessionKey, { persona, expiresAt: now() + sessionTtlMs });
    res.json({
      AuthenticateResult: {
        ReturnCode: '0',
        ReturnMsg: 'SUCCESS',
        SessionKey: sessionKey,
        SessionTimeoutMin: String(Math.round(sessionTtlMs / 60_000)),
      },
    });
  });

  app.get('/PolicyService/GetPolicyList', (req: Request, res: Response) => {
    listRequests++;
    if (failEvery > 0 && listRequests % failEvery === 0) {
      res.status(503).type('text/html').send(MAINTENANCE_PAGE);
      return;
    }
    const key = typeof req.query.SessionKey === 'string' ? req.query.SessionKey : '';
    const session = sessions.get(key);
    if (!session || session.expiresAt <= now()) {
      res.json({ GetPolicyListResult: { ReturnCode: '210', ReturnMsg: 'SESSION EXPIRED OR INVALID' } });
      return;
    }
    const policies = CARRIER_B_POLICIES[session.persona];
    // XML-to-JSON bridge quirks: one element -> object, zero elements -> "".
    const list = policies.length === 0 ? '' : { Policy: policies.length === 1 ? policies[0] : policies };
    res.json({
      GetPolicyListResult: { ReturnCode: '0', ReturnMsg: 'SUCCESS', RecordCount: String(policies.length), PolicyList: list },
    });
  });

  return { app, state };
}
