/**
 * Fails if the committed docs/openapi.{json,yaml} are out of sync with the
 * spec generated from the zod schemas. Wired into CI so the published contract
 * can never silently drift from the code.
 *
 *   npm run openapi:check
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { buildOpenApiDocument } from '../src/openapi/document';

const docsDir = join(__dirname, '..', 'docs');
const doc = buildOpenApiDocument();

const expectedJson = JSON.stringify(doc, null, 2) + '\n';
const expectedYaml = stringify(doc);

function read(file: string): string {
  try {
    return readFileSync(join(docsDir, file), 'utf-8');
  } catch {
    return '';
  }
}

const problems: string[] = [];
if (read('openapi.json') !== expectedJson) problems.push('docs/openapi.json');
if (read('openapi.yaml') !== expectedYaml) problems.push('docs/openapi.yaml');

if (problems.length > 0) {
  // eslint-disable-next-line no-console
  console.error(
    `OpenAPI spec is out of date: ${problems.join(', ')}.\nRun \`npm run openapi:export\` and commit the result.`,
  );
  process.exit(1);
}

// eslint-disable-next-line no-console
console.log('OpenAPI spec is up to date.');
