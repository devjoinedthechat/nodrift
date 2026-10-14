/**
 * Turns a schema-valid config into a flat list of executable checks.
 *
 * Everything that can be checked without an RPC connection is checked here: functions are
 * resolved against the ABI, arguments and expected values are typed against the ABI, and
 * every check gets a unique key. `nodrift validate` runs exactly this.
 */

import { FunctionFragment, Interface, ParamType, ZeroHash, getAddress, id as keccakId, toBeHex } from 'ethers';
import { ValidationError } from '../common/errors';
import { parseTolerance, type Expectation } from '../check/compare';
import { CoercionError, coerce, formatTyped, isIntegerType, parseInteger, type Typed } from '../check/values';
import { buildInterface, type AbiInput } from './abi';
import {
  OPERATOR_ALIASES,
  type Metric,
  type Operator,
  type RawConfig,
  type RawNetwork,
  type RawOptions,
  type RawSource,
  type RawStateEntry,
  type StateType,
} from './schema';

export const ERC1967_SLOTS = {
  IMPLEMENTATION_SLOT: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
  ADMIN_SLOT: '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103',
  BEACON_SLOT: '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50',
} as const;

const PROXY_SLOTS = {
  implementation: ERC1967_SLOTS.IMPLEMENTATION_SLOT,
  admin: ERC1967_SLOTS.ADMIN_SLOT,
  beacon: ERC1967_SLOTS.BEACON_SLOT,
} as const;

const INT256 = ParamType.from('int256');
const BOOL = ParamType.from('bool');

const COMPARISON_OPTIONS = ['comparison', 'tolerance', 'range', 'pattern', 'ignore_case', 'ignore_order'];

/** Options each check type understands, besides `description`. */
const OPTIONS_BY_TYPE: Record<StateType, readonly string[]> = {
  owner: [],
  role: [],
  proxy: [],
  comparison: [],
  conditional: [],
  time_based: [],
  array_state: ['ignore_case', 'ignore_order'],
  variable: COMPARISON_OPTIONS,
  function_call: COMPARISON_OPTIONS,
  cross_contract: COMPARISON_OPTIONS,
  mapping_state: COMPARISON_OPTIONS,
  aggregate: COMPARISON_OPTIONS,
  storage_slot: [...COMPARISON_OPTIONS, 'decode_as', 'offset', 'size'],
};

export type BlockSpec = 'latest' | 'safe' | 'finalized' | number;

export interface NetworkSettings {
  /** Identifies one RPC endpoint at one block. Contracts sharing a key share a connection. */
  key: string;
  rpcUrl: string;
  chainId: number;
  block: BlockSpec;
  timeoutMs: number;
  maxRetries: number;
  multicall: boolean;
}

export interface ContractInfo {
  name: string;
  address: string;
  network: NetworkSettings;
  iface: Interface;
}

export interface CallSpec {
  contract: ContractInfo;
  fragment: FunctionFragment;
  args: Typed[];
  /** Index of the selected output; undefined means all outputs as a tuple. */
  outputIndex?: number;
  outType: ParamType;
  label: string;
}

export type ValueSource =
  { kind: 'call'; call: CallSpec; label: string } | { kind: 'constant'; value: Typed; label: string };

export interface SlotDecode {
  as: 'bytes32' | 'address' | 'uint256' | 'int256' | 'bool';
  offset: number;
  size: number;
  /** The whole slot must be a left-padded address (upper 12 bytes zero). */
  strictAddress: boolean;
  type: ParamType;
}

interface CheckMeta {
  /** Contract the check is declared under. */
  contract: ContractInfo;
  key: string;
  type: StateType;
  description?: string;
  metric?: Metric;
}

export type Check = CheckMeta &
  (
    | { kind: 'value'; call: CallSpec; expect: Expectation }
    | { kind: 'owner'; expected: string }
    | { kind: 'has_role'; role: string; roleLabel: string; account: string; expected: boolean }
    | { kind: 'role_members'; role: string; roleLabel: string; expected: string[] }
    | { kind: 'slot'; slot: string; decode: SlotDecode; expect: Expectation }
    | {
        kind: 'array';
        call: CallSpec;
        check: 'length' | 'contains' | 'not_contains' | 'exact';
        expectedLength?: bigint;
        expectedItems?: Typed[];
        ignoreOrder: boolean;
        ignoreCase: boolean;
      }
    | {
        kind: 'aggregate';
        operation: 'sum' | 'count' | 'average' | 'min' | 'max';
        sources: ValueSource[];
        expect: Expectation;
      }
    | { kind: 'comparison'; left: ValueSource; right: ValueSource; operator: Operator }
    | { kind: 'conditional'; condition: CallSpec; conditionExpect: Expectation; then: Check[]; otherwise: Check[] }
    | { kind: 'time'; call: CallSpec; maxAgeSeconds: bigint }
  );

export interface NormalizedConfig {
  file?: string;
  networks: NetworkSettings[];
  contracts: ContractInfo[];
  checks: Check[];
}

/** Thrown inside the normalizer to abandon one entry; collected as an issue. */
class Invalid extends Error {}

function fail(where: string, message: string): never {
  throw new Invalid(`${where}: ${message}`);
}

export function normalizeOperator(operator: string): Operator {
  return (OPERATOR_ALIASES[operator] ?? operator) as Operator;
}

const ORDERED = new Set<Operator>(['>', '>=', '<', '<=']);

function coerceAt(value: unknown, type: ParamType, where: string): Typed {
  try {
    return coerce(value, type);
  } catch (error) {
    if (error instanceof CoercionError) fail(where, error.message);
    throw error;
  }
}

function roleHash(role: string): string {
  if (/^0x[0-9a-fA-F]{64}$/.test(role)) return role.toLowerCase();
  if (role === 'DEFAULT_ADMIN_ROLE') return ZeroHash;
  return keccakId(role);
}

class KeyRegistry {
  private readonly used = new Set<string>();

  constructor(private readonly issues: string[]) {}

  take(key: string, explicit: boolean, where: string): string {
    if (explicit) {
      if (this.used.has(key)) this.issues.push(`${where}: duplicate id '${key}'`);
      this.used.add(key);
      return key;
    }
    let candidate = key;
    for (let n = 2; this.used.has(candidate); n++) candidate = `${key} #${n}`;
    this.used.add(candidate);
    return candidate;
  }
}

class Normalizer {
  readonly issues: string[] = [];
  private readonly contracts = new Map<string, ContractInfo>();
  private readonly networks = new Map<string, NetworkSettings>();

  constructor(private readonly raw: RawConfig) {}

  run(file?: string): NormalizedConfig {
    for (const [name, contract] of Object.entries(this.raw.contracts)) {
      const where = `contracts.${name}`;
      const network = this.network(
        contract.network ?? this.raw.network,
        contract.network ? `${where}.network` : 'network',
      );
      const iface = buildInterface((contract.abi ?? []) as AbiInput, this.issues, where);
      this.contracts.set(name, { name, address: getAddress(contract.address), network, iface });
    }
    if (Object.keys(this.raw.contracts).length === 0) this.issues.push('contracts: define at least one contract');

    const checks: Check[] = [];
    for (const [name, contract] of Object.entries(this.raw.contracts)) {
      const info = this.contracts.get(name)!;
      const keys = new KeyRegistry(this.issues);
      const entries = Array.isArray(contract.state)
        ? contract.state.map((entry, i) => ({ entry, where: `contracts.${name}.state[${i}]`, id: entry.id }))
        : Object.entries(contract.state).map(([key, entry]) => ({
            entry,
            where: `contracts.${name}.state.${key}`,
            id: entry.id ?? key,
          }));
      if (entries.length === 0) this.issues.push(`contracts.${name}.state: define at least one check`);
      for (const { entry, where, id } of entries) checks.push(...this.entry(entry, info, where, id, keys, ''));
    }

    if (this.issues.length > 0) throw new ValidationError('Invalid config', this.issues);
    return { file, networks: [...this.networks.values()], contracts: [...this.contracts.values()], checks };
  }

  private network(raw: RawNetwork, where: string): NetworkSettings {
    if (!/^https?:\/\/\S+$/.test(raw.rpc_url)) this.issues.push(`${where}.rpc_url: must be an http(s) URL`);
    if (raw.chain_id < 1) this.issues.push(`${where}.chain_id: must be a positive integer`);
    const block = raw.block ?? 'latest';
    const key = `${raw.chain_id}|${raw.rpc_url}|${block}`;
    const existing = this.networks.get(key);
    if (existing) return existing;
    const settings: NetworkSettings = {
      key,
      rpcUrl: raw.rpc_url,
      chainId: raw.chain_id,
      block,
      timeoutMs: raw.timeout ?? 30_000,
      maxRetries: raw.max_retries ?? 3,
      multicall: raw.multicall ?? true,
    };
    this.networks.set(key, settings);
    return settings;
  }

  private entry(
    entry: RawStateEntry,
    info: ContractInfo,
    where: string,
    id: string | undefined,
    keys: KeyRegistry,
    prefix: string,
  ): Check[] {
    try {
      return this.entryUnchecked(entry, info, where, id, keys, prefix);
    } catch (error) {
      if (error instanceof Invalid) {
        this.issues.push(error.message);
        return [];
      }
      throw error;
    }
  }

  private entryUnchecked(
    entry: RawStateEntry,
    info: ContractInfo,
    where: string,
    id: string | undefined,
    keys: KeyRegistry,
    prefix: string,
  ): Check[] {
    const base = { contract: info, type: entry.type, description: entry.options?.description, metric: entry.metric };
    /** Key for a check that maps 1:1 to this entry: the id if given, else the derived label. */
    const meta = (label: string) => ({ ...base, key: keys.take(prefix + (id ?? label), id !== undefined, where) });
    /** Key for one of several checks expanded from this entry. */
    const sub = (label: string, at = where) => ({ ...base, key: keys.take(prefix + label, id !== undefined, at) });
    const options = entry.options;
    this.rejectUnusedOptions(entry.type, options, where);

    switch (entry.type) {
      case 'owner':
        return [{ ...meta('owner()'), kind: 'owner', expected: getAddress(entry.value) }];

      case 'role': {
        const role = roleHash(entry.role);
        if (entry.account !== undefined && entry.members !== undefined) {
          fail(where, "use either 'account' (with a boolean value) or 'members', not both");
        }
        if (entry.members !== undefined) {
          if (entry.value !== undefined) fail(where, "'value' is not used with 'members'");
          return [
            {
              ...meta(`${entry.role} members`),
              kind: 'role_members',
              role,
              roleLabel: entry.role,
              expected: entry.members.map((m) => getAddress(m)),
            },
          ];
        }
        if (entry.account === undefined) fail(where, "role checks need 'account' or 'members'");
        const account = getAddress(entry.account);
        return [
          {
            ...meta(`hasRole(${entry.role}, ${account})`),
            kind: 'has_role',
            role,
            roleLabel: entry.role,
            account,
            expected: entry.value ?? true,
          },
        ];
      }

      case 'variable': {
        const call = this.call(info, entry.name, [], undefined, where, true);
        return [
          { ...meta(call.label), kind: 'value', call, expect: this.expectation(entry.value, options, call, where) },
        ];
      }

      case 'function_call': {
        const call = this.call(info, entry.function, entry.args ?? [], entry.field, where);
        return [
          { ...meta(call.label), kind: 'value', call, expect: this.expectation(entry.value, options, call, where) },
        ];
      }

      case 'cross_contract': {
        const target = this.contracts.get(entry.target_contract);
        if (!target) fail(`${where}.target_contract`, `unknown contract '${entry.target_contract}'`);
        const call = this.call(target, entry.function, entry.args ?? [], entry.field, where);
        return [
          {
            ...meta(`${target.name}.${call.label}`),
            kind: 'value',
            call,
            expect: this.expectation(entry.value, options, call, where),
          },
        ];
      }

      case 'storage_slot': {
        if ((entry.slot === undefined) === (entry.slot_name === undefined))
          fail(where, "set exactly one of 'slot' or 'slot_name'");
        const slot = entry.slot_name ? ERC1967_SLOTS[entry.slot_name] : this.slot(entry.slot!, `${where}.slot`);
        const decode = this.slotDecode(entry.value, options, where);
        let value = entry.value;
        if (decode.type.baseType.startsWith('bytes') && typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value)) {
          const hex = value.slice(2);
          if (hex.length <= decode.size * 2) value = `0x${hex.padStart(decode.size * 2, '0')}`;
        }
        const expect = this.expectation(value, options, { outType: decode.type, label: 'slot' }, where);
        return [{ ...meta(`slot(${entry.slot_name ?? shortHex(slot)})`), kind: 'slot', slot, decode, expect }];
      }

      case 'proxy': {
        const present = Object.entries(entry.checks).filter(([, address]) => address !== undefined);
        if (present.length === 0) fail(`${where}.checks`, 'set at least one of implementation, admin, beacon');
        return present.map(([name, address]) => ({
          ...sub(`${id ?? 'proxy'}.${name}`),
          kind: 'slot' as const,
          slot: PROXY_SLOTS[name as keyof typeof PROXY_SLOTS],
          decode: { as: 'address' as const, offset: 0, size: 20, strictAddress: true, type: ParamType.from('address') },
          expect: { operator: '==' as const, expected: getAddress(address!) },
        }));
      }

      case 'array_state': {
        const call = this.call(info, entry.function, entry.args ?? [], undefined, where);
        if (call.outType.baseType !== 'array') fail(where, `${call.fragment.format()} does not return an array`);
        const item = call.outType.arrayChildren!;
        const label = id ?? call.label;
        const checks: Check[] = [];
        const { length, contains, not_contains, exact } = entry.checks;
        const common = { ignoreOrder: options?.ignore_order ?? false, ignoreCase: options?.ignore_case ?? false };
        if (length !== undefined)
          checks.push({
            ...sub(`${label}.length`),
            kind: 'array',
            call,
            check: 'length',
            expectedLength: BigInt(length),
            ...common,
          });
        for (const [name, items] of [
          ['contains', contains],
          ['not_contains', not_contains],
          ['exact', exact],
        ] as const) {
          if (items === undefined) continue;
          const expectedItems = items.map((v, i) => coerceAt(v, item, `${where}.checks.${name}[${i}]`));
          checks.push({ ...sub(`${label}.${name}`), kind: 'array', call, check: name, expectedItems, ...common });
        }
        if (checks.length === 0) fail(`${where}.checks`, 'set at least one of length, contains, not_contains, exact');
        return checks;
      }

      case 'mapping_state':
        return entry.keys.flatMap(({ key, value }, i) => {
          const at = `${where}.keys[${i}]`;
          const call = this.call(info, entry.function, Array.isArray(key) ? key : [key], undefined, at);
          const label = id !== undefined ? `${id}[${call.args.map(formatTyped).join(', ')}]` : call.label;
          return [
            {
              ...sub(label, at),
              kind: 'value' as const,
              call,
              expect: this.expectation(value, options, call, at),
            },
          ];
        });

      case 'aggregate': {
        const sources = entry.sources.map((s, i) =>
          this.source(s, info, `${where}.sources[${i}]`, entry.operation === 'count' ? BOOL : INT256),
        );
        sources.forEach((source, i) => {
          if (source.kind !== 'call') return;
          const type = source.call.outType;
          const ok = isIntegerType(type) || (entry.operation === 'count' && type.baseType === 'bool');
          if (!ok)
            fail(
              `${where}.sources[${i}]`,
              `${source.label} returns ${type.format()}; ${entry.operation} needs integers`,
            );
        });
        const label = `${entry.operation}(${sources.map((s) => s.label).join(', ')})`;
        const expect = this.expectation(entry.value, options, { outType: INT256, label }, where);
        return [{ ...meta(label), kind: 'aggregate', operation: entry.operation, sources, expect }];
      }

      case 'comparison': {
        const operator = normalizeOperator(entry.operator);
        let left = this.source(entry.left, info, `${where}.left`);
        let right = this.source(entry.right, info, `${where}.right`);
        if (left.kind === 'constant' && right.kind === 'constant')
          fail(where, 'at least one side must read on-chain state');
        if (left.kind === 'constant' && right.kind === 'call')
          left = this.constantFor(entry.left, right.call.outType, `${where}.left`);
        if (right.kind === 'constant' && left.kind === 'call')
          right = this.constantFor(entry.right, left.call.outType, `${where}.right`);
        if (ORDERED.has(operator)) {
          for (const [side, source] of [
            ['left', left],
            ['right', right],
          ] as const) {
            if (source.kind === 'call' && !isIntegerType(source.call.outType)) {
              fail(
                `${where}.${side}`,
                `${source.label} returns ${source.call.outType.format()}; ${operator} needs integers`,
              );
            }
          }
        }
        return [{ ...meta(`${left.label} ${operator} ${right.label}`), kind: 'comparison', left, right, operator }];
      }

      case 'time_based': {
        const call = this.call(info, entry.function, entry.args ?? [], entry.field, where);
        if (!isIntegerType(call.outType)) {
          fail(where, `${call.label} returns ${call.outType.format()}; use 'field' to select the timestamp output`);
        }
        return [{ ...meta(`${call.label} age`), kind: 'time', call, maxAgeSeconds: BigInt(entry.max_age_seconds) }];
      }

      case 'conditional': {
        const condition = entry.condition;
        const at = `${where}.condition`;
        const target = condition.contract ? this.contracts.get(condition.contract) : info;
        if (!target) fail(`${at}.contract`, `unknown contract '${condition.contract}'`);
        const kind =
          condition.type ??
          (condition.function !== undefined ? 'function_call' : condition.name !== undefined ? 'variable' : undefined);
        if (kind === undefined) fail(at, "set 'function' or 'name'");
        const ref = kind === 'variable' ? condition.name : condition.function;
        if (ref === undefined)
          fail(at, kind === 'variable' ? "type 'variable' needs 'name'" : "type 'function_call' needs 'function'");
        const call = this.call(target, ref, condition.args ?? [], condition.field, at, kind === 'variable');
        const operator = normalizeOperator(condition.operator ?? '==');
        const conditionExpect = this.expectation(condition.value, { comparison: operator }, call, at);
        const label = `if ${call.label} ${operator} ${formatTyped(conditionExpect.expected)}`;
        const own = meta(label);
        const branch = (list: RawStateEntry[] | undefined, name: string) =>
          (list ?? []).flatMap((child, i) =>
            this.entry(child, info, `${where}.${name}[${i}]`, child.id, keys, `${own.key} -> ${name} -> `),
          );
        return [
          {
            ...own,
            kind: 'conditional',
            condition: call,
            conditionExpect,
            then: branch(entry.then, 'then'),
            otherwise: branch(entry.else, 'else'),
          },
        ];
      }
    }
    throw new Error(`unhandled state type ${(entry as { type: string }).type}`);
  }

  /** Options a check type does not use are errors, never silently ignored. */
  private rejectUnusedOptions(type: StateType, options: RawOptions | undefined, where: string): void {
    const allowed = OPTIONS_BY_TYPE[type];
    for (const [key, value] of Object.entries(options ?? {})) {
      if (value === undefined || key === 'description' || allowed.includes(key)) continue;
      fail(`${where}.options.${key}`, `does not apply to ${type} checks`);
    }
  }

  private call(
    contract: ContractInfo,
    ref: string,
    rawArgs: unknown[],
    field: string | number | undefined,
    where: string,
    variable = false,
  ): CallSpec {
    const fragment = this.resolveFunction(contract, ref, rawArgs, where, variable);
    if (variable && fragment.inputs.length > 0) {
      fail(where, `${fragment.format()} takes arguments; use a function_call check`);
    }
    if (rawArgs.length !== fragment.inputs.length) {
      fail(where, `${fragment.format()} takes ${fragment.inputs.length} argument(s), got ${rawArgs.length}`);
    }
    const args = rawArgs.map((arg, i) => coerceAt(arg, fragment.inputs[i], `${where}.args[${i}]`));

    const outputs = fragment.outputs;
    if (outputs.length === 0) fail(where, `${fragment.format()} returns nothing`);
    let outputIndex: number | undefined;
    let outType: ParamType;
    if (field !== undefined) {
      outputIndex = typeof field === 'number' ? field : outputs.findIndex((o) => o.name === field);
      if (outputIndex < 0 || outputIndex >= outputs.length) {
        const names = outputs.map((o, i) => o.name || String(i)).join(', ');
        fail(`${where}.field`, `'${field}' is not an output of ${fragment.format()} (outputs: ${names})`);
      }
      outType = outputs[outputIndex];
    } else if (outputs.length === 1) {
      outputIndex = 0;
      outType = outputs[0];
    } else {
      outType = ParamType.from({ type: 'tuple', components: outputs.map((o) => JSON.parse(o.format('json'))) });
    }

    const argText = variable ? '' : `(${args.map(formatTyped).join(', ')})`;
    const fieldText = field !== undefined ? `.${outputs[outputIndex!].name || outputIndex}` : '';
    return { contract, fragment, args, outputIndex, outType, label: `${fragment.name}${argText}${fieldText}` };
  }

  private resolveFunction(
    contract: ContractInfo,
    ref: string,
    args: unknown[],
    where: string,
    variable: boolean,
  ): FunctionFragment {
    const text = ref.trim();
    if (text.includes('(')) {
      let fragment: FunctionFragment;
      try {
        fragment = FunctionFragment.from(text.startsWith('function ') ? text : `function ${text}`);
      } catch (error) {
        fail(where, `invalid function signature '${ref}': ${(error as Error).message}`);
      }
      if (fragment.outputs.length === 0) {
        fail(where, `signature '${ref}' must declare what it returns, e.g. '${fragment.name}(...) returns (uint256)'`);
      }
      return fragment;
    }

    const lookup = (name: string): FunctionFragment | null => {
      try {
        return contract.iface.getFunction(name);
      } catch {
        try {
          return contract.iface.getFunction(name, args);
        } catch {
          fail(where, `'${name}' is overloaded in the ABI of ${contract.name}; use a full signature`);
        }
      }
    };
    const fragment = lookup(text) ?? (variable ? lookup(`get${text[0].toUpperCase()}${text.slice(1)}`) : null);
    if (!fragment) {
      fail(
        where,
        `function '${text}' is not in the ABI of ${contract.name}. ` +
          `Add an 'abi', use a 'preset', or write a signature like '${text}(...) returns (uint256)'`,
      );
    }
    return fragment;
  }

  private expectation(
    value: unknown,
    options: RawOptions | undefined,
    target: { outType: ParamType; label: string },
    where: string,
  ): Expectation {
    const o = options ?? {};
    const operator = normalizeOperator(o.comparison ?? '==');
    const forms = [
      value !== undefined ? 'value' : undefined,
      o.range !== undefined ? 'options.range' : undefined,
      o.pattern !== undefined ? 'options.pattern' : undefined,
    ].filter((f): f is string => f !== undefined);
    if (forms.length === 0) fail(where, "missing 'value' (or options.range / options.pattern)");
    if (forms.length > 1) fail(where, `use only one of ${forms.join(', ')}`);

    const numeric = isIntegerType(target.outType);
    const expect: Expectation = { operator, ignoreCase: o.ignore_case, ignoreOrder: o.ignore_order };

    if (value !== undefined) expect.expected = coerceAt(value, target.outType, `${where}.value`);
    if (ORDERED.has(operator) && !numeric) {
      fail(
        `${where}.options.comparison`,
        `${operator} needs a numeric value, but ${target.label} is ${target.outType.format()}`,
      );
    }
    if (operator !== '==' && (o.range !== undefined || o.pattern !== undefined)) {
      fail(`${where}.options.comparison`, 'cannot be combined with range or pattern');
    }
    if (o.range !== undefined) {
      if (!numeric)
        fail(`${where}.options.range`, `needs a numeric value, but ${target.label} is ${target.outType.format()}`);
      const bound = (v: unknown, name: string) => {
        if (v === undefined) return undefined;
        const parsed = parseInteger(v);
        if (parsed === undefined) fail(`${where}.options.range.${name}`, `not an integer: ${String(v)}`);
        return parsed;
      };
      expect.range = { min: bound(o.range.min, 'min'), max: bound(o.range.max, 'max') };
    }
    if (o.pattern !== undefined) {
      const base = target.outType.baseType;
      if (!(numeric || base === 'string' || base === 'address' || base.startsWith('bytes'))) {
        fail(
          `${where}.options.pattern`,
          `needs a string, address, bytes or integer value, but ${target.label} is ${target.outType.format()}`,
        );
      }
      try {
        expect.pattern = new RegExp(o.pattern, o.ignore_case ? 'i' : '');
      } catch (error) {
        fail(`${where}.options.pattern`, (error as Error).message);
      }
    }
    if (o.tolerance !== undefined) {
      if (value === undefined || !numeric) fail(`${where}.options.tolerance`, 'needs a numeric value');
      if (operator !== '==' && operator !== '!=') fail(`${where}.options.tolerance`, 'only applies to == and !=');
      expect.tolerance =
        parseTolerance(o.tolerance) ?? fail(`${where}.options.tolerance`, `invalid tolerance ${String(o.tolerance)}`);
    }
    return expect;
  }

  private slot(slot: string | number, where: string): string {
    const parsed = parseInteger(slot);
    if (parsed === undefined || parsed < 0n || parsed >= 1n << 256n)
      fail(where, `invalid storage slot ${String(slot)}`);
    return toBeHex(parsed, 32);
  }

  private slotDecode(value: unknown, options: RawOptions | undefined, where: string): SlotDecode {
    const o = options ?? {};
    let as = o.decode_as;
    if (as === undefined) {
      if (typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)) as = 'address';
      else if (typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)) as = 'bytes32';
      else if (typeof value === 'boolean') as = 'bool';
      else if (o.range !== undefined || parseInteger(value) !== undefined) as = 'uint256';
      else as = 'bytes32';
    }
    const packed = o.offset !== undefined || o.size !== undefined;
    const offset = o.offset ?? 0;
    const size = o.size ?? (as === 'address' ? 20 : as === 'bool' && packed ? 1 : 32 - offset);
    if (offset > 31 || size < 1 || offset + size > 32) fail(`${where}.options`, 'offset + size must fit in 32 bytes');
    if (as === 'address' && size !== 20) fail(`${where}.options.size`, 'an address is 20 bytes');
    const typeName = {
      address: 'address',
      bool: 'bool',
      uint256: `uint${size * 8}`,
      int256: `int${size * 8}`,
      bytes32: `bytes${size}`,
    }[as];
    return { as, offset, size, strictAddress: as === 'address' && !packed, type: ParamType.from(typeName) };
  }

  private source(raw: RawSource, info: ContractInfo, where: string, constantType?: ParamType): ValueSource {
    const kind =
      raw.type ??
      (raw.function !== undefined
        ? 'function_call'
        : raw.name !== undefined
          ? 'variable'
          : raw.value !== undefined
            ? 'constant'
            : undefined);
    if (kind === undefined) fail(where, "a source needs 'function', 'name' or 'value'");
    if (kind === 'constant') {
      if (raw.function !== undefined || raw.name !== undefined || raw.contract !== undefined) {
        fail(where, "a constant source only takes 'value'");
      }
      if (raw.value === undefined) fail(where, "a constant source needs 'value'");
      const value = constantType ? coerceAt(raw.value, constantType, `${where}.value`) : (raw.value as Typed);
      return { kind: 'constant', value, label: formatTyped(value) };
    }
    const target = raw.contract !== undefined ? this.contracts.get(raw.contract) : info;
    if (!target) fail(`${where}.contract`, `unknown contract '${raw.contract}'`);
    const ref = kind === 'variable' ? raw.name : raw.function;
    if (ref === undefined) fail(where, kind === 'variable' ? "set 'name'" : "set 'function'");
    const call = this.call(target, ref, raw.args ?? [], raw.field, where, kind === 'variable');
    const label = target === info ? call.label : `${target.name}.${call.label}`;
    return { kind: 'call', call, label };
  }

  private constantFor(raw: RawSource, type: ParamType, where: string): ValueSource {
    const value = coerceAt(raw.value, type, `${where}.value`);
    return { kind: 'constant', value, label: formatTyped(value) };
  }
}

function shortHex(hex: string): string {
  const trimmed = BigInt(hex).toString(16);
  return trimmed.length <= 8 ? `0x${trimmed}` : `${hex.slice(0, 10)}...${hex.slice(-6)}`;
}

export function normalize(raw: RawConfig, file?: string): NormalizedConfig {
  return new Normalizer(raw).run(file);
}
