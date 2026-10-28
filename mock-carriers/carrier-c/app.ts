import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { CARRIER_C_POLICIES } from '../data/carrier-c.js';
import { PERSONAS, type PersonaKey } from '../data/personas.js';
import { createControlRouter } from '../shared/control.js';
import { FaultInjector } from '../shared/faults.js';
import { RequestLog } from '../shared/request-log.js';
import { randomToken } from '../shared/tokens.js';
import { dashboardPage, loginPage, notFoundPage, policyDetailPage } from './views.js';

/**
 * Carrier C: a server-rendered customer portal with no API. The only way in is a
 * browser: log in, read the dashboard (paginated), and open each policy page.
 * Sessions are cookie-based and expire; expired sessions redirect to /login.
 */
export interface CarrierCOptions {
  sessionTtlMs?: number;
  pageSize?: number;
  /** Ends each session after N authenticated page views (deterministic mid-scrape expiry). */
  expireSessionAfterPageViews?: number;
  layoutVersion?: 'v1' | 'v2';
  controlEnabled?: boolean;
  now?: () => number;
}

const SESSION_COOKIE = 'ccp_session';

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie ?? '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

export function createCarrierCApp(options: CarrierCOptions = {}) {
  const now = options.now ?? Date.now;
  const sessionTtlMs = options.sessionTtlMs ?? 15 * 60_000;
  const pageSize = options.pageSize ?? 2;
  const faults = new FaultInjector();
  const log = new RequestLog();
  const sessions = new Map<string, { persona: PersonaKey; expiresAt: number; pageViews: number }>();

  const state = {
    faults,
    log,
    layoutVersion: options.layoutVersion ?? ('v1' as 'v1' | 'v2'),
    expireSessionAfterPageViews: options.expireSessionAfterPageViews,
    logins: 0,
    expireAllSessions: () => {
      for (const s of sessions.values()) s.expiresAt = 0;
    },
    reset: () => {
      faults.reset();
      log.clear();
      sessions.clear();
      state.logins = 0;
      state.layoutVersion = options.layoutVersion ?? 'v1';
      state.expireSessionAfterPageViews = options.expireSessionAfterPageViews;
    },
  };

  const app: Express = express();
  app.disable('x-powered-by');
  app.use(log.middleware());
  if (options.controlEnabled) {
    app.use(
      '/__control',
      createControlRouter({
        faults,
        log,
        reset: state.reset,
        actions: {
          'expire-sessions': state.expireAllSessions,
          'layout-v2': () => {
            state.layoutVersion = 'v2';
          },
        },
      }),
    );
  }
  app.use(faults.middleware());
  app.use(express.urlencoded({ extended: false }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', carrier: 'carrier-c' });
  });
  app.get('/', (_req, res) => res.redirect(302, '/login'));

  app.get('/login', (req, res) => {
    res.type('html').send(
      loginPage({
        reason: typeof req.query.reason === 'string' ? req.query.reason : undefined,
        returnTo: typeof req.query.returnTo === 'string' ? req.query.returnTo : undefined,
      }),
    );
  });

  app.post('/login', (req, res) => {
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    const persona = (Object.keys(PERSONAS) as PersonaKey[]).find(
      (key) => PERSONAS[key].carrierC.username === body.username && PERSONAS[key].carrierC.password === body.password,
    );
    if (!persona) {
      res.status(401).type('html').send(loginPage({ error: 'The username or password you entered is incorrect.' }));
      return;
    }
    const sid = randomToken('sess');
    sessions.set(sid, { persona, expiresAt: now() + sessionTtlMs, pageViews: 0 });
    state.logins++;
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax`);
    const returnTo = body.returnTo && body.returnTo.startsWith('/') && !body.returnTo.startsWith('//') ? body.returnTo : '/dashboard';
    res.redirect(303, returnTo);
  });

  const requireSession = (req: Request, res: Response, next: NextFunction) => {
    const sid = readCookie(req, SESSION_COOKIE);
    const session = sid ? sessions.get(sid) : undefined;
    const limit = state.expireSessionAfterPageViews;
    const expired = session && (session.expiresAt <= now() || (limit !== undefined && session.pageViews >= limit));
    if (!session || expired) {
      if (sid) sessions.delete(sid);
      const reason = sid ? '&reason=session_expired' : '';
      res.redirect(302, `/login?returnTo=${encodeURIComponent(req.originalUrl)}${reason}`);
      return;
    }
    session.pageViews++;
    res.locals.persona = session.persona;
    next();
  };

  app.get('/dashboard', requireSession, (req, res) => {
    const persona = res.locals.persona as PersonaKey;
    const all = CARRIER_C_POLICIES[persona];
    const totalPages = Math.max(1, Math.ceil(all.length / pageSize));
    const page = Math.min(Math.max(1, Number(req.query.page) || 1), totalPages);
    res.type('html').send(
      dashboardPage({
        fullName: PERSONAS[persona].fullName,
        policies: all.slice((page - 1) * pageSize, page * pageSize),
        page,
        totalPages,
      }),
    );
  });

  app.get('/policies/:policyNumber', requireSession, (req, res) => {
    const policy = CARRIER_C_POLICIES[res.locals.persona as PersonaKey].find((p) => p.policyNumber === req.params.policyNumber);
    if (!policy) {
      res.status(404).type('html').send(notFoundPage());
      return;
    }
    res.type('html').send(policyDetailPage(policy, state.layoutVersion));
  });

  app.use((_req, res) => {
    res.status(404).type('html').send(notFoundPage());
  });

  return { app, state };
}
