import type { AppConfig } from '../config/env.js';
import { CarrierError } from '../domain/errors.js';
import { createCarrierAAdapter } from './carrier-a/adapter.js';
import { createCarrierBAdapter } from './carrier-b/adapter.js';
import { createCarrierCAdapter } from './carrier-c/adapter.js';
import type { BrowserManager } from './shared/browser-manager.js';
import type { CarrierAdapter, CarrierDescriptor, RetrievalContext, RetrievalResult } from './types.js';

export interface CredentialIssue {
  path: string;
  message: string;
}

/**
 * A registered carrier with its credential type erased behind closures, so the core can
 * hold heterogeneous adapters without `any` and without knowing their credential shapes.
 */
export interface RegisteredCarrier {
  readonly descriptor: CarrierDescriptor;
  /** Max tasks for this carrier in flight per worker process. */
  readonly concurrency: number;
  validateCredentials(raw: unknown): CredentialIssue[];
  retrieve(rawCredentials: unknown, ctx: RetrievalContext): Promise<RetrievalResult>;
}

export class CarrierRegistry {
  private readonly carriers = new Map<string, RegisteredCarrier>();

  register<T>(adapter: CarrierAdapter<T>, options: { concurrency: number }): this {
    const { id } = adapter.descriptor;
    if (this.carriers.has(id)) throw new Error(`carrier '${id}' is already registered`);
    this.carriers.set(id, {
      descriptor: adapter.descriptor,
      concurrency: options.concurrency,
      validateCredentials: (raw) => {
        const result = adapter.credentialsSchema.safeParse(raw);
        // Zod issue messages describe the rule, never the rejected value.
        return result.success ? [] : result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
      },
      retrieve: (rawCredentials, ctx) => {
        const parsed = adapter.credentialsSchema.safeParse(rawCredentials);
        if (!parsed.success) {
          throw new CarrierError({
            carrierId: id,
            category: 'internal',
            code: 'invalid_stored_credentials',
            message: 'Stored credentials no longer match the adapter schema',
          });
        }
        return adapter.retrievePolicies(parsed.data, ctx);
      },
    });
    return this;
  }

  get(id: string): RegisteredCarrier | undefined {
    return this.carriers.get(id);
  }

  has(id: string): boolean {
    return this.carriers.has(id);
  }

  list(): RegisteredCarrier[] {
    return [...this.carriers.values()];
  }
}

export function createDefaultRegistry(config: AppConfig, browser: BrowserManager): CarrierRegistry {
  const { carriers } = config;
  return new CarrierRegistry()
    .register(createCarrierAAdapter({ baseUrl: carriers['carrier-a'].baseUrl, http: config.carrierHttp }), {
      concurrency: carriers['carrier-a'].concurrency,
    })
    .register(createCarrierBAdapter({ baseUrl: carriers['carrier-b'].baseUrl, http: config.carrierHttp }), {
      concurrency: carriers['carrier-b'].concurrency,
    })
    .register(
      createCarrierCAdapter({
        baseUrl: carriers['carrier-c'].baseUrl,
        navigationTimeoutMs: config.browser.navigationTimeoutMs,
        browser,
      }),
      { concurrency: carriers['carrier-c'].concurrency },
    );
}
