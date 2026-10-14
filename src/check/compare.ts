/** Exact comparison of typed values. No floating point anywhere. */

import type { Operator } from '../config/schema';
import { CheckError } from '../common/errors';
import { canonical, formatTyped, parseInteger, type Typed } from './values';

export type Tolerance =
  | { kind: 'absolute'; amount: bigint; text: string }
  | { kind: 'relative'; numerator: bigint; denominator: bigint; text: string };

export interface Expectation {
  operator: Operator;
  /** Absent when the check uses `range` or `pattern` instead of a value. */
  expected?: Typed;
  tolerance?: Tolerance;
  range?: { min?: bigint; max?: bigint };
  pattern?: RegExp;
  ignoreCase?: boolean;
  ignoreOrder?: boolean;
}

export interface Outcome {
  ok: boolean;
  /** What was expected, rendered for reports (e.g. ">= 100", "matches /^USD/"). */
  expectedText: string;
}

/** Parse "1000", 1000, "1 gwei" (absolute) or "0.5%" (relative to the expected value). */
export function parseTolerance(input: string | number): Tolerance | undefined {
  const text = String(input).trim();
  const percent = /^(\d+)(?:\.(\d+))?\s*%$/.exec(text);
  if (percent) {
    const [, whole, fraction = ''] = percent;
    return {
      kind: 'relative',
      numerator: BigInt(whole + fraction),
      denominator: 100n * 10n ** BigInt(fraction.length),
      text,
    };
  }
  const amount = parseInteger(input);
  if (amount === undefined || amount < 0n) return undefined;
  return { kind: 'absolute', amount, text };
}

const abs = (n: bigint): bigint => (n < 0n ? -n : n);

function withinTolerance(actual: bigint, expected: bigint, tolerance: Tolerance): boolean {
  const delta = abs(actual - expected);
  if (tolerance.kind === 'absolute') return delta <= tolerance.amount;
  return delta * tolerance.denominator <= abs(expected) * tolerance.numerator;
}

export function deepEqual(a: Typed, b: Typed, options: { ignoreCase?: boolean; ignoreOrder?: boolean } = {}): boolean {
  if (typeof a === 'bigint' || typeof b === 'bigint') return a === b;
  if (typeof a === 'string' && typeof b === 'string') {
    return options.ignoreCase ? a.toLowerCase() === b.toLowerCase() : a === b;
  }
  if (typeof a === 'boolean' || typeof b === 'boolean') return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    if (options.ignoreOrder) {
      const left = a.map((x) => canonical(x, options.ignoreCase)).sort();
      const right = b.map((x) => canonical(x, options.ignoreCase)).sort();
      return left.every((x, i) => x === right[i]);
    }
    return a.every((x, i) => deepEqual(x, b[i], options));
  }
  if (
    a !== null &&
    b !== null &&
    typeof a === 'object' &&
    typeof b === 'object' &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((k) => k in b && deepEqual(a[k], b[k], options));
  }
  return false;
}

export function compareOrdered(actual: Typed, operator: Operator, expected: Typed): boolean {
  if (typeof actual !== 'bigint' || typeof expected !== 'bigint') {
    throw new CheckError(
      `operator ${operator} needs numeric values, got ${formatTyped(actual)} and ${formatTyped(expected)}`,
    );
  }
  switch (operator) {
    case '>':
      return actual > expected;
    case '>=':
      return actual >= expected;
    case '<':
      return actual < expected;
    case '<=':
      return actual <= expected;
    case '==':
      return actual === expected;
    case '!=':
      return actual !== expected;
  }
}

export function evaluateExpectation(actual: Typed, expectation: Expectation): Outcome {
  const { operator, expected, tolerance, range, pattern } = expectation;

  if (pattern) {
    const text = typeof actual === 'bigint' ? actual.toString() : actual;
    if (typeof text !== 'string') throw new CheckError(`pattern needs a string value, got ${formatTyped(actual)}`);
    return { ok: pattern.test(text), expectedText: `matches ${pattern}` };
  }

  if (range) {
    if (typeof actual !== 'bigint') throw new CheckError(`range needs a numeric value, got ${formatTyped(actual)}`);
    const ok = (range.min === undefined || actual >= range.min) && (range.max === undefined || actual <= range.max);
    return { ok, expectedText: `in [${range.min ?? '-inf'}, ${range.max ?? '+inf'}]` };
  }

  if (expected === undefined) throw new CheckError('no expected value');

  if (operator === '==' || operator === '!=') {
    let equal: boolean;
    if (tolerance) {
      if (typeof actual !== 'bigint' || typeof expected !== 'bigint') {
        throw new CheckError('tolerance needs numeric values');
      }
      equal = withinTolerance(actual, expected, tolerance);
    } else {
      equal = deepEqual(actual, expected, expectation);
    }
    const suffix = tolerance ? ` (± ${tolerance.text})` : '';
    return {
      ok: operator === '==' ? equal : !equal,
      expectedText: `${operator === '!=' ? '!= ' : ''}${formatTyped(expected)}${suffix}`,
    };
  }

  return { ok: compareOrdered(actual, operator, expected), expectedText: `${operator} ${formatTyped(expected)}` };
}
