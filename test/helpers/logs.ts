import { Writable } from 'node:stream';
import { createLogger, type Logger } from '../../src/logging/logger.js';

/** A real pino logger whose output is captured in memory, for asserting on log content. */
export function captureLogger(level = 'debug'): { logger: Logger; lines: string[]; text: () => string } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(...chunk.toString('utf8').split('\n').filter(Boolean));
      callback();
    },
  });
  const logger = createLogger({ level, pretty: false }, stream);
  return { logger, lines, text: () => lines.join('\n') };
}
