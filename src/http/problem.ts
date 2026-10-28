import { STATUS_CODES } from 'node:http';
import type { ErrorRequestHandler, Request, RequestHandler } from 'express';
import type { z } from 'zod';
import { ApiError } from '../domain/errors.js';
import { requestIdOf } from './middleware/request-id.js';
import type { ProblemSchema } from './schemas.js';

type Problem = z.infer<typeof ProblemSchema>;

function problem(req: Request, status: number, code: string, detail: string, errors?: Problem['errors']): Problem {
  return {
    type: `urn:carrierbridge:problem:${code}`,
    title: STATUS_CODES[status] ?? 'Error',
    status,
    detail,
    instance: req.originalUrl,
    code,
    requestId: requestIdOf(req),
    ...(errors && errors.length > 0 ? { errors } : {}),
  };
}

/** Parses `value` with `schema` or throws a 400 problem listing every issue by path. */
export function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, location: 'body' | 'query' | 'params'): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw ApiError.badRequest(
    'validation_error',
    `Request ${location} failed validation`,
    result.error.issues.map((i) => ({ path: [location, ...i.path].join('.'), message: i.message })),
  );
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new ApiError(404, 'route_not_found', `No route for ${req.method} ${req.path}`));
};

interface BodyParserError {
  type?: string;
  status?: number;
}

/**
 * Single place where errors become HTTP responses. Known errors map to stable codes;
 * anything else is a 500 whose details are logged but never sent to the client.
 */
export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, _next) => {
  let body: Problem;
  if (err instanceof ApiError) {
    body = problem(req, err.status, err.code, err.message, err.errors);
  } else if ((err as BodyParserError)?.type === 'entity.parse.failed') {
    body = problem(req, 400, 'malformed_json', 'Request body is not valid JSON');
  } else if ((err as BodyParserError)?.type === 'entity.too.large') {
    body = problem(req, 413, 'payload_too_large', 'Request body exceeds the size limit');
  } else {
    req.log.error({ err }, 'unhandled error');
    body = problem(req, 500, 'internal_error', 'An unexpected error occurred');
  }
  res.status(body.status).type('application/problem+json').json(body);
};
