# State types

Each entry under a contract's `state` is one check. Its `type` selects what is read:

| Type                                | Reads                                                        | Needs an ABI |
| ----------------------------------- | ------------------------------------------------------------ | ------------ |
| [`owner`](#owner)                   | `owner()`, or `getOwner()` as a fallback                     | no           |
| [`role`](#role)                     | AccessControl role membership                                | no           |
| [`variable`](#variable)             | a public variable or any function without arguments          | yes          |
| [`function_call`](#function_call)   | any view function, with arguments                            | yes          |
| [`storage_slot`](#storage_slot)     | a raw storage slot                                           | no           |
| [`proxy`](#proxy)                   | the ERC-1967 implementation, admin and beacon slots          | no           |
| [`array_state`](#array_state)       | a function that returns an array                             | yes          |
| [`mapping_state`](#mapping_state)   | a mapping getter, once per key                               | yes          |
| [`cross_contract`](#cross_contract) | a function of another contract in the config                 | yes          |
| [`aggregate`](#aggregate)           | the sum, count, average, minimum or maximum of several reads | yes          |
| [`comparison`](#comparison)         | two reads, compared with each other                          | yes          |
| [`time_based`](#time_based)         | the age of a timestamp                                       | yes          |
| [`conditional`](#conditional)       | checks that only apply when a condition holds                | yes          |

"Needs an ABI" means that the function must come from the contract's `preset` or `abi`, or be written as an inline signature such as `"balanceOf(address) returns (uint256)"`. See [ABIs](configuration.md#abis). The examples on this page show entries under `state:` and assume that the functions they call by name are in the contract's ABI.

## Fields of every check

| Field     | Description                                                                                                                                                                                                            |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`    | One of the types above.                                                                                                                                                                                                |
| `id`      | Optional key for reports, unique within the contract. See [Check keys](configuration.md#check-keys).                                                                                                                   |
| `options` | Comparison options and `description`, a text shown in reports. Each type accepts a specific set of options, listed in [Comparison options](comparison-options.md#options-by-check-type); any other option is an error. |
| `metric`  | Optional classification for reports: `name`, `category`, `severity` and `description`. See [Metrics](../examples/METRICS.md).                                                                                          |

## Results

Every check ends with one of four statuses:

| Status    | Meaning                                                                                                                                                                                                                                                                             |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pass`    | The on-chain state matches the expectation.                                                                                                                                                                                                                                         |
| `drift`   | The state was read and does not match.                                                                                                                                                                                                                                              |
| `error`   | The check could not be evaluated, for example because the call reverted, returned no data or data that does not decode, or because there is no contract code at the address at the pinned block. An error is never counted as a pass, and it always makes the run exit with code 4. |
| `skipped` | A `conditional` check whose condition selected an empty branch.                                                                                                                                                                                                                     |

## owner

Checks the owner of an `Ownable` contract.

| Field   | Required | Description             |
| ------- | -------- | ----------------------- |
| `value` | yes      | Expected owner address. |

```yaml
- type: owner
  value: '0x85c94597Fb2efeaf0196F42F7b9e4d3B9AE899ED'
```

nodrift calls `owner()`. If that call reverts or returns no usable data, it calls `getOwner()`, which BEP-20 tokens use, and reports the error of the first call if both fail. Key: `owner()`.

## role

Checks OpenZeppelin `AccessControl` roles, either one account at a time or as a complete member list.

| Field     | Required               | Description                                                                                                                                                                                   |
| --------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `role`    | yes                    | A role name such as `MINTER_ROLE`, which is hashed with keccak256 like the Solidity constant `keccak256("MINTER_ROLE")`; `DEFAULT_ADMIN_ROLE`, which is the zero hash; or a 32-byte hex hash. |
| `account` | `account` or `members` | Account to check with `hasRole(role, account)`.                                                                                                                                               |
| `value`   | no                     | With `account`: the expected result, `true` (default) or `false`.                                                                                                                             |
| `members` | `account` or `members` | The exact set of members, in any order.                                                                                                                                                       |

```yaml
- type: role
  role: MINTER_ROLE
  account: '0xEfB695C8f821e0ee7D44447693AF5FD10ef5420D'

- type: role
  role: MINTER_ROLE
  account: '0x61005eC1202a2528186063dAF956E5653C50B8cb'
  value: false

- type: role
  role: DEFAULT_ADMIN_ROLE
  members:
    - '0xA8bACE4F426772483D2b4E6350Fd948b58E06cA8'
```

Use `value: false` to confirm that an account, such as a deployer key, no longer holds a role. A `members` check gives the stronger guarantee: it also catches accounts that were added. It reads `getRoleMemberCount` and `getRoleMember`, which only `AccessControlEnumerable` provides; on other contracts the check reports an error, and `account` checks are the alternative. Drift lists the missing and the unexpected members. Roles with more than 10,000 members are refused.

Keys: `hasRole(MINTER_ROLE, 0xEfB6…)` and `DEFAULT_ADMIN_ROLE members`.

## variable

Reads a public state variable, or any function without arguments.

| Field   | Required                                                | Description                                                        |
| ------- | ------------------------------------------------------- | ------------------------------------------------------------------ |
| `name`  | yes                                                     | Function name, or a signature such as `"paused() returns (bool)"`. |
| `value` | yes, unless `options.range` or `options.pattern` is set | Expected value, converted to the function's return type.           |

```yaml
- type: variable
  name: decimals
  value: 6

- type: variable
  name: 'paused() returns (bool)'
  value: false
```

If `name` is not in the ABI, nodrift also tries `get` followed by the name, so `name: threshold` finds `getThreshold()`. A function with several return values is compared as a whole (see [function_call](#function_call)). Key: the function name, here `decimals` and `paused`.

## function_call

Calls a view function, with arguments, and checks the result.

| Field      | Required                                                | Description                                                                                  |
| ---------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `function` | yes                                                     | Function name or signature.                                                                  |
| `args`     | no                                                      | Arguments, converted to the function's input types.                                          |
| `field`    | no                                                      | For a function with several return values: the output to check, by name or zero-based index. |
| `value`    | yes, unless `options.range` or `options.pattern` is set | Expected value.                                                                              |

```yaml
- type: function_call
  function: balanceOf
  args: ['0x69834F70169dd7E0ecA5AE7c343a47fe9D36cDd4']
  value: '250000 ether'
  options:
    comparison: '>='

- type: function_call
  function: latestRoundData
  field: answer
  value: 0
  options:
    comparison: '>'

- type: function_call
  function: 'marketConfig(address) returns (uint16 ltv, uint16 liquidationThreshold, bool frozen)'
  args: ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48']
  value:
    ltv: 7500
    liquidationThreshold: 8000
    frozen: false
```

Without `field`, a function with several return values is compared as a whole: write the value as a list in output order, or as a mapping when every output has a name, as in the third example. Keys: `balanceOf(0x6983…)`, `latestRoundData().answer` and `marketConfig(0xA0b8…)`.

## storage_slot

Reads a storage slot directly with `eth_getStorageAt`. This covers state that has no getter, and confirms what is actually stored.

| Field               | Required                                                | Description                                                                              |
| ------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `slot`              | `slot` or `slot_name`                                   | Slot number: an integer, or a decimal or hex string.                                     |
| `slot_name`         | `slot` or `slot_name`                                   | `IMPLEMENTATION_SLOT`, `ADMIN_SLOT` or `BEACON_SLOT`, the ERC-1967 slots.                |
| `value`             | yes, unless `options.range` or `options.pattern` is set | Expected value.                                                                          |
| `options.decode_as` | no                                                      | `address`, `uint256`, `int256`, `bool` or `bytes32`.                                     |
| `options.offset`    | no                                                      | Byte offset of a packed field, counted from the low-order (rightmost) byte. Default `0`. |
| `options.size`      | no                                                      | Size of a packed field in bytes.                                                         |

Without `decode_as`, the type follows from `value`: a 20-byte hex string is an address, a 32-byte hex string is `bytes32`, `true` or `false` is a bool, an integer (or `options.range`) is a `uint256`, and anything else is `bytes32`. A short hex string such as `"0x01"` counts as an integer; set `decode_as: bytes32` to compare raw bytes instead (shorter hex values are padded with zeros on the left).

Solidity packs small variables into one slot, starting at the low-order end. For this layout:

```solidity
contract Example {
    address public owner;        // slot 0, bytes 0-19
    uint96 public flags;         // slot 0, bytes 20-31
    uint256 public totalSupply;  // slot 1
}
```

the following checks read each variable from storage:

```yaml
- type: storage_slot
  id: owner-slot
  slot: 0
  value: '0x85c94597Fb2efeaf0196F42F7b9e4d3B9AE899ED'
  options: { decode_as: address, offset: 0, size: 20 }

- type: storage_slot
  id: flags-slot
  slot: 0
  value: 1
  options: { offset: 20, size: 12 }

- type: storage_slot
  slot: 1
  value: '1000000 ether'
```

With `size`, integers are read at that width: `uint256` with `size: 12` reads a `uint96`, and `int256` decodes two's complement at that width. `offset + size` must fit in 32 bytes, an address is always 20 bytes, and a packed bool defaults to 1 byte.

An address read from a whole slot (without `offset` or `size`) must be padded with zeros. If the upper 12 bytes are not zero, the check reports drift with the message `slot holds more than an address`, so a packed slot is never mistaken for a matching address.

Keys: `slot(0x1)` and `slot(IMPLEMENTATION_SLOT)`. Long slot numbers are shortened, as in `slot(0x360894a1...382bbc)`.

## proxy

Checks the [ERC-1967](https://eips.ethereum.org/EIPS/eip-1967) slots of an upgradeable proxy.

| Field                   | Required                  | Description                                                    |
| ----------------------- | ------------------------- | -------------------------------------------------------------- |
| `checks.implementation` | at least one of the three | Expected implementation address, read from slot `0x3608…2bbc`. |
| `checks.admin`          |                           | Expected admin address, read from slot `0xb531…6103`.          |
| `checks.beacon`         |                           | Expected beacon address, read from slot `0xa3f0…3d50`.         |

```yaml
- type: proxy
  checks:
    implementation: '0x689E65f1E6129FCF5cb831bD827c977cC2C801A9'
    admin: '0x91B5b55f7DCe16276Fa965491174304C18f051b2'
```

Each address is a separate check, decoded with the same strict address rule as `storage_slot`. An unset slot reads as the zero address, so you can also assert that a slot is empty, for example that a UUPS proxy has no admin: `admin: "0x0000000000000000000000000000000000000000"`.

For a proxy that keeps its implementation in another slot, use `storage_slot` with that slot. To check the implementation behind a beacon, add the beacon as a contract with the `proxy` preset and check its `implementation()` function.

Keys: `proxy.implementation`, `proxy.admin` and `proxy.beacon`, or `<id>.implementation` and so on when the check has an `id`.

## array_state

Checks a function that returns an array.

| Field                 | Required                 | Description                                                              |
| --------------------- | ------------------------ | ------------------------------------------------------------------------ |
| `function`            | yes                      | Function name or signature. It must return an array.                     |
| `args`                | no                       | Arguments.                                                               |
| `checks.length`       | at least one of the four | The exact number of items.                                               |
| `checks.contains`     |                          | Items that must be present.                                              |
| `checks.not_contains` |                          | Items that must be absent.                                               |
| `checks.exact`        |                          | The complete array, in order. With `options.ignore_order`, in any order. |

This example checks the owners and the threshold of a Safe multisig:

```yaml
- type: array_state
  function: 'getOwners() returns (address[])'
  checks:
    length: 3
    exact:
      - '0x85c94597Fb2efeaf0196F42F7b9e4d3B9AE899ED'
      - '0xEC823f59236afc3Ca41b477C8c5ac2e47BAd4047'
      - '0x19C3C182A18DE1681C666237A91c875c58A56260'
  options:
    ignore_order: true

- type: variable
  name: 'getThreshold() returns (uint256)'
  value: 2
```

Items are converted to the array's element type. Each entry under `checks` is reported as a separate check: `getOwners().length`, `getOwners().exact`. On drift, `contains` lists the missing items, `not_contains` the unexpected ones, and `exact` both. `options.ignore_case` compares string items without regard to case.

## mapping_state

Calls a mapping getter once for each listed key.

| Field      | Required | Description                                                                                                                                 |
| ---------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `function` | yes      | Getter name or signature.                                                                                                                   |
| `keys`     | yes      | A list of `{ key, value }` pairs. `key` is the argument; for nested mappings and getters with several arguments, it is a list of arguments. |

```yaml
- type: mapping_state
  function: balanceOf
  keys:
    - key: '0x69834F70169dd7E0ecA5AE7c343a47fe9D36cDd4'
      value: '1000000 ether'
    - key: '0xB8A00Df65eD2E589a6be0153f8a5463705C03dAB'
      value: 0

- type: mapping_state
  function: allowance
  keys:
    - key: ['0x69834F70169dd7E0ecA5AE7c343a47fe9D36cDd4', '0xB8A00Df65eD2E589a6be0153f8a5463705C03dAB']
      value: 0
```

Every key becomes its own check, and `options` apply to each of them. Keys: `balanceOf(0x6983…)` and `allowance(0x6983…, 0xB8A0…)`, or `<id>[0x6983…]` when the check has an `id`.

## cross_contract

Calls a function of another contract in the same config, and reports the result under the contract that declares the check. Use it to keep related checks together.

| Field                                | Required | Description                                                                       |
| ------------------------------------ | -------- | --------------------------------------------------------------------------------- |
| `target_contract`                    | yes      | Name of another contract in the config. The function is resolved against its ABI. |
| `function`, `args`, `field`, `value` |          | As for [function_call](#function_call).                                           |

```yaml
contracts:
  Vault:
    address: '0xB8A00Df65eD2E589a6be0153f8a5463705C03dAB'
    preset: erc4626
    state:
      - type: variable
        name: asset
        value: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
      - type: cross_contract
        target_contract: USDC
        function: balanceOf
        args: ['0xB8A00Df65eD2E589a6be0153f8a5463705C03dAB']
        value: '1000000e6'
        options:
          comparison: '>='

  USDC:
    address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
    preset: erc20
    state:
      - type: variable
        name: decimals
        value: 6
```

Key: `USDC.balanceOf(0xB8A0…)`.

## aggregate

Combines several reads into one integer and checks it.

| Field       | Required                                                | Description                                     |
| ----------- | ------------------------------------------------------- | ----------------------------------------------- |
| `operation` | yes                                                     | `sum`, `count`, `average`, `min` or `max`.      |
| `sources`   | yes                                                     | The values to combine. See [Sources](#sources). |
| `value`     | yes, unless `options.range` or `options.pattern` is set | Expected result.                                |

- `sum`, `average`, `min` and `max` need sources that return integers. `average` uses integer division, which rounds toward zero.
- `count` counts the sources that are `true` or non-zero. Its sources may return booleans or integers, and its constants are booleans.

This example checks the stablecoins a treasury holds across two wallets and two tokens with the same number of decimals:

```yaml
contracts:
  USDC:
    address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
    preset: erc20
    state:
      - type: aggregate
        id: treasury-stablecoins
        operation: sum
        sources:
          - { function: balanceOf, args: ['0x69834F70169dd7E0ecA5AE7c343a47fe9D36cDd4'] }
          - { function: balanceOf, args: ['0xB8A00Df65eD2E589a6be0153f8a5463705C03dAB'] }
          - { contract: USDT, function: balanceOf, args: ['0x69834F70169dd7E0ecA5AE7c343a47fe9D36cDd4'] }
          - { contract: USDT, function: balanceOf, args: ['0xB8A00Df65eD2E589a6be0153f8a5463705C03dAB'] }
        value: '5000000e6'
        options:
          comparison: '>='

  USDT:
    address: '0xdAC17F958D2ee523a2206206994597C13D831ec7'
    preset: erc20
    state:
      - type: variable
        name: decimals
        value: 6
```

Without an `id`, the key lists the operation and every source: `sum(balanceOf(0x6983…), …, USDT.balanceOf(0xB8A0…))`.

## comparison

Compares two values read in the same run. Values from contracts on the same network are read at the same pinned block.

| Field      | Required | Description                                                                                                                    |
| ---------- | -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `left`     | yes      | A [source](#sources).                                                                                                          |
| `operator` | yes      | `==`, `!=`, `>`, `>=`, `<` or `<=`, or a word alias such as `greater_than` (see [Operators](comparison-options.md#operators)). |
| `right`    | yes      | A [source](#sources).                                                                                                          |

At least one side must read from the chain; a constant on the other side is converted to its type. `>`, `>=`, `<` and `<=` need integers on both sides. `==` and `!=` compare values of any type exactly.

A Uniswap V2 pair never holds less of a token than its recorded reserve. This comparison checks that invariant for the USDC side of the USDC/WETH pair:

```yaml
contracts:
  USDC_WETH_Pair:
    address: '0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc'
    abi:
      - 'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)'
    state:
      - type: comparison
        id: usdc-balance-covers-reserve
        left: { contract: USDC, function: balanceOf, args: ['0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc'] }
        operator: '>='
        right: { function: getReserves, field: reserve0 }

  USDC:
    address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
    preset: erc20
    state:
      - type: variable
        name: symbol
        value: USDC
```

The report shows both values. Without an `id`, the key is the comparison itself: `USDC.balanceOf(0xB4e1…) >= getReserves().reserve0`.

## time_based

Checks that a timestamp returned by a contract is recent, for example the last update of a price feed.

| Field             | Required | Description                                                     |
| ----------------- | -------- | --------------------------------------------------------------- |
| `function`        | yes      | Function name or signature that returns a unix timestamp.       |
| `args`            | no       | Arguments.                                                      |
| `field`           | no       | The timestamp output, for functions with several return values. |
| `max_age_seconds` | yes      | Maximum age in seconds.                                         |

```yaml
- type: time_based
  function: latestRoundData
  field: updatedAt
  max_age_seconds: 3600
```

The age is the pinned block's timestamp minus the returned timestamp. It does not depend on the clock of the machine that runs nodrift, and with `--block` it is the age as of that block. The check passes when the age is at most `max_age_seconds`, and the report shows the age as the actual value. A timestamp in the future passes, and the message says so. Key: `latestRoundData().updatedAt age`.

## conditional

Runs checks only when a condition holds, and optionally other checks when it does not.

| Field                                    | Required | Description                                                                          |
| ---------------------------------------- | -------- | ------------------------------------------------------------------------------------ |
| `condition.function` or `condition.name` | yes      | What to read, as in `function_call` or `variable`. `args` and `field` work as usual. |
| `condition.contract`                     | no       | Read the condition from another contract in the config.                              |
| `condition.operator`                     | no       | `==` (default), `!=`, `>`, `>=`, `<`, `<=` or a word alias.                          |
| `condition.value`                        | yes      | The value to compare with, converted like an expected value.                         |
| `then`                                   | yes      | Checks to run when the condition holds.                                              |
| `else`                                   | no       | Checks to run when it does not.                                                      |

For an ERC-4626 vault with a pause switch, this asserts that deposits are open while the vault is running and closed while it is paused:

```yaml
- type: conditional
  id: deposits
  condition:
    name: 'paused() returns (bool)'
    value: false
  then:
    - type: function_call
      function: maxDeposit
      args: ['0x69834F70169dd7E0ecA5AE7c343a47fe9D36cDd4']
      value: 0
      options:
        comparison: '>'
  else:
    - type: function_call
      function: maxDeposit
      args: ['0x69834F70169dd7E0ecA5AE7c343a47fe9D36cDd4']
      value: 0
```

The condition is read first. Only the selected branch produces results, and their keys start with the conditional's key: `deposits -> then -> maxDeposit(0x6983…)`. If the selected branch is empty, because the condition is false and there is no `else`, the conditional reports a single `skipped` result. If the condition cannot be read, it reports a single `error`. Branch checks belong to the same contract as the conditional, and conditionals can be nested. Without an `id`, the key describes the condition: `if paused == false`.

## Sources

`aggregate` and `comparison` read their inputs from sources:

| Field           | Description                                                                            |
| --------------- | -------------------------------------------------------------------------------------- |
| `function`      | Function name or signature to call.                                                    |
| `name`          | Function without arguments to read, as in a `variable` check.                          |
| `args`, `field` | As for [function_call](#function_call).                                                |
| `contract`      | Read from another contract in the config instead of the current one.                   |
| `value`         | A constant instead of a read.                                                          |
| `type`          | `function_call`, `variable` or `constant`. Optional; it follows from the fields above. |
