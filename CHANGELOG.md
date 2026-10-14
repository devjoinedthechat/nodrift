# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0]

First public release.

### Added

- Checks for owners, AccessControl roles (single account or exact member set), public variables, function calls with arguments and multi-value returns, raw and packed storage slots, ERC-1967 proxies, arrays, mappings, cross-contract reads, aggregates, comparisons, conditionals and timestamp freshness.
- Comparison options: `==`, `!=`, `>`, `>=`, `<`, `<=`, absolute and relative tolerance, ranges, regular expressions, case- and order-insensitive matching.
- Expected values are typed against the ABI and compared with exact integer arithmetic. Integers can be written as `1_000`, `0x3e8`, `1e21`, `1.5 ether` or `30 gwei`.
- Every network is read at one pinned block (`latest`, `safe`, `finalized` or a number). The RPC chain id is checked before any read.
- Calls are batched through Multicall3 when it is deployed, with automatic fallback to single calls.
- Inline function signatures (`balanceOf(address) returns (uint256)`), ABI files, Foundry/Hardhat artifacts and presets for ERC-20, ERC-721, ERC-1155, ERC-4626, EIP-2535 diamonds, proxies and AccessControl.
- Imports, templates, `${VAR}`, `${VAR || default}` and `${file:path[:field]}` substitution.
- Text, Terraform-style plan, JSON and JUnit reports. Distinct exit codes for drift, check errors, connection, configuration and validation errors; invalid command-line arguments exit with 2.
- RPC URLs, which often carry API keys, are reduced to their host in every report, log and error message, including errors returned by the endpoint.
- Only transient RPC failures (timeouts, network errors, HTTP 429 and 5xx) are retried.
- `nodrift validate` checks configs offline, including ABI lookups and value types.
- `nodrift init` wizard with optional ABI download from the Etherscan V2 API.
- JSON Schema (`nodrift.schema.json`) for editor validation and completion, generated from the config schema.

### Changed from the unreleased prototype

- Unknown config keys are errors (`expected:` used to be ignored silently; it is `value:`).
- Checks that read the same function with different arguments are all evaluated; previously later checks overwrote earlier ones.
- A contract or check that cannot be read is reported as an error with exit code 4, even without `--fail-on-drift`; previously it could produce an empty, passing report.
- Storage slots are compared as full 32-byte words unless an offset and size select a packed field.
- `${cmd:...}` and `${math:...}` substitutions were removed, and file references are confined to the project directory.
- JSON reports no longer fail on large integers.
- Removed the experimental plugin, event and history system and the `--use-v2` flag.
