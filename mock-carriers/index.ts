import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { createCarrierAApp, type CarrierAOptions } from './carrier-a/app.js';
import { createCarrierBApp, type CarrierBOptions } from './carrier-b/app.js';
import { createCarrierCApp, type CarrierCOptions } from './carrier-c/app.js';

export { createCarrierAApp, createCarrierBApp, createCarrierCApp };
export { PERSONAS } from './data/personas.js';

export interface MockCarrierOptions {
  ports?: { a?: number; b?: number; c?: number };
  host?: string;
  carrierA?: CarrierAOptions;
  carrierB?: CarrierBOptions;
  carrierC?: CarrierCOptions;
}

function listen(app: Express, port: number, host: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.once('error', reject);
  });
}

const urlOf = (server: Server, host: string): string => {
  const { port } = server.address() as AddressInfo;
  return `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
};

/** Starts all three mock carriers. Port 0 (the default) picks free ports, which tests rely on. */
export async function startMockCarriers(options: MockCarrierOptions = {}) {
  const host = options.host ?? '127.0.0.1';
  const a = createCarrierAApp(options.carrierA);
  const b = createCarrierBApp(options.carrierB);
  const c = createCarrierCApp(options.carrierC);
  const servers = await Promise.all([
    listen(a.app, options.ports?.a ?? 0, host),
    listen(b.app, options.ports?.b ?? 0, host),
    listen(c.app, options.ports?.c ?? 0, host),
  ]);
  const [sa, sb, sc] = servers;
  return {
    urls: { 'carrier-a': urlOf(sa, host), 'carrier-b': urlOf(sb, host), 'carrier-c': urlOf(sc, host) },
    carrierA: a.state,
    carrierB: b.state,
    carrierC: c.state,
    reset: () => {
      a.state.reset();
      b.state.reset();
      c.state.reset();
    },
    close: async () => {
      await Promise.all(
        servers.map(
          (s) =>
            new Promise<void>((resolve) => {
              s.closeAllConnections();
              s.close(() => resolve());
            }),
        ),
      );
    },
  };
}

export type MockCarriers = Awaited<ReturnType<typeof startMockCarriers>>;
