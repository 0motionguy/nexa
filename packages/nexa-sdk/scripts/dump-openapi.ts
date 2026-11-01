/**
 * F088 helper — dump the OpenAPI spec to .openapi.tmp.json by importing the
 * NEXA API's `getOpenApiDocument()` directly. Run via tsx (from the API
 * workspace's bin) so no build step is needed.
 */
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getOpenApiDocument } from '../../../apps/api/src/lib/openapi.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_FILE = resolve(__dirname, '..', '.openapi.tmp.json');

const doc = getOpenApiDocument();
writeFileSync(OUT_FILE, JSON.stringify(doc, null, 2));
console.log(`[dump-openapi] wrote ${OUT_FILE}`);
