import { z } from 'zod';

/**
 * Carrier B wraps every response in a "<Operation>Result" envelope with a ReturnCode.
 * HTTP status is 200 for application errors, so the envelope is the source of truth.
 */
export const AuthenticateResponseSchema = z.object({
  AuthenticateResult: z.object({
    ReturnCode: z.string(),
    ReturnMsg: z.string().optional(),
    SessionKey: z.string().min(1).optional(),
  }),
});

export const PolicyListResponseSchema = z.object({
  GetPolicyListResult: z.object({
    ReturnCode: z.string(),
    ReturnMsg: z.string().optional(),
    PolicyList: z.union([z.literal(''), z.object({ Policy: z.unknown() })]).nullish(),
  }),
});

/** Individual records are untyped string bags; the normalizer reads them field by field. */
export const LegacyPolicyRecordSchema = z.record(z.string(), z.unknown());
export type LegacyPolicyRecord = z.infer<typeof LegacyPolicyRecordSchema>;

export const RETURN_CODES = {
  SUCCESS: '0',
  INVALID_CREDENTIALS: '100',
  ACCOUNT_LOCKED: '110',
  INVALID_CLIENT_CODE: '120',
  SESSION_EXPIRED: '210',
} as const;
