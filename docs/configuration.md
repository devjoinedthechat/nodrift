# Configuration

A nodrift config is a YAML file, usually called `nodrift.yaml`, that lists contracts and the state each one should have. This page describes the file itself. The checks are described in [State types](state-types.md), and the ways a value can be matched in [Comparison options](comparison-options.md).

- [A complete example](#a-complete-example)
- [Top-level keys](#top-level-keys)
- [Network](#network)
- [Contracts](#contracts)
- [ABIs](#abis)
- [The state section](#the-state-section)
- [Templates](#templates)
- [Imports](#imports)
- [Variables and file references](#variables-and-file-references)
- [YAML notes](#yaml-notes)
- [Editor support](#editor-support)

## A complete example

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/devjoinedthechat/nodrift/main/nodrift.schema.json
version: 1

network:
  rpc_url: '${RPC_URL}'
  chain_id: 1

contracts:
  Token:
    address: '${TOKEN_ADDRESS}'
    preset: erc20
    state:
      - type: owner
        value: '${OWNER_ADDRESS}'
      - type: variable
        name: decimals
        value: 18
      - type: function_call
        function: balanceOf
        args: ['${TREASURY_ADDRESS}']
        value: '250000 ether'
        options:
          comparison: '>='
```

The format is strict. Unknown keys are errors, and common mistakes come with a hint, for example `unknown key 'expected' (did you mean 'value'?)`. Run `nodrift validate nodrift.yaml` to check a config without contacting the chain: it checks the structure, resolves every function against its ABI and converts every expected value to its ABI type.

## Top-level keys

| Key         | Required | Description                                                                 |
| ----------- | -------- | --------------------------------------------------------------------------- |
| `version`   | no       | A number or string for your own bookkeeping. nodrift does not interpret it. |
| `network`   | yes      | Default network for every contract. It may come from an imported file.      |
| `imports`   | no       | Other config files to merge into this one. See [Imports](#imports).         |
| `templates` | no       | Named contract fragments. See [Templates](#templates).                      |
| `contracts` | yes      | The contracts to check, keyed by a name of your choice. At least one.       |

## Network

| Field         | Required | Default  | Description                                                                                                                                                                                                                                   |
| ------------- | -------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rpc_url`     | yes      |          | HTTP or HTTPS JSON-RPC endpoint. WebSocket URLs are not supported.                                                                                                                                                                            |
| `chain_id`    | yes      |          | Expected chain id. It is compared with the endpoint's `eth_chainId` before anything is read; on a mismatch the run stops with exit code 3.                                                                                                    |
| `block`       | no       | `latest` | Block to read at: `latest`, `safe`, `finalized` or a decimal block number.                                                                                                                                                                    |
| `timeout`     | no       | `30000`  | Timeout per RPC request, in milliseconds.                                                                                                                                                                                                     |
| `max_retries` | no       | `3`      | Retries for failures that may be transient: network errors, timeouts, rate limiting (HTTP 429) and server errors (HTTP 5xx). Retries back off exponentially. Reverts and other HTTP errors, such as `401` for a wrong key, are never retried. |
| `multicall`   | no       | `true`   | Batch calls through [Multicall3](https://www.multicall3.com) when it is deployed on the chain. `false` sends every call separately.                                                                                                           |

The block is resolved once per network when the run starts, and every read uses that block number. All checks therefore see one consistent snapshot, even if new blocks arrive during the run. The `--block` option of the CLI overrides `block` for every network (see [CI/CD integration](ci-cd-integration.md#command-line-reference)).

nodrift identifies an endpoint by the host part of `rpc_url` in report headers, in the JSON report and in all messages. Errors from the endpoint are scrubbed before they are printed, so an API key in the URL path, query string or credentials does not appear in logs or reports.

`chain_id`, `block`, `timeout` and `max_retries` accept numbers or digit strings, so they can come from variables, as in `chain_id: "${CHAIN_ID}"`.

### Contracts on several chains

A contract can declare its own `network`. It replaces the top-level network as a whole (fields are not merged), so it needs at least `rpc_url` and `chain_id`.

```yaml
network:
  rpc_url: '${RPC_URL}'
  chain_id: 1

contracts:
  USDC:
    address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
    preset: erc20
    state:
      - type: variable
        name: decimals
        value: 6

  USDC_Base:
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
    preset: erc20
    network:
      rpc_url: '${BASE_RPC_URL}'
      chain_id: 8453
    state:
      - type: variable
        name: decimals
        value: 6
```

Contracts with the same `chain_id`, `rpc_url` and `block` share one connection and one pinned block. Every other combination gets its own connection, with its own pinned block. All connections are opened and checked before the first check runs; if one endpoint is unreachable or reports a different chain, the run stops.

## Contracts

| Field      | Required | Description                                                                                                                                       |
| ---------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `address`  | yes      | Contract address, EIP-55 checksummed or all lowercase. A wrong checksum is an error, which catches most typos.                                    |
| `preset`   | no       | Built-in ABI for a standard interface: `erc20`, `erc721`, `erc1155`, `erc4626`, `diamond`, `proxy` or `accessControl`. See [Presets](presets.md). |
| `abi`      | no       | ABI entries, or the path of an ABI file. See [ABIs](#abis).                                                                                       |
| `template` | no       | Name of a template to start from. See [Templates](#templates).                                                                                    |
| `network`  | no       | Network for this contract only. Replaces the top-level `network`.                                                                                 |
| `state`    | yes      | The checks, as a list or as a mapping keyed by id. At least one. See [The state section](#the-state-section).                                     |

Contract names are free-form. They appear in reports, and other checks use them to refer to the contract (`cross_contract`, and the `contract` field of sources and conditions).

## ABIs

To call a function and interpret its result, nodrift needs the function's inputs and outputs. There are four ways to provide them, and they can be combined:

1. A `preset` for a standard interface.
2. `abi` entries in the config: JSON ABI objects, or human-readable signatures that start with `function`.
3. `abi` as the path of a JSON file: either a plain ABI array, or a build artifact with an `abi` field (Foundry `out/`, Hardhat `artifacts/`, Truffle `build/`).
4. An inline signature in the check itself, such as `function: "balanceOf(address) returns (uint256)"`. A check written this way needs no ABI.

```yaml
contracts:
  Vault:
    address: '0xB8A00Df65eD2E589a6be0153f8a5463705C03dAB'
    preset: erc4626
    abi:
      - 'function paused() view returns (bool)'
      - type: function
        name: performanceFee
        stateMutability: view
        inputs: []
        outputs:
          - { name: bps, type: uint16 }
    state:
      - type: variable
        name: paused
        value: false
      - type: variable
        name: performanceFee
        value: 1000
      - type: function_call
        function: 'strategies(uint256) returns (address)'
        args: [0]
        value: '0x933Aae3a96433Bf517510DC164C1ed242314E110'
```

An ABI file path, such as `abi: ./out/Vault.sol/Vault.json`, is relative to the config file that contains it. ABI files are read before variables are substituted, so the path cannot contain `${...}`. Like every file reference, it must stay inside the project (see [File access](#file-access)).

Custom errors in the ABI, such as `"error NotAllowed(address caller)"`, are used to decode reverts, so a failing check reports `reverted with NotAllowed(0x…)` instead of raw revert data.

`owner`, `role`, `storage_slot` and `proxy` checks use built-in definitions and need no ABI.

### How functions are resolved

- A plain name such as `balanceOf` is looked up in the contract's ABI, which combines the preset, the template's `abi` and the contract's `abi`. If the name is overloaded, write the full signature.
- A reference that contains `(` is parsed as a signature and must declare what it returns: `"getReserves() returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)"`. The leading `function` keyword and `view` are optional. Named outputs can be selected with `field`.
- Where a check refers to a function with `name` (variable checks, and `name` in sources and conditions), nodrift also tries the `get` form if the name is not in the ABI: `name: owner` falls back to `getOwner()`.
- If your `abi` and the preset declare the same signature, your declaration is used, so a contract that deviates from a standard (such as a token whose `symbol()` returns `bytes32`) can keep the preset for everything else. An inline signature in the check works too.

Arguments are converted to the function's input types with the same rules as expected values (see [Comparison options](comparison-options.md#how-expected-values-are-typed)), and their number must match the function.

## The state section

`state` is a list of checks, or a mapping from id to check:

```yaml
contracts:
  Token:
    address: '0x5BBC840D4AbA89d7882E9c333e52E822b61232fd'
    preset: erc20
    state:
      decimals:
        type: variable
        name: decimals
        value: 18
      supply:
        type: variable
        name: totalSupply
        value: '21000000 ether'
```

In the mapping form, each key becomes the check's `id`.

### Check keys

Every check has a key that identifies it in reports: in the text report, as `key` in the JSON report and as the test case name in JUnit. By default the key is derived from what the check reads. Set `id` to choose it yourself; ids must be unique within a contract. When derived keys repeat, the later ones get a suffix: `balanceOf(0x…)`, `balanceOf(0x…) #2`.

| Check            | Derived key                                                                       | Key with `id: x`                 |
| ---------------- | --------------------------------------------------------------------------------- | -------------------------------- |
| `owner`          | `owner()`                                                                         | `x`                              |
| `role`           | `hasRole(MINTER_ROLE, 0x…)` or `MINTER_ROLE members`                              | `x`                              |
| `variable`       | `totalSupply`                                                                     | `x`                              |
| `function_call`  | `balanceOf(0x…)`, `latestRoundData().updatedAt`                                   | `x`                              |
| `cross_contract` | `USDC.balanceOf(0x…)`                                                             | `x`                              |
| `storage_slot`   | `slot(0x1)`, `slot(IMPLEMENTATION_SLOT)`                                          | `x`                              |
| `proxy`          | `proxy.implementation`, `proxy.admin`, `proxy.beacon`                             | `x.implementation`, ...          |
| `array_state`    | `getOwners().length`, `getOwners().contains`, ...                                 | `x.length`, `x.contains`, ...    |
| `mapping_state`  | one per key: `balanceOf(0x…)`                                                     | `x[0x…]`                         |
| `aggregate`      | `sum(balanceOf(0x…), balanceOf(0x…))`                                             | `x`                              |
| `comparison`     | `balanceOf(0x…) >= totalAssets()`                                                 | `x`                              |
| `time_based`     | `latestRoundData().updatedAt age`                                                 | `x`                              |
| `conditional`    | `if paused == false`, and for its checks `if paused == false -> then -> decimals` | `x`, and `x -> then -> decimals` |

Derived keys contain full checksummed addresses and argument values. An `id` keeps a key stable when arguments change, which keeps CI test history continuous.

## Templates

Templates hold contract fields that several contracts share.

```yaml
templates:
  stablecoin:
    preset: erc20
    state:
      - type: variable
        name: decimals
        value: 6

contracts:
  USDC:
    address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
    template: stablecoin
    state:
      - type: variable
        name: symbol
        value: USDC

  USDT:
    address: '0xdAC17F958D2ee523a2206206994597C13D831ec7'
    template: stablecoin
    state:
      - type: variable
        name: symbol
        value: USDT
```

How a template is applied:

- Template fields are defaults. A field set on the contract wins.
- `abi` lists are concatenated, template entries first.
- `state` lists are concatenated, template checks first. Two mappings are merged by id, and the contract's entry wins. A list and a mapping are concatenated, and the mapping's keys become ids.
- A template is validated as part of each contract that uses it, after merging. An unknown template name is an error that lists the defined templates.

## Imports

`imports` merges other files into a config, so that networks, templates and contracts can be shared, or split by team or protocol.

```text
nodrift/
├── nodrift.yaml
├── networks/
│   └── mainnet.yaml
└── contracts/
    └── stablecoins.yaml
```

`nodrift.yaml`:

```yaml
imports:
  - ./networks/mainnet.yaml
  - ./contracts/stablecoins.yaml
```

`networks/mainnet.yaml`:

```yaml
network:
  rpc_url: '${RPC_URL}'
  chain_id: 1
```

`contracts/stablecoins.yaml`:

```yaml
contracts:
  USDC:
    address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
    preset: erc20
    state:
      - type: variable
        name: decimals
        value: 6
```

Rules:

- Paths are relative to the file that contains the `imports` list. Imported files can import other files; an import cycle is an error.
- Each file is resolved on its own before it is merged: its variables are substituted, and its `abi` paths and `${file:...}` references are relative to its own directory.
- Imported files are merged in list order, and then the importing file is applied on top. Later definitions win.
- `network`: the last imported file that defines one wins, and the importing file's own `network` overrides all imported ones.
- `contracts` and `templates` are merged by name. A later definition replaces an earlier one with the same name as a whole; their fields are not merged.
- An imported file may be incomplete, for example only a network or only templates. The merged result must be a complete config. Every file may only use the top-level keys listed above.

## Variables and file references

String values can contain `${...}` references, which are resolved when the config is loaded:

| Form                  | Resolves to                                                                            |
| --------------------- | -------------------------------------------------------------------------------------- |
| `${VAR}`              | The environment variable `VAR`.                                                        |
| `${env:VAR}`          | Same as `${VAR}`.                                                                      |
| `${VAR \|\| default}` | `VAR`, or `default` if `VAR` is unset or empty. Quotes around the default are removed. |
| `${file:path}`        | The contents of a file, without trailing whitespace.                                   |
| `${file:path:a.b}`    | A field of a JSON file, addressed by a dot-separated path.                             |
| `$${...}`             | The literal text `${...}`.                                                             |

- An unset or empty variable without a default is an error. All missing variables of a file are reported together.
- A value that consists of exactly one `${file:path:field}` reference takes the JSON type of that field, so it can supply a number, a list or a mapping. Every other substitution produces a string. Expected values and arguments are then converted to their ABI types, so `value: "${DECIMALS}"` works for a `uint8`.
- Variable names consist of letters, digits and underscores, and do not start with a digit.
- There are no other forms. `${cmd:...}`, `${math:...}` and any other prefix are rejected: a config cannot run commands or evaluate expressions.
- Substitution applies to values, not to keys, and not inside `abi`.

A deployment record written by your deploy scripts can supply expected values. Given `deployments/mainnet.json`:

```json
{
  "Vault": {
    "address": "0xB8A00Df65eD2E589a6be0153f8a5463705C03dAB",
    "asset": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    "feeBps": 1000
  }
}
```

the checks can read their expectations from it:

```yaml
- type: variable
  name: asset
  value: '${file:./deployments/mainnet.json:Vault.asset}'
- type: variable
  name: performanceFee
  value: '${file:./deployments/mainnet.json:Vault.feeBps}'
```

The same works for the contract address: `address: "${file:./deployments/mainnet.json:Vault.address}"`.

### File access

`${file:...}` references, `abi` paths and `imports` can only read files inside the current working directory or inside the directory of the config file that contains the reference. Symlinks are resolved before this check. A reference such as `${file:/etc/hosts}` or `${file:../../.ssh/id_rsa}` that points elsewhere is refused, so a config cannot copy arbitrary local files into reports.

### .env files

Before reading the config, the CLI loads one `.env` file: the one in the config file's directory or, if there is none, the one in the working directory. Variables that are already set in the environment take precedence over the file. `--no-env-file` disables this.

## YAML notes

- Numbers keep their exact value. Plain decimal integers below 2^53 are read as numbers; larger integers, hex values and decimal fractions are read as strings. nodrift then converts them to the ABI type exactly, or rejects them: a fraction is never rounded. `value: 1000000000000000000000000` is safe without quotes.
- `true` and `false` are booleans. `yes`, `no`, `on` and `off` are plain strings.
- Quote symbolic operators: `comparison: ">="`. An unquoted `>` or `!` has a special meaning in YAML.
- Quote values that contain `${...}`. Inside `[...]` or `{...}` this is required, because `{` and `}` end a flow collection.

## Editor support

The repository contains `nodrift.schema.json`, a JSON Schema of the config format. Editors that use the YAML language server (for example the YAML extension for VS Code) offer completion and inline validation when the first line of the config is:

```text
# yaml-language-server: $schema=https://raw.githubusercontent.com/devjoinedthechat/nodrift/main/nodrift.schema.json
```

The editor schema checks structure only. `nodrift validate` additionally resolves functions against the ABI and checks every expected value against its type.
