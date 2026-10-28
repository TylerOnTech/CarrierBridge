import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';

/**
 * Deterministic fault injection for the mock carriers. Tests (and the demo) queue
 * faults that fire a fixed number of times on matching routes, so failure scenarios
 * are reproducible instead of depending on random chaos.
 */
export const FaultRuleSchema = z.object({
  method: z.string().toUpperCase().optional(),
  /** Exact path, or a prefix ending in `*` (e.g. "/v1/policies/*"). */
  path: z.string(),
  times: z.number().int().positive().default(1),
  /** Skip this many matching requests before firing (e.g. fail the 3rd call). */
  after: z.number().int().nonnegative().default(0),
  action: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('status'),
      status: z.number().int().min(100).max(599),
      body: z.string().optional(),
      contentType: z.string().optional(),
      headers: z.record(z.string(), z.string()).optional(),
    }),
    z.object({ type: z.literal('delay'), ms: z.number().int().nonnegative() }),
    z.object({ type: z.literal('malformed_json') }),
    z.object({ type: z.literal('drop_connection') }),
  ]),
});

export type FaultRule = z.input<typeof FaultRuleSchema>;
type ParsedRule = z.output<typeof FaultRuleSchema> & { seen: number; fired: number };

export class FaultInjector {
  private rules: ParsedRule[] = [];

  add(rule: FaultRule): void {
    this.rules.push({ ...FaultRuleSchema.parse(rule), seen: 0, fired: 0 });
  }

  reset(): void {
    this.rules = [];
  }

  pending(): number {
    return this.rules.filter((r) => r.fired < r.times).length;
  }

  private match(req: Request): ParsedRule | undefined {
    for (const rule of this.rules) {
      if (rule.fired >= rule.times) continue;
      if (rule.method && rule.method !== req.method) continue;
      const matches = rule.path.endsWith('*') ? req.path.startsWith(rule.path.slice(0, -1)) : req.path === rule.path;
      if (!matches) continue;
      rule.seen++;
      if (rule.seen <= rule.after) continue;
      rule.fired++;
      return rule;
    }
    return undefined;
  }

  middleware(): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
      if (req.path.startsWith('/__control')) return next();
      const rule = this.match(req);
      if (!rule) return next();
      const { action } = rule;
      switch (action.type) {
        case 'delay':
          setTimeout(next, action.ms);
          return;
        case 'status':
          res.status(action.status);
          for (const [k, v] of Object.entries(action.headers ?? {})) res.setHeader(k, v);
          res.type(action.contentType ?? 'application/json').send(action.body ?? JSON.stringify({ error: 'injected_fault' }));
          return;
        case 'malformed_json':
          res.status(200).type('application/json').send('{"data": [{"policyNumber": "APX-');
          return;
        case 'drop_connection':
          req.socket.destroy();
          return;
      }
    };
  }
}
