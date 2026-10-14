# Architecture

A run has three stages. **Load** turns the YAML files into a list of typed, executable checks without touching the network. **Verify** connects to each network once, pins a block and evaluates the checks against it. **Report** renders the results and picks the exit code.

```text
load    read YAML -> resolve ABI files -> substitute ${...} -> merge imports
        -> apply templates and presets -> validate schema -> normalize to checks

verify  per network: check chain id -> pin block -> detect Multicall3
        then: evaluate checks (bounded concurrency, batched, deduplicated) -> results

report  text | plan | JSON | JUnit -> exit code
```

`nodrift validate` runs the load stage only. `nodrift verify` runs all three.

## Load

The loader lives in `src/config/`.

1. **Read YAML** (`yaml.ts`). Files are parsed with a schema that reads plain decimal integers as numbers only when they fit a double exactly (below 2^53). Hex values, larger integers and decimal fractions stay strings, so an unquoted address or a `uint256` amount is never rounded on the way in. Each file may only contain the top-level keys `version`, `network`, `imports`, `templates` and `contracts`.
2. **Resolve ABI files** (`abi.ts`). An `abi` given as a path, in `contracts` or `templates`, is replaced by the ABI it points to: a plain ABI array, or the `abi` field of a Foundry, Hardhat or Truffle artifact. This happens before substitution, so ABI paths are literal.
3. **Substitute variables** (`substitute.ts`). `${VAR}`, `${env:VAR}`, `${VAR || default}`, `${file:path}` and `${file:path:field}` are resolved, and `$${...}` produces a literal. Any other `${prefix:...}` is an error. Missing variables are collected and reported together.
4. **Merge imports** (`load.ts`). Imported files are loaded recursively, each resolved relative to its own directory, with cycle detection. They are merged in order, and the importing file is applied last.
5. **Apply templates and presets**. A contract's template provides default fields; `abi` and `state` lists are concatenated. A preset adds the ABI fragments of a standard interface (`src/presets/`); where the contract's own `abi` declares the same signature, the contract's declaration is used.
6. **Validate the schema** (`schema.ts`). A strict [Zod](https://zod.dev) schema checks the merged config; unknown keys are errors, with hints for common mistakes. The same schema generates `nodrift.schema.json` for editors.
7. **Normalize** (`normalize.ts`). For each contract, an ABI interface is built, with exact duplicates removed. Every function reference is resolved, every argument and expected value is converted to its ABI type, options are checked against the check type, and each check gets a unique key. Networks with the same chain id, RPC URL and block are merged into one connection. Every problem found in this step is collected, so one run of `validate` reports all of them.

File references (`abi` paths, `imports`, `${file:...}`) go through `paths.ts`, which resolves symlinks and refuses anything outside the working directory and the referencing file's directory.

## Verify

`src/verify.ts` and `src/chain/` connect and evaluate; `src/check/` compares.

1. **Connect** (`chain/client.ts`). For each connection, nodrift
   - calls `eth_chainId` and stops with a connection error if it differs from `chain_id`;
   - resolves the configured block (`latest`, `safe`, `finalized` or a number) once, and records its number, hash and timestamp;
   - unless `multicall: false`, checks whether Multicall3 has code at `0xcA11bde05977b3631167028862bE2a173976CA11` at that block.

   All connections must succeed before any check runs. A `--block` override replaces the block of every connection; a block number is refused when the config uses more than one chain.

2. **Evaluate** (`check/evaluate.ts`). At most 32 checks are evaluated at a time. Every read targets the pinned block number:
   - Before the first read from a contract, nodrift fetches the code at its address once. If there is none, the contract's checks report `no contract code` errors instead of decoding empty results.
   - `eth_call`s with the same target and calldata are made once per connection, and checks that need them share the result.
   - Calls issued in the same tick are sent as one Multicall3 `aggregate3` call with `allowFailure` set, in batches of up to 200, so a revert affects only its own check. If a batch fails as a whole, its calls are retried individually. Without Multicall3, every call is a separate `eth_call`.
   - Storage reads use `eth_getStorageAt`.
   - Failures that may be transient (network errors, timeouts, rate limiting with HTTP 429, server errors with HTTP 5xx) are retried up to `max_retries` times with exponential backoff. Other errors, including reverts and client errors such as `401` or `403`, are not retried.
3. **Compare** (`check/compare.ts`, `check/values.ts`). Decoded values are converted to the same representation as the expected values: integers as `bigint`, addresses checksummed, bytes as lowercase hex, tuples as objects or lists. Equality, operators, tolerances and ranges are computed on integers. Each check produces one or more results with status `pass`, `drift`, `error` or `skipped`.

## Report

`src/output/` renders a run as text, as a plan, as JSON or as JUnit XML. All renderers print integers in full. `src/common/exit-codes.ts` maps the outcome to an exit code: check errors win over drift, and drift fails the run only with `--fail-on-drift`.

## Design decisions

**One pinned block per network.** The block is resolved once at the start, and every call, storage read and code check of that connection uses its number. A run is therefore a consistent snapshot: a comparison between two contracts on the same network can never mix states from different blocks, and `time_based` checks measure age against the block's timestamp instead of the local clock. The same snapshot can be read again with `--block`. Contracts that use different RPC URLs or chains get separate connections, and each pins its own block.

**Exact integer math.** Solidity integers go up to 256 bits; JavaScript numbers are exact only up to 2^53. nodrift keeps integers exact end to end: the YAML parser never converts large values to floating point, expected values are parsed into `bigint` (including forms such as `"1.5 ether"` and `"1e21"`, which must come out as whole numbers), relative tolerances are evaluated as integer ratios, and the JSON report writes integers as strings.

**A strict schema.** A misspelled key that is silently ignored can turn a check into one that always passes. Unknown keys, options that a check type does not use, and values that do not fit their ABI type are therefore rejected before anything is read, and all problems are reported at once.

**No code execution from configs.** Config files are data. Variable substitution has no command or expression forms, ABI files are parsed as JSON, and file references are confined to the project after resolving symlinks. Configs can be reviewed like any other data file.

**Errors are never reported as passes.** A revert, an empty or undecodable return value, or a missing contract makes the check an `error`, and any error makes the run exit with code 4, with or without `--fail-on-drift`. The `owner` check only falls back to `getOwner()` when `owner()` fails at the contract level, not when the network fails. Conditionals report a `skipped` result instead of disappearing when no branch applies.

**Read-only.** nodrift uses only read methods of the JSON-RPC API and holds no keys.

**Hosts instead of URLs.** RPC URLs often contain API keys. Report headers and the JSON report's `networks` section identify an endpoint by its host. Every error from the RPC client is scrubbed before it is logged or reported: the URL is replaced by its host, and path segments, query values and credentials long enough to be keys are removed.

## Source layout

| Path                            | Contents                                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| `src/cli.ts`, `src/cli/init.ts` | Command-line interface and the `init` wizard                                              |
| `src/config/`                   | YAML parsing, ABI files, variable substitution, imports, templates, schema, normalization |
| `src/presets/`                  | ABI fragments of the presets                                                              |
| `src/chain/`                    | RPC client: chain id check, block pinning, retries, Multicall3 batching, revert decoding  |
| `src/check/`                    | Typed values, exact comparison, check evaluation                                          |
| `src/output/`                   | Text, plan, JSON and JUnit reports                                                        |
| `src/services/etherscan.ts`     | ABI download for `nodrift init` (Etherscan V2 API)                                        |
| `src/verify.ts`                 | Runs the checks of a loaded config                                                        |
| `src/index.ts`                  | Library entry point                                                                       |

## Using nodrift as a library

The package exports the same building blocks that the CLI uses:

| Export                                                                                 | Purpose                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loadConfig(file, { env, roots })`                                                     | Load and normalize a config. Throws `ConfigurationError` or `ValidationError`. `env` defaults to `process.env`, `roots` (directories that file references may point into) to the working directory. |
| `verify(config, { block, concurrency })`                                               | Connect, evaluate every check and return the results. Throws `ConnectionError` when an endpoint is unreachable or on the wrong chain.                                                               |
| `verifyFile(file, options)`                                                            | `loadConfig` and `verify` in one call.                                                                                                                                                              |
| `renderText`, `renderPlan`, `renderJson`, `renderJUnit`, `writeJUnit`                  | The report renderers.                                                                                                                                                                               |
| `exitCodeForResult(result, failOnDrift)`, `exitCodeForError(error)`, `ExitCode`        | The CLI's exit code rules.                                                                                                                                                                          |
| `loadRawConfig`, `normalize`, `ConfigSchema`, `StateEntrySchema`, `PRESETS`, `VERSION` | Lower-level pieces.                                                                                                                                                                                 |

```ts
import { exitCodeForResult, loadConfig, renderText, verify } from 'nodrift';

const config = loadConfig('nodrift.yaml');
const result = await verify(config, { block: 'finalized' });

console.log(renderText(result));
for (const r of result.results) {
  if (r.status === 'drift' || r.status === 'error') console.log(r.contract, r.key, r.message ?? '');
}
process.exitCode = exitCodeForResult(result, true);
```

Unlike the CLI, the library does not load `.env` files.
