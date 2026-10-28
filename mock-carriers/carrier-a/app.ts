import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { CARRIER_A_POLICIES, type CarrierAPolicyRecord } from '../data/carrier-a.js';
import { PERSONAS, type PersonaKey } from '../data/personas.js';
import { createControlRouter } from '../shared/control.js';
import { FaultInjector } from '../shared/faults.js';
import { RequestLog } from '../shared/request-log.js';
import { randomToken } from '../shared/tokens.js';

/**
 * Carrier A: a modern OAuth2-style REST API.
 *  - POST /oauth/token        password and refresh_token grants, rotating refresh tokens
 *  - GET  /v1/policies        cursor-paginated policy summaries (Bearer auth)
 *  - GET  /v1/policies/:id    full policy detail
 * Access tokens expire (401 invalid_token), and requests are rate limited per token (429 + Retry-After).
 */
export interface CarrierAOptions {
  tokenTtlSeconds?: number;
  pageSize?: number;
  rateLimit?: { limit: number; windowMs: number } | null;
  controlEnabled?: boolean;
  now?: () => number;
}

interface TokenRecord {
  persona: PersonaKey;
  expiresAt: number;
}

export function createCarrierAApp(options: CarrierAOptions = {}) {
  const now = options.now ?? Date.now;
  const tokenTtlSeconds = options.tokenTtlSeconds ?? 300;
  const pageSize = options.pageSize ?? 2;
  const faults = new FaultInjector();
  const log = new RequestLog();
  const accessTokens = new Map<string, TokenRecord>();
  const refreshTokens = new Map<string, PersonaKey>();
  const rateWindows = new Map<string, { windowStart: number; count: number }>();

  const state = {
    faults,
    log,
    /** Simulates every outstanding access token reaching its expiry. */
    expireAllTokens: () => {
      for (const record of accessTokens.values()) record.expiresAt = 0;
    },
    reset: () => {
      faults.reset();
      log.clear();
      accessTokens.clear();
      refreshTokens.clear();
      rateWindows.clear();
    },
  };

  const issueTokens = (persona: PersonaKey) => {
    const accessToken = randomToken('at');
    const refreshToken = randomToken('rt');
    accessTokens.set(accessToken, { persona, expiresAt: now() + tokenTtlSeconds * 1000 });
    refreshTokens.set(refreshToken, persona);
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: tokenTtlSeconds,
      refresh_token: refreshToken,
      scope: 'policies:read',
    };
  };

  const app: Express = express();
  app.disable('x-powered-by');
  app.use(log.middleware());
  if (options.controlEnabled) {
    app.use('/__control', createControlRouter({ faults, log, reset: state.reset, actions: { 'expire-tokens': state.expireAllTokens } }));
  }
  app.use(faults.middleware());
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', carrier: 'carrier-a' });
  });

  app.post('/oauth/token', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.grant_type === 'password') {
      const persona = (Object.keys(PERSONAS) as PersonaKey[]).find(
        (key) => PERSONAS[key].carrierA.username === body.username && PERSONAS[key].carrierA.password === body.password,
      );
      if (!persona) {
        res.status(401).json({ error: 'invalid_grant', error_description: 'Invalid username or password' });
        return;
      }
      res.json(issueTokens(persona));
      return;
    }
    if (body.grant_type === 'refresh_token' && typeof body.refresh_token === 'string') {
      const persona = refreshTokens.get(body.refresh_token);
      if (!persona) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'Refresh token is invalid or revoked' });
        return;
      }
      refreshTokens.delete(body.refresh_token); // rotation: each refresh token is single-use
      res.json(issueTokens(persona));
      return;
    }
    res.status(400).json({ error: 'unsupported_grant_type' });
  });

  const authenticate = (req: Request, res: Response, next: NextFunction) => {
    const header = req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const record = accessTokens.get(token);
    if (!record) {
      res.setHeader('WWW-Authenticate', 'Bearer error="invalid_token"');
      res.status(401).json({ error: 'invalid_token', error_description: 'The access token is invalid' });
      return;
    }
    if (record.expiresAt <= now()) {
      res.setHeader('WWW-Authenticate', 'Bearer error="invalid_token", error_description="The access token expired"');
      res.status(401).json({ error: 'invalid_token', error_description: 'The access token expired' });
      return;
    }
    res.locals.persona = record.persona;
    res.locals.token = token;
    next();
  };

  const rateLimit = (_req: Request, res: Response, next: NextFunction) => {
    if (!options.rateLimit) return next();
    const { limit, windowMs } = options.rateLimit;
    const key = res.locals.token as string;
    const t = now();
    const window = rateWindows.get(key);
    const current = window && t - window.windowStart < windowMs ? window : { windowStart: t, count: 0 };
    current.count++;
    rateWindows.set(key, current);
    const resetMs = current.windowStart + windowMs - t;
    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - current.count)));
    if (current.count > limit) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(resetMs / 1000))));
      res.status(429).json({ error: 'rate_limited', error_description: 'Too many requests' });
      return;
    }
    next();
  };

  const summary = (p: CarrierAPolicyRecord) => ({
    policyNumber: p.policyNumber,
    lineOfBusiness: p.lineOfBusiness,
    status: p.status,
    updatedAt: p.updatedAt,
    links: { self: `/v1/policies/${p.policyNumber}` },
  });

  app.get('/v1/policies', authenticate, rateLimit, (req, res) => {
    const policies = CARRIER_A_POLICIES[res.locals.persona as PersonaKey];
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const offset = cursor ? Number(Buffer.from(cursor, 'base64url').toString('utf8')) : 0;
    if (!Number.isInteger(offset) || offset < 0) {
      res.status(400).json({ error: 'invalid_cursor' });
      return;
    }
    const page = policies.slice(offset, offset + pageSize);
    const nextOffset = offset + pageSize;
    res.json({
      data: page.map(summary),
      page: {
        nextCursor: nextOffset < policies.length ? Buffer.from(String(nextOffset)).toString('base64url') : null,
        totalCount: policies.length,
      },
    });
  });

  app.get('/v1/policies/:policyNumber', authenticate, rateLimit, (req, res) => {
    const policy = CARRIER_A_POLICIES[res.locals.persona as PersonaKey].find((p) => p.policyNumber === req.params.policyNumber);
    if (!policy) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json(policy);
  });

  return { app, state };
}
