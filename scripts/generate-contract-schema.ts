import { writeFileSync } from 'node:fs';
import { normalizedPolicyJsonSchema } from '../src/contracts/json-schema.js';

const target = new URL('../docs/contracts/normalized-policy.v1.schema.json', import.meta.url);
writeFileSync(target, `${JSON.stringify(normalizedPolicyJsonSchema(), null, 2)}\n`);
console.log(`wrote ${target.pathname}`);
