/**
 * Config file schema. This is the single source of truth: TypeScript types are inferred
 * from it and `nodrift.schema.json` (IDE support) is generated from it.
 *
 * The schema checks shape only. Semantic checks that need the ABI (function lookup,
 * typing expected values) happen in normalize.ts.
 */

import { z } from 'zod';
import { isAddress } from 'ethers';

/** Placeholders like `${RPC_URL}` are allowed so IDEs don't flag unresolved variables. */
const PLACEHOLDER = String.raw`\$\{[^}]+\}`;

const IntLike = z
  .union([
    z.number().int().nonnegative(),
    z.string().regex(new RegExp(`^(\\d+|${PLACEHOLDER})$`), 'expected a non-negative integer'),
  ])
  .transform((v) => Number(v));

const BoolLike = z
  .union([z.boolean(), z.string().regex(new RegExp(`^(true|false|${PLACEHOLDER})$`))])
  .transform((v) => v === true || v === 'true');

const Address = z
  .string()
  .refine((v) => isAddress(v), 'not a valid address (check the EIP-55 checksum casing, or write it in all lowercase)');

const Value = z.unknown().describe('Expected value. Typed against the ABI output type.');
const Args = z.array(z.unknown()).describe('Function arguments');
const Field = z
  .union([z.string(), z.number().int().nonnegative()])
  .describe('Output to select from a multi-value return: a named output or a zero-based index');
const FunctionRef = z
  .string()
  .min(1)
  .describe('Function name from the ABI, or a signature such as "balanceOf(address) returns (uint256)"');

export const OPERATORS = ['==', '!=', '>', '>=', '<', '<='] as const;
export type Operator = (typeof OPERATORS)[number];

export const OPERATOR_ALIASES: Record<string, Operator> = {
  equals: '==',
  not_equals: '!=',
  greater_than: '>',
  greater_than_or_equal: '>=',
  less_than: '<',
  less_than_or_equal: '<=',
};

const OperatorSchema = z.enum([
  '==',
  '!=',
  '>',
  '>=',
  '<',
  '<=',
  'equals',
  'not_equals',
  'greater_than',
  'greater_than_or_equal',
  'less_than',
  'less_than_or_equal',
]);

export const DECODE_TYPES = ['bytes32', 'address', 'uint256', 'int256', 'bool'] as const;

const OptionsSchema = z
  .strictObject({
    comparison: OperatorSchema.optional().describe('How the actual value is compared to `value` (default ==)'),
    tolerance: z
      .union([z.number().nonnegative(), z.string()])
      .optional()
      .describe('Allowed numeric deviation: absolute ("1000") or relative to `value` ("0.5%")'),
    range: z
      .strictObject({
        min: z.union([z.number(), z.string()]).optional(),
        max: z.union([z.number(), z.string()]).optional(),
      })
      .optional()
      .describe('Inclusive numeric bounds. Replaces `value`.'),
    pattern: z.string().optional().describe('Regular expression the value must match. Replaces `value`.'),
    ignore_case: BoolLike.optional(),
    ignore_order: BoolLike.optional(),
    decode_as: z.enum(DECODE_TYPES).optional().describe('storage_slot only: how to decode the slot'),
    offset: IntLike.optional().describe('storage_slot only: byte offset of a packed field, from the low-order end'),
    size: IntLike.optional().describe('storage_slot only: byte size of a packed field'),
    description: z.string().optional().describe('Shown in reports'),
  })
  .meta({ id: 'Options' });

export const METRIC_CATEGORIES = ['integrity', 'solvency', 'liquidity', 'risk', 'supply', 'governance'] as const;
export const METRIC_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;

const MetricSchema = z
  .strictObject({
    name: z.string(),
    category: z.enum(METRIC_CATEGORIES),
    severity: z.enum(METRIC_SEVERITIES),
    description: z.string().optional(),
  })
  .meta({ id: 'Metric' });

const common = {
  id: z.string().min(1).optional().describe('Stable identifier shown in reports. Must be unique per contract.'),
  options: OptionsSchema.optional(),
  metric: MetricSchema.optional(),
};

const SourceSchema = z
  .strictObject({
    type: z.enum(['function_call', 'variable', 'constant']).optional(),
    contract: z.string().optional().describe('Name of another contract in this config (default: the current one)'),
    function: FunctionRef.optional(),
    name: z.string().optional(),
    args: Args.optional(),
    field: Field.optional(),
    value: Value.optional(),
  })
  .meta({ id: 'Source' });

const ConditionSchema = z
  .strictObject({
    type: z.enum(['function_call', 'variable']).optional(),
    contract: z.string().optional(),
    function: FunctionRef.optional(),
    name: z.string().optional(),
    args: Args.optional(),
    field: Field.optional(),
    operator: OperatorSchema.optional(),
    value: Value,
  })
  .meta({ id: 'Condition' });

const Owner = z.strictObject({ type: z.literal('owner'), value: Address, ...common });

const Role = z.strictObject({
  type: z.literal('role'),
  role: z.string().min(1).describe('Role name (hashed with keccak256), DEFAULT_ADMIN_ROLE, or a bytes32 hash'),
  account: Address.optional().describe('Check hasRole(role, account) against a boolean `value`'),
  value: BoolLike.optional(),
  members: z.array(Address).optional().describe('Exact member set. Requires AccessControlEnumerable.'),
  ...common,
});

const Variable = z.strictObject({
  type: z.literal('variable'),
  name: FunctionRef.describe('Public variable or zero-argument getter'),
  value: Value.optional(),
  ...common,
});

const FunctionCall = z.strictObject({
  type: z.literal('function_call'),
  function: FunctionRef,
  args: Args.optional(),
  field: Field.optional(),
  value: Value.optional(),
  ...common,
});

const StorageSlot = z.strictObject({
  type: z.literal('storage_slot'),
  slot: z.union([z.string(), z.number().int().nonnegative()]).optional(),
  slot_name: z.enum(['IMPLEMENTATION_SLOT', 'ADMIN_SLOT', 'BEACON_SLOT']).optional(),
  value: Value.optional(),
  ...common,
});

const Proxy = z.strictObject({
  type: z.literal('proxy'),
  checks: z.strictObject({
    implementation: Address.optional(),
    admin: Address.optional(),
    beacon: Address.optional(),
  }),
  ...common,
});

const ArrayState = z.strictObject({
  type: z.literal('array_state'),
  function: FunctionRef.describe('Function returning an array'),
  args: Args.optional(),
  checks: z.strictObject({
    length: IntLike.optional(),
    contains: z.array(z.unknown()).optional(),
    not_contains: z.array(z.unknown()).optional(),
    exact: z.array(z.unknown()).optional(),
  }),
  ...common,
});

const MappingState = z.strictObject({
  type: z.literal('mapping_state'),
  function: FunctionRef.describe('Mapping getter'),
  keys: z
    .array(
      z.strictObject({
        key: z.unknown().describe('Mapping key, or a list of keys for nested mappings'),
        value: Value,
      }),
    )
    .min(1),
  ...common,
});

const CrossContract = z.strictObject({
  type: z.literal('cross_contract'),
  target_contract: z.string().describe('Name of another contract in this config'),
  function: FunctionRef,
  args: Args.optional(),
  field: Field.optional(),
  value: Value.optional(),
  ...common,
});

const Aggregate = z.strictObject({
  type: z.literal('aggregate'),
  operation: z.enum(['sum', 'count', 'average', 'min', 'max']),
  sources: z.array(SourceSchema).min(1),
  value: Value.optional(),
  ...common,
});

const Comparison = z.strictObject({
  type: z.literal('comparison'),
  left: SourceSchema,
  operator: OperatorSchema,
  right: SourceSchema,
  ...common,
});

const TimeBased = z.strictObject({
  type: z.literal('time_based'),
  function: FunctionRef.describe('Function returning a unix timestamp'),
  args: Args.optional(),
  field: Field.optional(),
  max_age_seconds: IntLike,
  ...common,
});

const NON_CONDITIONAL = [
  Owner,
  Role,
  Variable,
  FunctionCall,
  StorageSlot,
  Proxy,
  ArrayState,
  MappingState,
  CrossContract,
  Aggregate,
  Comparison,
  TimeBased,
] as const;

type NonConditionalEntry = z.output<(typeof NON_CONDITIONAL)[number]>;
type NonConditionalInput = z.input<(typeof NON_CONDITIONAL)[number]>;

/** Conditional entries contain entries, so their types are declared rather than inferred. */
export interface ConditionalEntry {
  type: 'conditional';
  condition: z.output<typeof ConditionSchema>;
  then: RawStateEntry[];
  else?: RawStateEntry[];
  id?: string;
  options?: z.output<typeof OptionsSchema>;
  metric?: z.output<typeof MetricSchema>;
}

interface ConditionalInput {
  type: 'conditional';
  condition: z.input<typeof ConditionSchema>;
  then: StateEntryInput[];
  else?: StateEntryInput[];
  id?: string;
  options?: z.input<typeof OptionsSchema>;
  metric?: z.input<typeof MetricSchema>;
}

export type RawStateEntry = NonConditionalEntry | ConditionalEntry;
type StateEntryInput = NonConditionalInput | ConditionalInput;

const Conditional = z.strictObject({
  type: z.literal('conditional'),
  condition: ConditionSchema,
  then: z.lazy((): z.ZodType<RawStateEntry[], StateEntryInput[]> => z.array(StateEntrySchema).min(1)),
  else: z.lazy((): z.ZodType<RawStateEntry[], StateEntryInput[]> => z.array(StateEntrySchema)).optional(),
  ...common,
});

export const StateEntrySchema = z
  .discriminatedUnion('type', [...NON_CONDITIONAL, Conditional])
  .meta({ id: 'StateEntry' });

export const NetworkSchema = z
  .strictObject({
    rpc_url: z.string().min(1).describe('HTTP(S) JSON-RPC endpoint'),
    chain_id: IntLike.describe('Expected chain id. Checked against the endpoint before any read.'),
    block: z
      .union([z.enum(['latest', 'safe', 'finalized']), IntLike])
      .optional()
      .describe('Block to read at (default: latest). Resolved once so every check sees the same state.'),
    timeout: IntLike.optional().describe('Per-request timeout in milliseconds (default 30000)'),
    max_retries: IntLike.optional().describe('Retries for transient RPC errors (default 3)'),
    multicall: BoolLike.optional().describe('Batch calls through Multicall3 when deployed (default true)'),
  })
  .meta({ id: 'Network' });

export const PRESET_NAMES = ['erc20', 'erc721', 'erc1155', 'erc4626', 'diamond', 'proxy', 'accessControl'] as const;

const AbiSchema = z.union([
  z.array(z.union([z.record(z.string(), z.unknown()), z.string()])),
  z.string().describe('Path to an ABI or Foundry/Hardhat artifact JSON file'),
]);

export const ContractSchema = z
  .strictObject({
    address: Address,
    abi: AbiSchema.optional(),
    preset: z.enum(PRESET_NAMES).optional(),
    template: z.string().optional(),
    network: NetworkSchema.optional(),
    state: z.union([z.array(StateEntrySchema), z.record(z.string(), StateEntrySchema)]),
  })
  .meta({ id: 'Contract' });

export const ConfigSchema = z.strictObject({
  version: z.union([z.number(), z.string()]).optional(),
  network: NetworkSchema,
  imports: z.array(z.string()).optional(),
  templates: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  contracts: z.record(z.string(), ContractSchema),
});

export type RawConfig = z.output<typeof ConfigSchema>;
export type RawContract = z.output<typeof ContractSchema>;
export type RawNetwork = z.output<typeof NetworkSchema>;
export type RawSource = z.output<typeof SourceSchema>;
export type RawCondition = z.output<typeof ConditionSchema>;
export type RawOptions = z.output<typeof OptionsSchema>;
export type Metric = z.output<typeof MetricSchema>;
export type StateType = RawStateEntry['type'];
export type PresetName = (typeof PRESET_NAMES)[number];
