import type { RequestHandler } from 'express';

export interface LoggedRequest {
  method: string;
  path: string;
  status: number;
}

/** Records every request the mock serves so tests can assert on call patterns. */
export class RequestLog {
  readonly entries: LoggedRequest[] = [];

  middleware(): RequestHandler {
    return (req, res, next) => {
      if (req.path.startsWith('/__control')) return next();
      res.on('finish', () => this.entries.push({ method: req.method, path: req.path, status: res.statusCode }));
      next();
    };
  }

  count(method: string, path: string): number {
    return this.entries.filter((e) => e.method === method && e.path === path).length;
  }

  clear(): void {
    this.entries.length = 0;
  }
}
