import { z } from 'zod';

/**
 * Tolerant-reader schemas for Carrier A. Envelopes (token, page) are validated strictly
 * enough that a structurally wrong response fails fast as `invalid_response`; individual
 * policy fields are mostly optional because the normalizer decides what is required.
 */
const Money = z.object({ amount: z.union([z.string(), z.number()]), currency: z.string().nullish() });

export const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string(),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).optional(),
});

export const OAuthErrorSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});

export const PolicyListPageSchema = z.object({
  data: z.array(z.object({ policyNumber: z.string().min(1) })),
  page: z.object({ nextCursor: z.string().min(1).nullable() }),
});

export const PolicyDetailSchema = z.object({
  policyNumber: z.string().nullish(),
  lineOfBusiness: z.string().nullish(),
  status: z.string().nullish(),
  term: z
    .object({
      effectiveDate: z.string().nullish(),
      expirationDate: z.string().nullish(),
      lengthMonths: z.number().nullish(),
    })
    .nullish(),
  premium: z.object({ total: Money.nullish() }).nullish(),
  insured: z.object({ givenName: z.string().nullish(), familyName: z.string().nullish() }).nullish(),
  coverages: z
    .array(
      z.object({
        code: z.string().nullish(),
        limit: z
          .object({ perPerson: Money.nullish(), perOccurrence: Money.nullish(), amount: Money.nullish() })
          .nullish(),
        deductible: Money.nullish(),
      }),
    )
    .nullish(),
  vehicles: z
    .array(
      z.object({
        vin: z.string().nullish(),
        year: z.union([z.number(), z.string()]).nullish(),
        make: z.string().nullish(),
        model: z.string().nullish(),
      }),
    )
    .nullish(),
  drivers: z.array(z.object({ givenName: z.string().nullish(), familyName: z.string().nullish() })).nullish(),
});

export type CarrierAPolicyDetail = z.infer<typeof PolicyDetailSchema>;
