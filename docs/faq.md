# FAQ

- [What does nodrift do, and what not?](#what-does-nodrift-do-and-what-not)
- [Does nodrift send transactions or need a private key?](#does-nodrift-send-transactions-or-need-a-private-key)
- [Which chains does it work with?](#which-chains-does-it-work-with)
- [Do I need ABI files?](#do-i-need-abi-files)
- [What is the difference between drift and an error?](#what-is-the-difference-between-drift-and-an-error)
- [How do I check values that change all the time?](#how-do-i-check-values-that-change-all-the-time)
- [Why must expected values match the ABI type?](#why-must-expected-values-match-the-abi-type)
- [Why are numbers strings in the JSON report?](#why-are-numbers-strings-in-the-json-report)
- [Can I read state at an older block?](#can-i-read-state-at-an-older-block)
- [How many RPC requests does a run make?](#how-many-rpc-requests-does-a-run-make)
- [Does it work with proxies?](#does-it-work-with-proxies)
- [Why does validate need my environment variables?](#why-does-validate-need-my-environment-variables)
- [Is it safe to run a config from someone else?](#is-it-safe-to-run-a-config-from-someone-else)
- [Can my RPC API key end up in logs or reports?](#can-my-rpc-api-key-end-up-in-logs-or-reports)
- [Can I use nodrift from code?](#can-i-use-nodrift-from-code)

## What does nodrift do, and what not?

nodrift reads contract state at one pinned block per network, compares it with the expectations in a YAML file, reports every difference and exits with a code that CI can act on. Each run is a single check; for continuous monitoring, schedule it, for example as a [CI job](ci-cd-integration.md). It does not watch events, keep history between runs, or change anything on-chain.

## Does nodrift send transactions or need a private key?

No. It uses read-only JSON-RPC methods: `eth_chainId`, `eth_getBlockByNumber`, `eth_call`, `eth_getStorageAt` and `eth_getCode`. It never signs anything, so it needs no keys.

## Which chains does it work with?

Any EVM chain with an HTTP or HTTPS JSON-RPC endpoint. The endpoint's chain id is checked against `chain_id` before anything is read. Multicall3 batching is used where Multicall3 is deployed at its usual address and skipped elsewhere. One config can read from several chains; see [Contracts on several chains](configuration.md#contracts-on-several-chains). WebSocket endpoints are not supported.

## Do I need ABI files?

Often not. `owner`, `role`, `storage_slot` and `proxy` checks need no ABI. [Presets](presets.md) cover ERC-20, ERC-721, ERC-1155, ERC-4626, diamonds, proxies and AccessControl. Any other function can be written as an inline signature, such as `"getThreshold() returns (uint256)"`. ABI files and Foundry or Hardhat artifacts are supported when you have them. `nodrift init` can fetch verified ABIs from Etherscan.

## What is the difference between drift and an error?

Drift means the value was read and differs from the expectation. An error means the value could not be read: the call reverted, returned nothing, returned data that does not match the declared types, or there was no contract at the address. nodrift never treats an error as a pass. Drift fails the run only with `--fail-on-drift` (exit code 1); errors always fail it (exit code 4).

## How do I check values that change all the time?

Express the expectation as a bound instead of an exact value: an operator (`comparison: ">="`), a `range`, or a `tolerance` such as `"0.5%"`. For timestamps, use a [`time_based`](state-types.md#time_based) check. For relations between values, such as "the balance covers the recorded reserve", use a [`comparison`](state-types.md#comparison). See [Comparison options](comparison-options.md).

## Why must expected values match the ABI type?

Typing catches mistakes before they turn into silent passes or confusing drift: a misspelled address fails its checksum, `256` does not fit a `uint8`, `1.5` is not an integer. Integers are compared exactly, at full 256-bit precision, and nothing is rounded. See [How expected values are typed](comparison-options.md#how-expected-values-are-typed).

## Why are numbers strings in the JSON report?

JSON numbers lose precision above 2^53 in most JSON parsers, which is far below the range of `uint256`. Writing integers as decimal strings keeps them exact.

## Can I read state at an older block?

Yes. Set `block` in the network section, or pass `--block <number>`. Every check of that network reads at that block, and `time_based` checks measure age as of that block. The endpoint must still serve the state of that block; for older blocks that usually means an archive node.

## How many RPC requests does a run make?

It depends on the config. Calls made at the same time are batched into Multicall3 `aggregate3` requests, identical calls are made once, and the code at each contract address is checked once. Storage reads use one request each. The JSON report lists the number of requests per network in `networks[].requests`.

## Does it work with proxies?

Yes. Calls to a proxy address run the implementation's code against the proxy's storage, so `variable` and `function_call` checks see the state your users see. The [`proxy`](state-types.md#proxy) check reads the ERC-1967 implementation, admin and beacon slots, and [`storage_slot`](state-types.md#storage_slot) reads any other slot.

## Why does validate need my environment variables?

Variables are substituted before validation, because expected values and arguments are typed after substitution. `validate` does not connect to the chain, so placeholder values of the right shape are enough; see [Validating configs in pull requests](ci-cd-integration.md#validating-configs-in-pull-requests).

## Is it safe to run a config from someone else?

A config cannot run commands or evaluate expressions, and it can only read files inside the working directory or its own directory. Treat it like code anyway: a config decides which RPC endpoints nodrift contacts, and it can place the environment variables and project files it references into the requests it sends, for example into the RPC URL. Review configs from outside sources before running them with your environment.

## Can my RPC API key end up in logs or reports?

Not through nodrift's own output. The report header (`chain 1 via eth-mainnet.g.alchemy.com`), the JSON `networks[].host` field and all messages contain only the host of the RPC URL. Errors from the endpoint, such as `401` for a wrong key or `500`, are scrubbed before nodrift logs or reports them: the URL is replaced by its host, and path segments, query values and credentials long enough to be keys are removed. Values you reference with `${VAR}` in a config are a different matter: an expected value appears in reports like any other, so do not reference secrets there.

## Can I use nodrift from code?

Yes. The package exports the loader, the verifier and the report renderers. See [Using nodrift as a library](architecture.md#using-nodrift-as-a-library).
