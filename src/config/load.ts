/**
 * Config loading pipeline:
 *
 *   read YAML -> resolve ABI files -> substitute ${...} -> merge imports
 *   -> apply templates and presets -> validate (schema) -> normalize (ABI-aware)
 *
 * Each file is resolved relative to its own directory, so imported files can use
 * relative ABI paths and ${file:...} references.
 */

import * as path from 'node:path';
import type { z } from 'zod';
import { ConfigurationError, ValidationError } from '../common/errors';
import { PRESETS } from '../presets';
import { loadAbiFile } from './abi';
import { resolveConfinedPath } from './paths';
import { ConfigSchema, PRESET_NAMES, StateEntrySchema, type RawConfig } from './schema';
import { substituteVariables } from './substitute';
import { readYamlFile } from './yaml';
import { normalize, type NormalizedConfig } from './normalize';

export interface LoadOptions {
  /** Environment used for ${VAR} substitution (default: process.env). */
  env?: NodeJS.ProcessEnv;
  /**
   * Directories that file references may point into, in addition to the config file's own
   * directory (default: the current working directory).
   */
  roots?: string[];
}

type Json = Record<string, unknown>;

const TOP_LEVEL_KEYS = new Set(['version', 'network', 'imports', 'templates', 'contracts']);

const STATE_TYPES = StateEntrySchema.options.map((option) => option.shape.type.value);

const DID_YOU_MEAN: Record<string, string> = {
  expected: 'value',
  variable: 'name',
  role_name: 'role',
  includes: 'imports',
  decode_as: 'options.decode_as',
  tolerance: 'options.tolerance',
  range: 'options.range',
  pattern: 'options.pattern',
  ignore_case: 'options.ignore_case',
  description: 'options.description',
};

const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function resolveAbiRefs(data: Json, baseDir: string, roots: readonly string[]): void {
  for (const section of ['contracts', 'templates']) {
    const entries = data[section];
    if (!isObject(entries)) continue;
    for (const entry of Object.values(entries)) {
      if (isObject(entry) && typeof entry.abi === 'string') {
        entry.abi = loadAbiFile(entry.abi, baseDir, roots);
      }
    }
  }
}

function mergeLayers(base: Json, over: Json): Json {
  const merged: Json = { ...base, ...over };
  if (over.network === undefined && base.network !== undefined) merged.network = base.network;
  for (const key of ['templates', 'contracts']) {
    if (isObject(base[key]) || isObject(over[key])) {
      merged[key] = { ...(base[key] as Json | undefined), ...(over[key] as Json | undefined) };
    }
  }
  return merged;
}

function loadFile(file: string, env: NodeJS.ProcessEnv, roots: readonly string[], stack: string[]): Json {
  if (stack.includes(file)) {
    throw new ConfigurationError(`Import cycle: ${[...stack, file].join(' -> ')}`);
  }
  const baseDir = path.dirname(file);
  const allowedRoots = [...roots, baseDir];
  const data = readYamlFile(file);

  const unknownKeys = Object.keys(data).filter((key) => !TOP_LEVEL_KEYS.has(key));
  if (unknownKeys.length > 0) {
    const hints = unknownKeys.map((k) => (DID_YOU_MEAN[k] ? `${k} (did you mean '${DID_YOU_MEAN[k]}'?)` : k));
    throw new ValidationError(`Unknown top-level key(s) in ${file}: ${hints.join(', ')}`);
  }

  resolveAbiRefs(data, baseDir, allowedRoots);
  const resolved = substituteVariables(data, { env, baseDir, roots: allowedRoots, file });

  const imports = resolved.imports;
  if (imports !== undefined && (!Array.isArray(imports) || imports.some((i) => typeof i !== 'string'))) {
    throw new ConfigurationError(`'imports' in ${file} must be a list of file paths`);
  }
  let merged: Json = {};
  for (const ref of (imports as string[] | undefined) ?? []) {
    const target = resolveConfinedPath(ref, baseDir, allowedRoots, 'Imported file');
    merged = mergeLayers(merged, loadFile(target, env, roots, [...stack, file]));
  }
  return mergeLayers(merged, resolved);
}

function toEntryList(state: unknown): unknown[] {
  if (Array.isArray(state)) return state;
  if (isObject(state)) {
    return Object.entries(state).map(([key, entry]) => (isObject(entry) ? { id: key, ...entry } : entry));
  }
  return [];
}

function mergeState(base: unknown, over: unknown): unknown {
  if (base === undefined) return over;
  if (over === undefined) return base;
  if (isObject(base) && isObject(over)) return { ...base, ...over };
  return [...toEntryList(base), ...toEntryList(over)];
}

function mergeAbi(base: unknown, over: unknown): unknown {
  if (base === undefined) return over;
  if (over === undefined) return base;
  return [...(Array.isArray(base) ? base : []), ...(Array.isArray(over) ? over : [])];
}

function applyTemplatesAndPresets(config: Json): void {
  const contracts = config.contracts;
  if (!isObject(contracts)) return;
  const templates = isObject(config.templates) ? config.templates : {};
  for (const [name, value] of Object.entries(contracts)) {
    if (!isObject(value)) continue;
    let contract = value;
    if (typeof contract.template === 'string') {
      const template = templates[contract.template];
      if (!isObject(template)) {
        const available = Object.keys(templates).join(', ') || 'none defined';
        throw new ConfigurationError(
          `Contract '${name}' uses unknown template '${contract.template}' (available: ${available})`,
        );
      }
      contract = {
        ...template,
        ...contract,
        abi: mergeAbi(template.abi, contract.abi),
        state: mergeState(template.state, contract.state),
      };
    }
    const preset = contract.preset;
    if (typeof preset === 'string' && (PRESET_NAMES as readonly string[]).includes(preset)) {
      contract = { ...contract, abi: mergeAbi(PRESETS[preset as keyof typeof PRESETS].abi, contract.abi) };
    }
    for (const key of Object.keys(contract)) {
      if (contract[key] === undefined) delete contract[key];
    }
    contracts[name] = contract;
  }
}

function formatPath(issuePath: PropertyKey[]): string {
  return issuePath
    .map((part, i) => (typeof part === 'number' ? `[${part}]` : `${i === 0 ? '' : '.'}${String(part)}`))
    .join('');
}

type Issue = z.core.$ZodIssue;

/**
 * Unions report one error list per alternative. Pick the alternative that got furthest
 * (deepest paths, then fewest problems) so users see "unknown key 'expected'" rather than
 * "expected record, received array".
 */
function flatten(issue: Issue, prefix: PropertyKey[] = []): Issue[] {
  const path = [...prefix, ...issue.path];
  if (issue.code === 'invalid_union' && issue.errors.length > 0) {
    const depth = (list: Issue[]) => Math.max(...list.map((i) => i.path.length));
    const best = [...issue.errors].sort((a, b) => depth(b) - depth(a) || a.length - b.length)[0];
    return best.flatMap((nested) => flatten(nested, path));
  }
  return [{ ...issue, path }];
}

export function formatZodIssues(error: z.ZodError): string[] {
  const messages: string[] = [];
  for (const issue of error.issues.flatMap((i) => flatten(i))) {
    const where = formatPath(issue.path) || '(root)';
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        const hint = DID_YOU_MEAN[key] ? ` (did you mean '${DID_YOU_MEAN[key]}'?)` : '';
        messages.push(`${where}: unknown key '${key}'${hint}`);
      }
    } else if (issue.code === 'invalid_union' && 'discriminator' in issue) {
      messages.push(`${where}: must be one of ${STATE_TYPES.join(', ')}`);
    } else if (issue.code === 'invalid_type' && /received undefined$/.test(issue.message)) {
      messages.push(`${where}: required`);
    } else {
      messages.push(`${where}: ${issue.message}`);
    }
  }
  return [...new Set(messages)];
}

/** Read, resolve and schema-validate a config file without ABI-aware checks. */
export function loadRawConfig(file: string, options: LoadOptions = {}): RawConfig {
  const absolute = path.resolve(file);
  const roots = options.roots ?? [process.cwd()];
  const merged = loadFile(absolute, options.env ?? process.env, roots, []);
  applyTemplatesAndPresets(merged);
  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    throw new ValidationError(`Invalid config ${file}`, formatZodIssues(parsed.error));
  }
  return parsed.data;
}

/** Load a config file and resolve it into checks ready to run. */
export function loadConfig(file: string, options: LoadOptions = {}): NormalizedConfig {
  return normalize(loadRawConfig(file, options), displayPath(file));
}

/** Reports show paths relative to the working directory so local layouts don't leak into logs. */
function displayPath(file: string): string {
  const relative = path.relative(process.cwd(), path.resolve(file));
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : path.basename(file);
}
