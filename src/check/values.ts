/**
 * Typed values. Expected values from YAML and decoded on-chain values are both converted
 * to the same representation, driven by the ABI type, so comparison is exact:
 *
 *   int/uint  -> bigint          address -> EIP-55 checksummed string
 *   bool      -> boolean         bytes   -> lowercase hex string
 *   string    -> string          arrays  -> Typed[]   tuples -> object (named) or Typed[]
 */

import { ParamType, getAddress, isAddress, parseUnits } from 'ethers';

export type Typed = bigint | string | boolean | Typed[] | { [key: string]: Typed };

export class CoercionError extends Error {}

const INT_TYPE = /^(u?)int(\d*)$/;
const FIXED_BYTES = /^bytes(\d+)$/;

export function isIntegerType(type: ParamType): boolean {
  return INT_TYPE.test(type.baseType);
}

/**
 * Parse an integer written in any of the forms people use in configs: 1000, "1000",
 * "1_000", "0x3e8", "1e21", "1.5 ether", "30 gwei". Returns undefined if the value is not
 * an exact integer (so 1.5 or "abc" never round silently).
 */
export function parseInteger(value: unknown): bigint | undefined {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : undefined;
  if (typeof value !== 'string') return undefined;
  const text = value.trim().replace(/_/g, '');
  const negative = text.startsWith('-');
  const body = negative ? text.slice(1) : text;
  let result: bigint | undefined;
  if (/^\d+$/.test(body)) {
    result = BigInt(body);
  } else if (/^0x[0-9a-fA-F]+$/.test(body)) {
    result = BigInt(body);
  } else {
    const scientific = /^(\d+)(?:\.(\d+))?e(\d+)$/i.exec(body);
    const units = /^(\d+(?:\.\d+)?)\s*(wei|gwei|ether)$/i.exec(body);
    if (scientific) {
      const [, whole, fraction = '', exponent] = scientific;
      const shift = Number(exponent) - fraction.length;
      if (shift < 0) {
        const kept = fraction.slice(0, fraction.length + shift);
        if (/[^0]/.test(fraction.slice(kept.length))) return undefined;
        result = BigInt(whole + kept);
      } else {
        result = BigInt(whole + fraction) * 10n ** BigInt(shift);
      }
    } else if (units) {
      try {
        result = parseUnits(units[1], units[2].toLowerCase());
      } catch {
        return undefined;
      }
    }
  }
  if (result === undefined) return undefined;
  return negative ? -result : result;
}

function checkIntRange(value: bigint, type: ParamType): void {
  const [, unsigned, bitsText] = INT_TYPE.exec(type.baseType) ?? [];
  const bits = BigInt(bitsText || '256');
  if (unsigned === 'u') {
    if (value < 0n || value >= 1n << bits) throw new CoercionError(`${value} does not fit in ${type.baseType}`);
  } else if (value < -(1n << (bits - 1n)) || value >= 1n << (bits - 1n)) {
    throw new CoercionError(`${value} does not fit in ${type.baseType}`);
  }
}

function describe(value: unknown): string {
  return typeof value === 'string' ? `"${value}"` : (JSON.stringify(value) ?? String(value));
}

/** Convert a YAML value into the typed representation of `type`, or throw CoercionError. */
export function coerce(value: unknown, type: ParamType): Typed {
  const base = type.baseType;

  if (base === 'array') {
    if (!Array.isArray(value)) throw new CoercionError(`expected a list for ${type.format()}, got ${describe(value)}`);
    if (type.arrayLength !== null && type.arrayLength >= 0 && value.length !== type.arrayLength) {
      throw new CoercionError(`expected ${type.arrayLength} items for ${type.format()}, got ${value.length}`);
    }
    return value.map((item) => coerce(item, type.arrayChildren!));
  }

  if (base === 'tuple') {
    const components = type.components ?? [];
    const named = components.length > 0 && components.every((c) => c.name);
    if (Array.isArray(value)) {
      if (value.length !== components.length) {
        throw new CoercionError(`expected ${components.length} values for ${type.format()}, got ${value.length}`);
      }
      const items = components.map((c, i) => coerce(value[i], c));
      return named ? Object.fromEntries(components.map((c, i) => [c.name, items[i]])) : items;
    }
    if (value !== null && typeof value === 'object' && named) {
      const record = value as Record<string, unknown>;
      const unknownKeys = Object.keys(record).filter((k) => !components.some((c) => c.name === k));
      if (unknownKeys.length > 0)
        throw new CoercionError(`unknown field(s) ${unknownKeys.join(', ')} for ${type.format()}`);
      return Object.fromEntries(
        components.map((c) => {
          if (!(c.name in record)) throw new CoercionError(`missing field '${c.name}' for ${type.format()}`);
          return [c.name, coerce(record[c.name], c)];
        }),
      );
    }
    throw new CoercionError(`expected a list or mapping for ${type.format()}, got ${describe(value)}`);
  }

  if (base === 'address') {
    if (typeof value === 'string' && isAddress(value)) return getAddress(value);
    throw new CoercionError(`${describe(value)} is not a valid address (check the checksum casing)`);
  }

  if (base === 'bool') {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string' && /^(true|false)$/i.test(value.trim())) return value.trim().toLowerCase() === 'true';
    throw new CoercionError(`expected true or false, got ${describe(value)}`);
  }

  if (base === 'string') {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return String(value);
    throw new CoercionError(`expected a string, got ${describe(value)}`);
  }

  if (base === 'bytes' || FIXED_BYTES.test(base)) {
    if (typeof value !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(value)) {
      throw new CoercionError(`expected 0x-prefixed hex bytes for ${base}, got ${describe(value)}`);
    }
    const size = FIXED_BYTES.exec(base)?.[1];
    if (size !== undefined && (value.length - 2) / 2 !== Number(size)) {
      throw new CoercionError(`expected ${size} bytes for ${base}, got ${(value.length - 2) / 2}`);
    }
    return value.toLowerCase();
  }

  if (INT_TYPE.test(base)) {
    const parsed = parseInteger(value);
    if (parsed === undefined) throw new CoercionError(`expected an integer for ${base}, got ${describe(value)}`);
    checkIntRange(parsed, type);
    return parsed;
  }

  throw new CoercionError(`unsupported ABI type ${type.format()}`);
}

/** Convert a value decoded by ethers into the typed representation of `type`. */
export function fromDecoded(value: unknown, type: ParamType): Typed {
  const base = type.baseType;
  if (base === 'array')
    return Array.from(value as ArrayLike<unknown>, (item) => fromDecoded(item, type.arrayChildren!));
  if (base === 'tuple') {
    const components = type.components ?? [];
    const items = components.map((c, i) => fromDecoded((value as ArrayLike<unknown>)[i], c));
    const named = components.length > 0 && components.every((c) => c.name);
    return named ? Object.fromEntries(components.map((c, i) => [c.name, items[i]])) : items;
  }
  if (base === 'address') return getAddress(value as string);
  if (base === 'bool') return Boolean(value);
  if (base === 'string') return String(value);
  if (base === 'bytes' || FIXED_BYTES.test(base)) return String(value).toLowerCase();
  if (INT_TYPE.test(base)) return BigInt(value as bigint);
  throw new CoercionError(`unsupported ABI type ${type.format()}`);
}

/** Human-readable rendering. Integers print in full; nothing is rounded. */
export function formatTyped(value: unknown): string {
  if (value === undefined) return '(none)';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return String(value);
  return JSON.stringify(value, jsonReplacer);
}

/** JSON.stringify replacer that writes bigints as decimal strings. */
export function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/** Stable key used for set comparisons. */
export function canonical(value: Typed, ignoreCase = false): string {
  const text = JSON.stringify(value, jsonReplacer);
  return ignoreCase ? text.toLowerCase() : text;
}
