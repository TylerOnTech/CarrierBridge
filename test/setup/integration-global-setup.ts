import { execFileSync } from 'node:child_process';
import { TEST_DATABASE_URL } from '../helpers/config.js';

/**
 * Applies migrations to the dedicated test database (Prisma creates it if missing).
 * Every integration file truncates tables before each test, so runs are reproducible.
 */
export default function setup(): void {
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'pipe',
  });
}
