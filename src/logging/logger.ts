import { pino, stdSerializers, stdTimeFunctions, type DestinationStream, type Logger, type LoggerOptions } from 'pino';

export type { Logger };

/**
 * Defense in depth: credentials are wrapped in `Secret` and never intentionally logged,
 * but any field with a sensitive name is redacted wherever it appears (up to 3 levels deep).
 */
const SENSITIVE_KEYS = [
  'password',
  'credentials',
  'authorization',
  'cookie',
  'accessToken',
  'refreshToken',
  'access_token',
  'refresh_token',
  'sessionKey',
  'SessionKey',
  'token',
];

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  ...SENSITIVE_KEYS.flatMap((k) => [k, `*.${k}`, `*.*.${k}`]),
];

export interface LoggerConfig {
  level: string;
  pretty: boolean;
}

export function createLogger(config: LoggerConfig, destination?: DestinationStream): Logger {
  const options: LoggerOptions = {
    level: config.level,
    base: { service: 'carrierbridge' },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    timestamp: stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    serializers: { err: stdSerializers.err, error: stdSerializers.err },
  };
  if (destination) return pino(options, destination);
  if (config.pretty) {
    return pino({ ...options, transport: { target: 'pino-pretty', options: { singleLine: true } } });
  }
  return pino(options);
}
