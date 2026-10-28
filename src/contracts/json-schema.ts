import { z } from 'zod';
import { NORMALIZED_POLICY_SCHEMA_VERSION, NormalizedPolicySchema } from './normalized-policy.v1.js';

/** JSON Schema (draft 2020-12) for NormalizedPolicy v1, for consumers outside TypeScript. */
export function normalizedPolicyJsonSchema(): Record<string, unknown> {
  return {
    ...z.toJSONSchema(NormalizedPolicySchema, { target: 'draft-2020-12' }),
    $id: `urn:carrierbridge:contract:normalized-policy:${NORMALIZED_POLICY_SCHEMA_VERSION}`,
    title: `NormalizedPolicy v${NORMALIZED_POLICY_SCHEMA_VERSION}`,
  };
}
