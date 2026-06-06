/**
 * Writes the generated OpenAPI document to docs/openapi.json and
 * docs/openapi.yaml. Run via `npm run openapi:export`.
 *
 * `npm run openapi:check` runs this against a temp dir and diffs, failing if the
 * committed spec is stale (wired into CI).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { buildOpenApiDocument } from '../src/openapi/document';

const outDir = process.env.OPENAPI_OUT_DIR ?? join(__dirname, '..', 'docs');
mkdirSync(outDir, { recursive: true });

const doc = buildOpenApiDocument();
const jsonPath = join(outDir, 'openapi.json');
const yamlPath = join(outDir, 'openapi.yaml');

writeFileSync(jsonPath, JSON.stringify(doc, null, 2) + '\n');
writeFileSync(yamlPath, stringify(doc));

// eslint-disable-next-line no-console
console.log(`Wrote ${jsonPath} and ${yamlPath}`);
