import { AbiCoder, ParamType } from 'ethers';
import { CoercionError, coerce, formatTyped, fromDecoded, jsonReplacer, parseInteger } from '../../src/check/values';

describe('parseInteger', () => {
  it.each([
    [1000, 1000n],
    ['1000', 1000n],
    ['1_000_000', 1_000_000n],
    ['0x3e8', 1000n],
    ['-5', -5n],
    ['1e21', 10n ** 21n],
    ['1.5e3', 1500n],
    ['1.5 ether', 1_500_000_000_000_000_000n],
    ['30 gwei', 30_000_000_000n],
    ['7 wei', 7n],
    ['1000000000000000001000000', 1_000_000_000_000_000_001_000_000n],
  ])('parses %p exactly', (input, expected) => {
    expect(parseInteger(input)).toBe(expected);
  });

  it.each([1.5, '1.5', '1.25e1', 'abc', '', Number.MAX_SAFE_INTEGER + 2, '0.1 wei', null, true])(
    'refuses %p instead of rounding',
    (input) => {
      expect(parseInteger(input)).toBeUndefined();
    },
  );
});

describe('coerce', () => {
  const t = (type: string) => ParamType.from(type);

  it('checks integer bounds', () => {
    expect(coerce('255', t('uint8'))).toBe(255n);
    expect(() => coerce(256, t('uint8'))).toThrow(CoercionError);
    expect(() => coerce(-1, t('uint256'))).toThrow(/does not fit/);
    expect(coerce(-128, t('int8'))).toBe(-128n);
    expect(() => coerce(-129, t('int8'))).toThrow(CoercionError);
  });

  it('checksums addresses and rejects bad checksums', () => {
    expect(coerce('0x5fbdb2315678afecb367f032d93f642f64180aa3', t('address'))).toBe(
      '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    );
    expect(() => coerce('0x5FbDB2315678afecb367f032d93F642f64180aA3', t('address'))).toThrow(/checksum/);
    expect(() => coerce(12, t('address'))).toThrow(CoercionError);
  });

  it('accepts booleans written as text', () => {
    expect(coerce('TRUE', t('bool'))).toBe(true);
    expect(coerce(false, t('bool'))).toBe(false);
    expect(() => coerce('yes', t('bool'))).toThrow(/true or false/);
  });

  it('normalizes bytes and checks fixed sizes', () => {
    expect(coerce('0xABCD', t('bytes'))).toBe('0xabcd');
    expect(coerce('0x12345678', t('bytes4'))).toBe('0x12345678');
    expect(() => coerce('0x1234', t('bytes4'))).toThrow(/expected 4 bytes/);
    expect(() => coerce('0x123', t('bytes'))).toThrow(/hex bytes/);
  });

  it('converts strings, arrays and tuples', () => {
    expect(coerce(6, t('string'))).toBe('6');
    expect(coerce(['1', 2], t('uint256[]'))).toEqual([1n, 2n]);
    expect(() => coerce([1], t('uint256[2]'))).toThrow(/expected 2 items/);
    const tuple = ParamType.from('tuple(address owner, uint256 amount)');
    const owner = '0x1111111111111111111111111111111111111111';
    expect(coerce({ owner, amount: '5' }, tuple)).toEqual({ owner, amount: 5n });
    expect(coerce([owner, 5], tuple)).toEqual({ owner, amount: 5n });
    expect(() => coerce({ owner }, tuple)).toThrow(/missing field 'amount'/);
    expect(() => coerce({ owner, amount: 1, extra: 1 }, tuple)).toThrow(/unknown field/);
    expect(() => coerce('x', t('uint256[]'))).toThrow(/expected a list/);
  });
});

describe('fromDecoded', () => {
  it('converts decoded ABI values into typed values', () => {
    const type = ParamType.from('tuple(uint80 roundId, int256 answer, address feed, bytes4 tag, bool live)');
    const coder = AbiCoder.defaultAbiCoder();
    const feed = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
    const [decoded] = coder.decode([type], coder.encode([type], [[7, -5, feed, '0xDEADBEEF', true]]));
    expect(fromDecoded(decoded, type)).toEqual({ roundId: 7n, answer: -5n, feed, tag: '0xdeadbeef', live: true });
  });
});

describe('formatting', () => {
  it('prints integers in full and serializes bigints as strings', () => {
    expect(formatTyped(10n ** 30n)).toBe('1000000000000000000000000000000');
    expect(formatTyped(undefined)).toBe('(none)');
    expect(formatTyped([1n, 'a', true])).toBe('["1","a",true]');
    expect(JSON.stringify({ n: 2n ** 70n }, jsonReplacer)).toBe('{"n":"1180591620717411303424"}');
  });
});
