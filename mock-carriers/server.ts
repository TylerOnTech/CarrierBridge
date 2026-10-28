import { startMockCarriers } from './index.js';

/**
 * Standalone entry point for local development and Docker Compose. The control plane
 * is enabled so the demo can inject faults (see docs/demo-script.md).
 */
const port = (name: string, fallback: number) => Number(process.env[name] ?? fallback);

const mocks = await startMockCarriers({
  host: process.env.MOCK_HOST ?? '0.0.0.0',
  ports: { a: port('CARRIER_A_PORT', 4001), b: port('CARRIER_B_PORT', 4002), c: port('CARRIER_C_PORT', 4003) },
  carrierA: {
    controlEnabled: true,
    rateLimit: { limit: Number(process.env.CARRIER_A_RATE_LIMIT ?? 20), windowMs: 1_000 },
  },
  carrierB: { controlEnabled: true, intermittentFailureEvery: Number(process.env.CARRIER_B_FAIL_EVERY ?? 3) },
  carrierC: { controlEnabled: true },
});

console.log(JSON.stringify({ msg: 'mock carriers listening', urls: mocks.urls }));

const shutdown = () => {
  void mocks.close().then(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
