import { randomUUID } from 'node:crypto';
import type { Request, RequestHandler } from 'express';

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Accepts a caller's X-Request-Id (so IDs correlate across services) only if it is
 * short and log-safe; otherwise generates one. Echoed on every response.
 */
export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.header('x-request-id');
  const id = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
  req.id = id;
  res.setHeader('X-Request-Id', id);
  next();
};

/** The request ID set by `requestId` (typed by pino-http as string | number | object). */
export const requestIdOf = (req: Request): string => (typeof req.id === 'string' ? req.id : JSON.stringify(req.id));
