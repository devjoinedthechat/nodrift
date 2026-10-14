# Troubleshooting

The exit code tells you at which stage a run failed:

| Exit code | Stage                                                       | Section                                                   |
| --------- | ----------------------------------------------------------- | --------------------------------------------------------- |
| `2`       | Parsing command-line arguments and loading the config files | [Configuration errors](#configuration-errors-exit-code-2) |
| `5`       | Validating the config against the schema and the ABIs       | [Validation errors](#validation-errors-exit-code-5)       |
| `3`       | Connecting to the RPC endpoints                             | [Connection errors](#connection-errors-exit-code-3)       |
| `4`       | Evaluating individual checks                                | [Check errors](#check-errors-exit-code-4)                 |
| `1`       | Drift found with `--fail-on-drift`                          | [Unexpected drift](#unexpected-drift)                     |

## First steps

1. `nodrift validate nodrift.yaml` finds every configuration and validation problem without touching the chain, and lists all of them at once.
2. `--verbose` logs the pinned block, whether Multicall3 is used, and every retry to stderr.
3. `--plan` shows only the checks that drifted or failed.
4. `--output json` shows exact values, messages and the block number of the run; `jq` helps to filter it.

## Configuration errors (exit code 2)

**`error: unknown option` or another usage message**
Invalid command-line arguments, such as an unknown option or a malformed `--block`, exit with `2` before the config is read. The usage text printed to stderr names the problem.

**`Environment variable not set in .../nodrift.yaml: RPC_URL (used at network.rpc_url)`**
A `${VAR}` reference has no value; the message lists every missing variable and where it is used. Empty variables count as unset. Set the variable, put it in a `.env` file next to the config, or give a default: `${VAR || default}`. In GitHub Actions, check that the secret is mapped into the step's `env` and that the run was not triggered from a fork, which receives no secrets.

**`Unsupported substitution ${cmd:...}`**
Only `${VAR}`, `${VAR || default}`, `${env:VAR}`, `${file:path}` and `${file:path:field}` exist. Configs cannot run commands or evaluate expressions; compute such values before the run and pass them in as variables or files.

**`Invalid variable name in ${...}`**
Variable names consist of letters, digits and underscores. Shell syntax such as `${VAR:-default}` is not supported; write `${VAR || default}`.

**`... is outside the project directory. Only files under ... can be referenced.`**
`${file:...}`, `abi` paths and `imports` must resolve to a file inside the working directory or inside the directory of the config that references it, after symlinks are followed. Move the file into the project, or run nodrift from a directory that contains it.

**`ABI file not found: ${ABI_PATH}`**
ABI paths are read before variables are substituted, so they cannot contain `${...}`. Write the path literally, relative to the config file.

**`ABI file ... must contain an ABI array or an artifact with an "abi" field`**
The file is neither a plain ABI (a JSON array) nor a build artifact. Point to the artifact JSON that Foundry, Hardhat or Truffle writes, not to a build-info or metadata file.

**`Import cycle: a.yaml -> b.yaml -> a.yaml`**
Two files import each other. Move the shared part into a third file that both import.

**`Contract 'Vault' uses unknown template 'vault' (available: ...)`**
Template names are case-sensitive, and a template must be defined in the config or in one of its imports.

**`Invalid YAML in .../nodrift.yaml (line 12, column 31): ...`**
Common causes: an unquoted `${...}` inside `[...]` or `{...}`, and an unquoted operator such as `>=`. Quote both: `args: ["${TREASURY_ADDRESS}"]`, `comparison: ">="`.

**`A block number override needs a single chain; this config reads from several`**
`--block <number>` cannot apply one block number to different chains. Use a tag (`latest`, `safe`, `finalized`), or set `block` per network in the config.

## Validation errors (exit code 5)

Validation lists every problem with its location, for example `contracts.Token.state[2].value: ...`. Fix them from the top; one mistake can cause several messages.

**`unknown key 'expected' (did you mean 'value'?)`**
The schema is strict. Expected values are always `value`, a variable's function is `name`, and `decode_as`, `tolerance`, `range`, `pattern`, `ignore_case` and `description` belong under `options`. See [State types](state-types.md) for the fields of each type.

**`Unknown top-level key(s) in .../nodrift.yaml: includes (did you mean 'imports'?)`**
Only `version`, `network`, `imports`, `templates` and `contracts` are allowed at the top level of every file.

**`not a valid address (check the EIP-55 checksum casing, or write it in all lowercase)`**
A mixed-case address must have a correct EIP-55 checksum. This usually means a typo. Copy the address again from a trusted source, or write it in lowercase.

**`must be one of owner, role, variable, function_call, ...`**
The `type` of a check is misspelled or missing.

**`function 'x' is not in the ABI of Token. Add an 'abi', use a 'preset', or write a signature like 'x(...) returns (uint256)'`**
The function is not in the preset or the `abi`. Add it, or write the check with an inline signature.

**`'x' is overloaded in the ABI of Token; use a full signature`**
Several functions share the name. Write the signature you mean: `function: "x(address) returns (uint256)"`.

**`signature 'x()' must declare what it returns`**
An inline signature needs its return types, as in `"x() returns (uint256)"`. They tell nodrift how to decode the result and how to type `value`.

**`takes 1 argument(s), got 0`** or **`takes arguments; use a function_call check`**
`args` must match the function's inputs. `variable` checks only call functions without arguments.

**`expected an integer for uint256, got "1.5"`**, **`256 does not fit in uint8`**, **`expected 32 bytes for bytes32, got 1`**
Expected values are converted to the ABI type and never rounded or truncated. See [How expected values are typed](comparison-options.md#how-expected-values-are-typed).

**`missing 'value' (or options.range / options.pattern)`** or **`use only one of value, options.range`**
Value checks need exactly one way to express the expectation.

**`options.tolerance: does not apply to time_based checks`**
Each check type accepts a fixed set of options; see [Options by check type](comparison-options.md#options-by-check-type).

**`options.comparison: > needs a numeric value, but symbol() is string`**
`>`, `>=`, `<` and `<=`, `tolerance` and `range` need integer values. Use `pattern` or `ignore_case` for strings.

**`network.rpc_url: must be an http(s) URL`**
Only HTTP and HTTPS endpoints are supported. A variable that resolves to a `wss://` URL, or to anything that is not a URL, also causes this.

**`duplicate id 'x'`**
Ids must be unique within a contract. The keys of checks inside a conditional start with the conditional's key, so their ids only need to be unique within their branch.

**`slot holds more than an address`** is not a validation error but drift; see [Unexpected drift](#unexpected-drift).

## Connection errors (exit code 3)

**`Cannot reach RPC endpoint eth-mainnet.g.alchemy.com (chain_id 1): ...`**
The endpoint could not be reached, or answered `eth_chainId` with an error, even after retries. Check the URL, the API key, and network access from the CI runner. Increase `timeout` or `max_retries` in `network` for slow or rate-limited endpoints.

**`RPC endpoint ... is on chain 11155111, but the config says chain_id 1`**
The URL points to another network than the config expects. nodrift stops here on purpose: reading the right addresses on the wrong chain gives meaningless results.

**`Cannot fetch block 'finalized' from ...`** or **`Block '19000000' was not found on chain 1`**
The endpoint does not support the block tag, or the block number does not exist yet. Some chains and local development nodes do not support `safe` and `finalized`.

## Check errors (exit code 4)

A check error means the value could not be read. It is reported as `error`, never as a pass, and makes the run exit with `4` whether or not `--fail-on-drift` is set.

**`no contract code at 0x… on chain 1 (block 26192750)`**
There is no contract at that address at the pinned block. Typical causes: a wrong address, a contract deployed on another chain, or a pinned block from before the deployment. On local development chains, `safe` and `finalized` can resolve to a block before your deployment.

**`Token.x() returned no data; does 0x… implement x()?`**
The address has code, but the call returned nothing. The contract probably does not have this function (a fallback function swallowed the call), or the ABI declares a different signature.

**`Token.x() reverted: <reason>`**, **`reverted with NotAllowed(0x…)`**, **`panicked with code 0x11`**
The function reverted at the pinned block. Custom errors are decoded when they are in the contract's ABI. Some view functions revert by design for certain arguments or states; check the arguments and the contract's access rules.

**`returned data that does not decode as (uint256)`**
The declared return types do not match what the contract returns. Fix the ABI or the inline signature. A preset declares the standard types; for a contract that deviates from the standard, use an inline signature (see [Presets](presets.md#presets-and-your-own-abi)).

**`Listing role members needs AccessControlEnumerable`**
The contract does not implement `getRoleMemberCount`. Replace the `members` check with one `account` check per account, using `value: false` for accounts that must not have the role.

**`pattern needs a string value`**
`pattern` only applies to strings, addresses, bytes and integers.

**Errors on many checks at once, such as timeouts**
A request that still fails after the retries turns the checks that depend on it into errors. Increase `timeout` and `max_retries`, or use a less loaded endpoint. If an endpoint rejects large Multicall3 batches, nodrift falls back to individual calls by itself.

## Unexpected drift

**The value differs by a factor of 10^6 or 10^18**
Expected values are raw integers in the token's smallest unit. `"1.5 ether"` means 1.5 × 10^18 and only fits tokens with 18 decimals; for a token with 6 decimals write `"1.5e6"`.

**`slot holds more than an address (upper 12 bytes are non-zero)`**
The slot packs an address together with other data. Read the address part with `options: { offset: 0, size: 20 }` (adjust the offset to the layout), and check the other fields separately. See [storage_slot](state-types.md#storage_slot).

**Strings that look equal**
String comparison is exact: case and whitespace count. Use `ignore_case`, or a `pattern` such as `"^USD Coin$"`. Addresses and bytes are normalized, so their case never matters.

**Different results between two runs**
Each run reads at its own pinned block, and with `latest` that block moves. The report header and the JSON report name the block. Run with `--block <number>` to read at the same block again.

**A value that changes with every block**
Balances, supplies and prices change by design. Check them with `tolerance`, `range` or an operator instead of an exact value. See [Comparison options](comparison-options.md).

## CI and output

**No JUnit file after a failed run**
Reports are written only when the checks ran. With exit codes `2`, `3` and `5` there is no report; the error message is on stderr.

**Escape codes or no colors in logs**
Colors are only used when stdout is a terminal. Set `NO_COLOR=1` to turn them off everywhere, or `FORCE_COLOR=1` to turn them on.

**Values from `.env` are not used**
Variables already set in the environment take precedence over `.env`, and only one `.env` file is loaded: the one next to the config, or else the one in the working directory. `--no-env-file` disables loading.
