import { deepEqual, evaluateExpectation, parseTolerance, type Expectation } from '../../src/check/compare';
import { CheckError } from '../../src/common/errors';

const expect_ = (partial: Partial<Expectation>): Expectation => ({ operator: '==', ...partial });

describe('parseTolerance', () => {
  it('parses absolute and relative tolerances exactly', () => {
    expect(parseTolerance('0.5%')).toMatchObject({ kind: 'relative', numerator: 5n, denominator: 1000n });
    expect(parseTolerance('1%')).toMatchObject({ kind: 'relative', numerator: 1n, denominator: 100n });
    expect(parseTolerance(1000)).toMatchObject({ kind: 'absolute', amount: 1000n });
    expect(parseTolerance('1 gwei')).toMatchObject({ kind: 'absolute', amount: 1_000_000_000n });
    expect(parseTolerance('-1')).toBeUndefined();
    expect(parseTolerance('abc')).toBeUndefined();
  });
});

describe('evaluateExpectation', () => {
  it('applies relative tolerance at the exact boundary', () => {
    const tolerance = parseTolerance('0.5%')!;
    expect(evaluateExpectation(1005n, expect_({ expected: 1000n, tolerance })).ok).toBe(true);
    expect(evaluateExpectation(1006n, expect_({ expected: 1000n, tolerance })).ok).toBe(false);
    expect(evaluateExpectation(995n, expect_({ expected: 1000n, tolerance })).ok).toBe(true);
  });

  it('does not lose precision on 256-bit values', () => {
    const expected = 2n ** 255n;
    const tolerance = parseTolerance('0')!;
    expect(evaluateExpectation(expected + 1n, expect_({ expected, tolerance })).ok).toBe(false);
    expect(evaluateExpectation(expected + 1n, expect_({ expected, tolerance: parseTolerance('1')! })).ok).toBe(true);
  });

  it('supports ordering operators on integers only', () => {
    expect(evaluateExpectation(5n, expect_({ operator: '>', expected: 0n }))).toEqual({
      ok: true,
      expectedText: '> 0',
    });
    expect(evaluateExpectation(5n, expect_({ operator: '<=', expected: 4n })).ok).toBe(false);
    expect(evaluateExpectation(5n, expect_({ operator: '!=', expected: 4n })).ok).toBe(true);
    expect(() => evaluateExpectation('a', expect_({ operator: '>', expected: 'b' }))).toThrow(CheckError);
  });

  it('checks ranges and patterns', () => {
    expect(evaluateExpectation(5n, expect_({ range: { min: 1n, max: 5n } })).ok).toBe(true);
    expect(evaluateExpectation(6n, expect_({ range: { max: 5n } }))).toEqual({
      ok: false,
      expectedText: 'in [-inf, 5]',
    });
    expect(evaluateExpectation('USD Coin', expect_({ pattern: /^usd/i })).ok).toBe(true);
    expect(evaluateExpectation(1234n, expect_({ pattern: /^12/ })).ok).toBe(true);
    expect(() => evaluateExpectation(true, expect_({ pattern: /x/ }))).toThrow(/pattern needs a string/);
    expect(() => evaluateExpectation('x', expect_({ range: { min: 1n } }))).toThrow(/range needs a numeric/);
  });

  it('compares strings, arrays and structs', () => {
    expect(evaluateExpectation('ABC', expect_({ expected: 'abc', ignoreCase: true })).ok).toBe(true);
    expect(evaluateExpectation([1n, 2n], expect_({ expected: [2n, 1n] })).ok).toBe(false);
    expect(evaluateExpectation([1n, 2n], expect_({ expected: [2n, 1n], ignoreOrder: true })).ok).toBe(true);
    expect(deepEqual({ a: 1n, b: ['x'] }, { a: 1n, b: ['x'] })).toBe(true);
    expect(deepEqual({ a: 1n }, { a: 1n, b: 2n })).toBe(false);
    expect(deepEqual(1n, '1')).toBe(false);
  });

  it('requires numeric values for tolerance', () => {
    expect(() => evaluateExpectation('a', expect_({ expected: 'a', tolerance: parseTolerance('1')! }))).toThrow(
      /tolerance needs numeric/,
    );
  });
});
