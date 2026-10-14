/**
 * Generate nodrift.schema.json (IDE validation and autocompletion for configs) from the Zod
 * schema in src/config/schema.ts. A unit test fails when the committed file is out of date.
 *
 *   npm run schema
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { ConfigSchema } from '../src/config/schema';

export const SCHEMA_PATH = path.resolve(__dirname, '../nodrift.schema.json');

export function buildJsonSchema(): string {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(ConfigSchema, { io: 'input', target: 'draft-7' }) as Record<
    string,
    unknown
  >;
  const document = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'https://raw.githubusercontent.com/devjoinedthechat/nodrift/main/nodrift.schema.json',
    title: 'nodrift configuration',
    description: 'Expected on-chain state for nodrift. Generated from src/config/schema.ts; do not edit by hand.',
    ...schema,
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

if (require.main === module) {
  fs.writeFileSync(SCHEMA_PATH, buildJsonSchema());
  process.stdout.write(`wrote ${path.relative(process.cwd(), SCHEMA_PATH)}\n`);
}
