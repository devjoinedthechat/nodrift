/** YAML parsing with a schema that never loses precision. */

import * as fs from 'node:fs';
import * as yaml from 'js-yaml';
import { ConfigurationError } from '../common/errors';

/**
 * Integers are only parsed as numbers when they are plain decimals that fit in a double
 * without rounding. Hex (`0x...`), octal, floats and large integers stay strings, so an
 * unquoted address or a uint256 amount is never silently rounded.
 */
const safeInt = new yaml.Type('tag:yaml.org,2002:int', {
  kind: 'scalar',
  resolve: (data: string) => /^[-+]?(0|[1-9][0-9]*)$/.test(data) && Number.isSafeInteger(Number(data)),
  construct: (data: string) => Number(data),
  predicate: (object: unknown) => typeof object === 'number' && Number.isSafeInteger(object),
  represent: (object: object) => String(object),
});

// js-yaml exports its built-in types at runtime, but @types/js-yaml does not declare them.
const builtin = (yaml as unknown as { types: Record<'null' | 'bool', yaml.Type> }).types;

export const SAFE_YAML_SCHEMA = yaml.FAILSAFE_SCHEMA.extend({
  implicit: [builtin.null, builtin.bool, safeInt],
});

export function parseYaml(text: string, file: string): unknown {
  try {
    return yaml.load(text, { schema: SAFE_YAML_SCHEMA, filename: file });
  } catch (error) {
    if (error instanceof yaml.YAMLException) {
      const where = error.mark ? ` (line ${error.mark.line + 1}, column ${error.mark.column + 1})` : '';
      throw new ConfigurationError(`Invalid YAML in ${file}${where}: ${error.reason}`);
    }
    throw error;
  }
}

export function readYamlFile(file: string): Record<string, unknown> {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new ConfigurationError(
      code === 'ENOENT' ? `Config file not found: ${file}` : `Cannot read ${file}: ${(error as Error).message}`,
    );
  }
  const data = parseYaml(text, file);
  if (data === null || data === undefined) {
    throw new ConfigurationError(`Config file is empty: ${file}`);
  }
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new ConfigurationError(`Config file must contain a mapping at the top level: ${file}`);
  }
  return data as Record<string, unknown>;
}
