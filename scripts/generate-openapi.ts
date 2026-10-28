import { writeFileSync } from 'node:fs';
import { buildOpenApiDocument } from '../src/http/openapi.js';

const target = new URL('../docs/openapi.json', import.meta.url);
writeFileSync(target, `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
console.log(`wrote ${target.pathname}`);
