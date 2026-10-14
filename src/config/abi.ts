/** ABI loading (plain ABI or Foundry/Hardhat/Truffle artifact) and Interface construction. */

import * as fs from 'node:fs';
import { Fragment, Interface } from 'ethers';
import { ConfigurationError } from '../common/errors';
import { resolveConfinedPath } from './paths';

export type AbiInput = Array<Record<string, unknown> | string>;

/** Accepts `./abi.json` or the legacy `${file:./abi.json}` form. */
export function loadAbiFile(ref: string, baseDir: string, roots: readonly string[]): AbiInput {
  const match = /^\$\{file:(.+?)\}$/.exec(ref.trim());
  const file = resolveConfinedPath(match ? match[1] : ref.trim(), baseDir, roots, 'ABI file');
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ConfigurationError(`ABI file ${ref} is not valid JSON: ${(error as Error).message}`);
  }
  if (Array.isArray(data)) return data as AbiInput;
  if (data !== null && typeof data === 'object' && Array.isArray((data as { abi?: unknown }).abi)) {
    return (data as { abi: AbiInput }).abi;
  }
  throw new ConfigurationError(
    `ABI file ${ref} must contain an ABI array or an artifact with an "abi" field (Foundry, Hardhat, Truffle)`,
  );
}

/** Build an Interface, dropping exact duplicates (presets and user ABIs often overlap). */
export function buildInterface(abi: AbiInput, issues: string[], where: string): Interface {
  const seen = new Set<string>();
  const fragments: Fragment[] = [];
  abi.forEach((item, index) => {
    let fragment: Fragment;
    try {
      fragment = Fragment.from(item as never);
    } catch (error) {
      issues.push(`${where}.abi[${index}]: invalid ABI entry (${(error as Error).message})`);
      return;
    }
    // Functions, events and errors are identified by signature; constructor/fallback/receive by kind.
    const named = fragment.type === 'function' || fragment.type === 'event' || fragment.type === 'error';
    const key = named ? `${fragment.type}:${fragment.format('sighash')}` : fragment.type;
    if (!seen.has(key)) {
      seen.add(key);
      fragments.push(fragment);
    }
  });
  return new Interface(fragments);
}
