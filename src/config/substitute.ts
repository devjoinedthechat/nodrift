/**
 * `${...}` substitution in config values.
 *
 *   ${VAR}                 environment variable (also ${env:VAR})
 *   ${VAR || default}      environment variable with a fallback
 *   ${file:path}           contents of a file (trailing whitespace trimmed)
 *   ${file:path:a.b}       a field from a JSON file
 *   $${...}                a literal "${...}"
 *
 * A value that is exactly one `${file:path:field}` reference takes the JSON type of the
 * field. Everything else produces a string. Unset variables are collected and reported
 * together. There is deliberately no command execution or expression evaluation.
 */

import * as fs from 'node:fs';
import { ConfigurationError } from '../common/errors';
import { resolveConfinedPath } from './paths';

export interface SubstitutionContext {
  env: NodeJS.ProcessEnv;
  baseDir: string;
  roots: readonly string[];
  file: string;
}

const TOKEN = /\$(\$)?\{([^}]*)\}/g;

function readJsonField(content: string, field: string, ref: string): unknown {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch (error) {
    throw new ConfigurationError(`\${file:${ref}} is not valid JSON: ${(error as Error).message}`);
  }
  let current: unknown = data;
  for (const part of field.split('.')) {
    if (current === null || typeof current !== 'object' || !(part in current)) {
      throw new ConfigurationError(`Field '${field}' not found in ${ref}`);
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function resolveToken(expr: string, ctx: SubstitutionContext, where: string, missing: string[]): unknown {
  const trimmed = expr.trim();

  const prefix = /^([a-z]+):/.exec(trimmed)?.[1];
  if (prefix === 'file') {
    const spec = trimmed.slice('file:'.length);
    const split = spec.lastIndexOf(':');
    const hasField = split > 0 && !/[\\/]/.test(spec.slice(split + 1));
    const ref = hasField ? spec.slice(0, split) : spec;
    const file = resolveConfinedPath(ref, ctx.baseDir, ctx.roots, 'Referenced file');
    const content = fs.readFileSync(file, 'utf8');
    return hasField ? readJsonField(content, spec.slice(split + 1), ref) : content.trimEnd();
  }
  if (prefix !== undefined && prefix !== 'env') {
    throw new ConfigurationError(
      `Unsupported substitution \${${trimmed}} at ${where}. ` +
        'Supported forms are ${VAR}, ${VAR || default}, ${env:VAR}, ${file:path} and ${file:path:field}.',
    );
  }

  const body = prefix === 'env' ? trimmed.slice('env:'.length) : trimmed;
  const [name, ...rest] = body.split('||');
  const variable = name.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) {
    throw new ConfigurationError(`Invalid variable name in \${${trimmed}} at ${where}`);
  }
  const value = ctx.env[variable];
  if (value !== undefined && value !== '') return value;
  if (rest.length > 0) return unquote(rest.join('||').trim());
  missing.push(`${variable} (used at ${where})`);
  return '';
}

function unquote(text: string): string {
  const match = /^(['"])(.*)\1$/.exec(text);
  return match ? match[2] : text;
}

function substituteString(value: string, ctx: SubstitutionContext, where: string, missing: string[]): unknown {
  const whole = /^\$\{([^}]*)\}$/.exec(value);
  if (whole) return resolveToken(whole[1], ctx, where, missing);
  return value.replace(TOKEN, (match, escaped: string | undefined, expr: string) =>
    escaped ? match.slice(1) : String(resolveToken(expr, ctx, where, missing)),
  );
}

function walk(value: unknown, ctx: SubstitutionContext, where: string, missing: string[]): unknown {
  if (typeof value === 'string') return substituteString(value, ctx, where, missing);
  if (Array.isArray(value)) return value.map((item, i) => walk(item, ctx, `${where}[${i}]`, missing));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      // ABIs are resolved before substitution and never contain placeholders.
      out[key] = key === 'abi' ? item : walk(item, ctx, where ? `${where}.${key}` : key, missing);
    }
    return out;
  }
  return value;
}

export function substituteVariables<T>(value: T, ctx: SubstitutionContext): T {
  const missing: string[] = [];
  const result = walk(value, ctx, '', missing) as T;
  if (missing.length > 0) {
    throw new ConfigurationError(
      `Environment variable${missing.length > 1 ? 's' : ''} not set in ${ctx.file}:\n  - ${missing.join('\n  - ')}`,
    );
  }
  return result;
}
