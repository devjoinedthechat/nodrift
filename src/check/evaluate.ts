/** Evaluate normalized checks against a chain. Every check yields a result; nothing is dropped. */

import { AbiCoder, FunctionFragment, getAddress, getBytes, hexlify, toBigInt, fromTwos } from 'ethers';
import type { ChainClient } from '../chain/client';
import { CallRevertedError, describeRevert } from '../chain/revert';
import { CheckError, errorMessage } from '../common/errors';
import type { CallSpec, Check, ContractInfo, ValueSource } from '../config/normalize';
import type { Metric, StateType } from '../config/schema';
import { compareOrdered, deepEqual, evaluateExpectation } from './compare';
import { canonical, formatTyped, fromDecoded, type Typed } from './values';

export type CheckStatus = 'pass' | 'drift' | 'error' | 'skipped';

export interface CheckResult {
  contract: string;
  address: string;
  chainId: number;
  key: string;
  type: StateType;
  status: CheckStatus;
  /** On-chain value (pass/drift). */
  actual?: Typed;
  /** Rendered expectation, e.g. "1000000", ">= 5", "in [1, 10]". */
  expected?: string;
  /** Explanation for drift, error or skip. */
  message?: string;
  /** Set differences for membership checks. */
  missing?: Typed[];
  unexpected?: Typed[];
  description?: string;
  metric?: Metric;
}

export interface EvaluationContext {
  clientFor(contract: ContractInfo): ChainClient;
  /** Resolves to false when there is no code at the contract address. Cached per contract. */
  hasCode(contract: ContractInfo): Promise<boolean>;
}

type Outcome = Pick<CheckResult, 'status' | 'actual' | 'expected' | 'message' | 'missing' | 'unexpected'>;

const coder = AbiCoder.defaultAbiCoder();

const OWNER = FunctionFragment.from('function owner() view returns (address)');
const GET_OWNER = FunctionFragment.from('function getOwner() view returns (address)');
const HAS_ROLE = FunctionFragment.from('function hasRole(bytes32 role, address account) view returns (bool)');
const MEMBER_COUNT = FunctionFragment.from('function getRoleMemberCount(bytes32 role) view returns (uint256)');
const MEMBER = FunctionFragment.from('function getRoleMember(bytes32 role, uint256 index) view returns (address)');

const MAX_ROLE_MEMBERS = 10_000;

async function requireCode(contract: ContractInfo, ctx: EvaluationContext): Promise<void> {
  if (!(await ctx.hasCode(contract))) {
    const client = ctx.clientFor(contract);
    throw new CheckError(
      `no contract code at ${contract.address} on chain ${contract.network.chainId} (block ${client.block.number})`,
    );
  }
}

async function callFragment(
  contract: ContractInfo,
  fragment: FunctionFragment,
  args: readonly unknown[],
  ctx: EvaluationContext,
  label: string,
) {
  await requireCode(contract, ctx);
  const data = fragment.selector + coder.encode(fragment.inputs, args).slice(2);
  let raw: string;
  try {
    raw = await ctx.clientFor(contract).call(contract.address, data);
  } catch (error) {
    if (error instanceof CallRevertedError) {
      throw new CheckError(`${contract.name}.${label} ${describeRevert(error.data, contract.iface)}`);
    }
    throw error;
  }
  if (raw === '0x') {
    throw new CheckError(
      `${contract.name}.${label} returned no data; does ${contract.address} implement ${fragment.format()}?`,
    );
  }
  try {
    return coder.decode(fragment.outputs, raw);
  } catch (error) {
    throw new CheckError(
      `${contract.name}.${label} returned data that does not decode as (${fragment.outputs.map((o) => o.type).join(', ')}): ${errorMessage(error)}`,
    );
  }
}

async function readCall(call: CallSpec, ctx: EvaluationContext): Promise<Typed> {
  const decoded = await callFragment(call.contract, call.fragment, call.args, ctx, call.label);
  if (call.outputIndex !== undefined)
    return fromDecoded(decoded[call.outputIndex], call.fragment.outputs[call.outputIndex]);
  return fromDecoded(decoded, call.outType);
}

function readSource(source: ValueSource, ctx: EvaluationContext): Promise<Typed> {
  return source.kind === 'constant' ? Promise.resolve(source.value) : readCall(source.call, ctx);
}

async function readOwner(contract: ContractInfo, ctx: EvaluationContext): Promise<string> {
  try {
    return (await callFragment(contract, OWNER, [], ctx, 'owner()'))[0] as string;
  } catch (first) {
    // Only a contract-level failure (revert, no data) suggests trying the BEP-20 style getter.
    if (!(first instanceof CheckError)) throw first;
    try {
      return (await callFragment(contract, GET_OWNER, [], ctx, 'getOwner()'))[0] as string;
    } catch {
      throw first;
    }
  }
}

function fromExpectation(actual: Typed, ok: boolean, expected: string): Outcome {
  return { status: ok ? 'pass' : 'drift', actual, expected };
}

function decodeSlot(raw: string, check: Extract<Check, { kind: 'slot' }>): { value: Typed; message?: string } {
  const bytes = getBytes(raw);
  const { as, offset, size, strictAddress } = check.decode;
  const field = bytes.slice(32 - offset - size, 32 - offset);
  if (strictAddress && bytes.slice(0, 12).some((b) => b !== 0)) {
    return {
      value: hexlify(bytes),
      message:
        'slot holds more than an address (upper 12 bytes are non-zero); use options.offset/size for a packed field',
    };
  }
  switch (as) {
    case 'address':
      return { value: getAddress(hexlify(field)) };
    case 'bool':
      return { value: field.some((b) => b !== 0) };
    case 'uint256':
      return { value: toBigInt(field) };
    case 'int256':
      return { value: fromTwos(toBigInt(field), size * 8) };
    case 'bytes32':
      return { value: hexlify(field) };
  }
}

function aggregate(operation: string, values: Typed[]): bigint {
  if (operation === 'count')
    return BigInt(values.filter((v) => v === true || (typeof v === 'bigint' && v !== 0n)).length);
  const numbers = values.map((v) => {
    if (typeof v !== 'bigint') throw new CheckError(`${operation} needs integers, got ${formatTyped(v)}`);
    return v;
  });
  switch (operation) {
    case 'sum':
      return numbers.reduce((a, b) => a + b, 0n);
    case 'average':
      return numbers.reduce((a, b) => a + b, 0n) / BigInt(numbers.length);
    case 'min':
      return numbers.reduce((a, b) => (b < a ? b : a));
    case 'max':
      return numbers.reduce((a, b) => (b > a ? b : a));
    default:
      throw new CheckError(`unknown operation ${operation}`);
  }
}

async function evaluateOne(check: Check, ctx: EvaluationContext): Promise<Outcome> {
  switch (check.kind) {
    case 'value': {
      const actual = await readCall(check.call, ctx);
      const outcome = evaluateExpectation(actual, check.expect);
      return fromExpectation(actual, outcome.ok, outcome.expectedText);
    }

    case 'owner': {
      const actual = await readOwner(check.contract, ctx);
      return fromExpectation(actual, actual === check.expected, check.expected);
    }

    case 'has_role': {
      const [actual] = await callFragment(check.contract, HAS_ROLE, [check.role, check.account], ctx, 'hasRole');
      return fromExpectation(actual as boolean, actual === check.expected, String(check.expected));
    }

    case 'role_members': {
      let count: bigint;
      try {
        [count] = (await callFragment(
          check.contract,
          MEMBER_COUNT,
          [check.role],
          ctx,
          'getRoleMemberCount',
        )) as unknown as [bigint];
      } catch (error) {
        throw new CheckError(
          `${errorMessage(error)}. Listing role members needs AccessControlEnumerable; ` +
            "for plain AccessControl use 'account' with 'value: true|false' instead",
        );
      }
      if (count > BigInt(MAX_ROLE_MEMBERS))
        throw new CheckError(`role has ${count} members; refusing to list more than ${MAX_ROLE_MEMBERS}`);
      const members = await Promise.all(
        Array.from({ length: Number(count) }, async (_, i) =>
          getAddress(
            (await callFragment(check.contract, MEMBER, [check.role, i], ctx, `getRoleMember(${i})`))[0] as string,
          ),
        ),
      );
      const actualSet = new Set(members);
      const expectedSet = new Set(check.expected);
      const missing = check.expected.filter((m) => !actualSet.has(m));
      const unexpected = members.filter((m) => !expectedSet.has(m));
      const drift = missing.length > 0 || unexpected.length > 0;
      return {
        status: drift ? 'drift' : 'pass',
        actual: [...members].sort(),
        expected: formatTyped([...check.expected].sort()),
        ...(drift
          ? { missing, unexpected, message: `${missing.length} missing, ${unexpected.length} unexpected` }
          : {}),
      };
    }

    case 'slot': {
      await requireCode(check.contract, ctx);
      const raw = await ctx.clientFor(check.contract).getStorage(check.contract.address, check.slot);
      const { value, message } = decodeSlot(raw, check);
      if (message) return { status: 'drift', actual: value, expected: formatTyped(check.expect.expected), message };
      const outcome = evaluateExpectation(value, check.expect);
      return fromExpectation(value, outcome.ok, outcome.expectedText);
    }

    case 'array': {
      const items = (await readCall(check.call, ctx)) as Typed[];
      const opts = { ignoreCase: check.ignoreCase, ignoreOrder: check.ignoreOrder };
      const has = (needle: Typed) => items.some((item) => deepEqual(item, needle, opts));
      switch (check.check) {
        case 'length': {
          const length = BigInt(items.length);
          return fromExpectation(length, length === check.expectedLength, `length ${check.expectedLength}`);
        }
        case 'contains': {
          const missing = check.expectedItems!.filter((x) => !has(x));
          return {
            status: missing.length > 0 ? 'drift' : 'pass',
            actual: items,
            expected: `contains ${formatTyped(check.expectedItems)}`,
            ...(missing.length > 0 ? { missing, message: `${missing.length} expected item(s) missing` } : {}),
          };
        }
        case 'not_contains': {
          const unexpected = check.expectedItems!.filter(has);
          return {
            status: unexpected.length > 0 ? 'drift' : 'pass',
            actual: items,
            expected: `does not contain ${formatTyped(check.expectedItems)}`,
            ...(unexpected.length > 0 ? { unexpected, message: `${unexpected.length} forbidden item(s) present` } : {}),
          };
        }
        case 'exact': {
          const ok = deepEqual(items, check.expectedItems!, opts);
          const outcome = fromExpectation(items, ok, formatTyped(check.expectedItems));
          if (!ok) {
            const key = (v: Typed) => canonical(v, check.ignoreCase);
            const actualKeys = new Set(items.map(key));
            const expectedKeys = new Set(check.expectedItems!.map(key));
            outcome.missing = check.expectedItems!.filter((v) => !actualKeys.has(key(v)));
            outcome.unexpected = items.filter((v) => !expectedKeys.has(key(v)));
          }
          return outcome;
        }
      }
      break;
    }

    case 'aggregate': {
      const values = await Promise.all(check.sources.map((s) => readSource(s, ctx)));
      const actual = aggregate(check.operation, values);
      const outcome = evaluateExpectation(actual, check.expect);
      return fromExpectation(actual, outcome.ok, outcome.expectedText);
    }

    case 'comparison': {
      const [left, right] = await Promise.all([readSource(check.left, ctx), readSource(check.right, ctx)]);
      const { operator } = check;
      const ok =
        operator === '=='
          ? deepEqual(left, right)
          : operator === '!='
            ? !deepEqual(left, right)
            : compareOrdered(left, operator, right);
      return {
        status: ok ? 'pass' : 'drift',
        actual: { left, right },
        expected: `${check.left.label} ${operator} ${check.right.label}`,
      };
    }

    case 'time': {
      const timestamp = await readCall(check.call, ctx);
      if (typeof timestamp !== 'bigint')
        throw new CheckError(`${check.call.label} did not return an integer timestamp`);
      const blockTime = ctx.clientFor(check.contract).block.timestamp;
      const age = blockTime - timestamp;
      return {
        status: age <= check.maxAgeSeconds ? 'pass' : 'drift',
        actual: age,
        expected: `age <= ${check.maxAgeSeconds}s`,
        message: `updated at ${timestamp}, block time ${blockTime}${age < 0n ? ' (timestamp is in the future)' : ''}`,
      };
    }

    case 'conditional':
      throw new Error('conditional checks are evaluated by evaluateCheck');
  }
  throw new Error(`unhandled check kind`);
}

export async function evaluateCheck(check: Check, ctx: EvaluationContext): Promise<CheckResult[]> {
  const base = {
    contract: check.contract.name,
    address: check.contract.address,
    chainId: check.contract.network.chainId,
    key: check.key,
    type: check.type,
    ...(check.description !== undefined ? { description: check.description } : {}),
    ...(check.metric !== undefined ? { metric: check.metric } : {}),
  };
  try {
    if (check.kind === 'conditional') {
      const actual = await readCall(check.condition, ctx);
      const met = evaluateExpectation(actual, check.conditionExpect).ok;
      const branch = met ? check.then : check.otherwise;
      if (branch.length === 0) {
        return [
          { ...base, status: 'skipped', actual, message: `condition is ${met}; no ${met ? 'then' : 'else'} branch` },
        ];
      }
      const nested = await Promise.all(branch.map((child) => evaluateCheck(child, ctx)));
      return nested.flat();
    }
    return [{ ...base, ...(await evaluateOne(check, ctx)) }];
  } catch (error) {
    return [{ ...base, status: 'error', message: errorMessage(error) }];
  }
}
