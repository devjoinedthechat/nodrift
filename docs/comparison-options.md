# Comparison options

By default a check passes when the on-chain value equals `value` exactly. The `options` of a check change how the value is matched: with an operator, a tolerance, a range or a pattern. This page also explains how expected values are written, because every expected value is converted to the type the contract returns before anything is compared.

- [How expected values are typed](#how-expected-values-are-typed)
- [Writing integers](#writing-integers)
- [Options](#options)
- [Options by check type](#options-by-check-type)
- [Operators](#operators)
- [Tolerance](#tolerance)
- [Range](#range)
- [Pattern](#pattern)
- [ignore_case and ignore_order](#ignore_case-and-ignore_order)

## How expected values are typed

nodrift converts each expected value to the ABI type of the value it is compared with, and refuses values that do not fit. `nodrift validate` reports these mistakes before anything is read from the chain.

| ABI type                                         | Write the expected value as                                                                                         | Compared as                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `uint<N>`, `int<N>`                              | An integer in any of the [integer forms](#writing-integers). It must fit the type: `256` is rejected for a `uint8`. | Exact integers.                                       |
| `address`                                        | A hex address, EIP-55 checksummed or all lowercase.                                                                 | Checksummed addresses, so letter case never matters.  |
| `bool`                                           | `true` or `false`.                                                                                                  | Booleans.                                             |
| `string`                                         | Text. Numbers are taken as their text, so `value: 6` matches `"6"`.                                                 | Exact text, unless `ignore_case` is set.              |
| `bytes`, `bytes<N>`                              | `0x`-prefixed hex; `bytes<N>` needs exactly N bytes.                                                                | Lowercase hex.                                        |
| `T[]`, `T[N]`                                    | A list. A fixed-size array needs exactly N items.                                                                   | Item by item, in order, unless `ignore_order` is set. |
| Tuples, and functions with several return values | A list in output order, or a mapping by output name when every output has a name.                                   | Field by field.                                       |

The same rules apply to function arguments, mapping keys, condition values and the items of `array_state` checks.

## Writing integers

| Form             | Example                               | Value                     |
| ---------------- | ------------------------------------- | ------------------------- |
| Decimal          | `1000` or `"1000"`                    | 1000                      |
| With underscores | `1_000_000`                           | 1000000                   |
| Hex              | `"0x3e8"`                             | 1000                      |
| Scientific       | `"1e21"`, `"1.5e3"`                   | 10^21, 1500               |
| Units            | `"1.5 ether"`, `"30 gwei"`, `"7 wei"` | 1.5 × 10^18, 3 × 10^10, 7 |
| Negative         | `-5`                                  | -5, for signed types      |

`ether` means 10^18 and works for any amount with 18 decimals. For tokens with other decimals, the scientific form is clearer: `"250000e6"` is 250,000 tokens with 6 decimals. A value that is not a whole number, such as `1.5`, `"1.25e1"` or `"0.1 wei"`, is rejected instead of rounded. Integers keep their exact value at any size, with or without quotes.

## Options

| Option                        | Description                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `comparison`                  | Operator applied to the actual and the expected value. Default `==`. See [Operators](#operators).                  |
| `tolerance`                   | Allowed deviation from `value`: absolute (`1000`, `"1 gwei"`) or relative (`"0.5%"`). See [Tolerance](#tolerance). |
| `range`                       | Inclusive `min` and `max` bounds. Used instead of `value`. See [Range](#range).                                    |
| `pattern`                     | Regular expression. Used instead of `value`. See [Pattern](#pattern).                                              |
| `ignore_case`                 | Compare text without regard to case. Also makes `pattern` case-insensitive.                                        |
| `ignore_order`                | Compare lists without regard to order.                                                                             |
| `description`                 | Text shown next to the check in reports. Accepted by every check type.                                             |
| `decode_as`, `offset`, `size` | How a `storage_slot` check decodes the slot. See [storage_slot](state-types.md#storage_slot).                      |

Checks that compare a value (`variable`, `function_call`, `cross_contract`, `mapping_state`, `aggregate` and `storage_slot`) set exactly one of `value`, `options.range` or `options.pattern`.

## Options by check type

| Check type                                                                  | Options besides `description`                                                |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `variable`, `function_call`, `cross_contract`, `mapping_state`, `aggregate` | `comparison`, `tolerance`, `range`, `pattern`, `ignore_case`, `ignore_order` |
| `storage_slot`                                                              | the same, plus `decode_as`, `offset`, `size`                                 |
| `array_state`                                                               | `ignore_case`, `ignore_order`                                                |
| `owner`, `role`, `proxy`, `comparison`, `time_based`, `conditional`         | none                                                                         |

An option that a check type does not use is an error, for example `options.tolerance: does not apply to time_based checks`. A `comparison` check sets its operator in its own `operator` field, and a `conditional` in `condition.operator`.

## Operators

| Operator | Word alias              | Value types |
| -------- | ----------------------- | ----------- |
| `==`     | `equals`                | any         |
| `!=`     | `not_equals`            | any         |
| `>`      | `greater_than`          | integers    |
| `>=`     | `greater_than_or_equal` | integers    |
| `<`      | `less_than`             | integers    |
| `<=`     | `less_than_or_equal`    | integers    |

The operator reads as `actual <operator> value`:

```yaml
- type: variable
  name: totalSupply
  value: '1000000 ether'
  options:
    comparison: '<='

- type: function_call
  function: balanceOf
  args: ['0x69834F70169dd7E0ecA5AE7c343a47fe9D36cDd4']
  value: 0
  options:
    comparison: greater_than
```

Quote the symbols in YAML (`">="`, `"!="`): an unquoted `>` or `!` has a special meaning there. The word aliases need no quotes. `>`, `>=`, `<` and `<=` on a non-integer value are rejected when the config is validated. Reports show the expectation with its operator, for example `expected  > 0`.

## Tolerance

`tolerance` lets an integer deviate from `value`:

- Absolute: an integer in any [integer form](#writing-integers), such as `1000`, `"1 gwei"` or `"5e18"`.
- Relative: a percentage of `value`, such as `"0.5%"` or `"2%"`.

```yaml
- type: variable
  name: totalSupply
  value: '1000000 ether'
  options:
    tolerance: '0.5%'
```

The check passes when the difference between the actual value and `value` is at most the tolerance; the bounds are inclusive. Relative tolerances are computed with integer arithmetic, so there is no floating-point rounding even for 256-bit values. `tolerance` needs `value` and an integer type, and works with `==` (pass when within tolerance) and `!=` (pass when outside it). Reports show it as `1000000000000000000000000 (± 0.5%)`.

## Range

`range` checks that an integer lies between two bounds. Either bound can be left out, and both are inclusive.

```yaml
- type: function_call
  function: balanceOf
  args: ['0x69834F70169dd7E0ecA5AE7c343a47fe9D36cDd4']
  options:
    range:
      min: '100000 ether'
      max: '250000 ether'
```

`range` replaces `value`, needs an integer type, and cannot be combined with an operator other than `==`. Bounds accept every [integer form](#writing-integers). Reports show it as `in [100000000000000000000000, 250000000000000000000000]`, with `-inf` or `+inf` for a missing bound.

## Pattern

`pattern` matches the value against a regular expression (JavaScript syntax).

```yaml
- type: variable
  name: name
  options:
    pattern: '^USD'
    ignore_case: true
```

The expression is tested against strings as they are, addresses in checksummed form, bytes as lowercase hex and integers as decimal digits. It matches anywhere in the value unless you anchor it with `^` and `$`. `pattern` replaces `value` and cannot be combined with an operator other than `==`. Booleans, lists and tuples cannot be matched against a pattern; `nodrift validate` rejects such a check. Reports show the pattern as `matches /^USD/i`.

## ignore_case and ignore_order

`ignore_case` compares text without regard to case, inside lists and tuples too. Addresses and bytes are normalized before every comparison, so their letter case never matters and they do not need this option.

`ignore_order` compares lists as multisets: the same items, each the same number of times, in any order. For `array_state` it applies to `checks.exact`.

```yaml
- type: function_call
  function: 'getSupportedAssets() returns (address[])'
  value:
    - '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
    - '0xdAC17F958D2ee523a2206206994597C13D831ec7'
  options:
    ignore_order: true
```
