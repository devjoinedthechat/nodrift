# Getting started

This guide installs nodrift, writes a first config for the USDC token on Ethereum mainnet, and runs it.

## Requirements

- Node.js 22.13 or newer.
- An HTTP(S) JSON-RPC endpoint for the chain you want to read: a node provider or your own node.
- The addresses of the contracts you want to check.

## Install

nodrift needs Node.js 22.13 or newer. It is not published to the npm registry yet; npm fetches it from GitHub and builds it on first use.

Try it without installing:

```bash
npx --yes github:devjoinedthechat/nodrift --version
```

Add it to a project (the lockfile records the exact commit):

```bash
npm install --save-dev github:devjoinedthechat/nodrift
npx nodrift --version
```

For a global `nodrift` command, build it from source:

```bash
git clone https://github.com/devjoinedthechat/nodrift.git
cd nodrift
npm ci       # installs dependencies and builds dist/
npm link     # puts `nodrift` on your PATH
```

The rest of this guide writes commands as `nodrift`; use `npx nodrift` inside a project, or `npx --yes github:devjoinedthechat/nodrift` without an install. To pin a version, add a commit: `github:devjoinedthechat/nodrift#<commit>`. `npm install --global github:devjoinedthechat/nodrift` does not work, because npm cannot build a global install from git.

## Write a config

Create `nodrift.yaml`:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/devjoinedthechat/nodrift/main/nodrift.schema.json
network:
  rpc_url: '${RPC_URL}'
  chain_id: 1

contracts:
  USDC:
    address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
    preset: erc20
    state:
      - type: variable
        name: name
        value: USD Coin
      - type: variable
        name: symbol
        value: USDC
      - type: variable
        name: decimals
        value: 6
      - type: variable
        name: totalSupply
        value: 1_000_000_000_000_000 # 1 billion USDC, 6 decimals
        options:
          comparison: '>='
```

- `network` says where to read. `chain_id` is compared with the endpoint before anything is read, so a config for mainnet never runs against another chain by accident.
- `preset: erc20` supplies the ABI for the standard ERC-20 functions. See [Presets](presets.md).
- Each entry under `state` is a check. `variable` reads a function without arguments and compares the result with `value`. The last check uses an operator instead of exact equality. See [State types](state-types.md) and [Comparison options](comparison-options.md).

Expected values are converted to the type the contract returns: `6` becomes the `uint8` 6, and `1_000_000_000_000_000` an exact 256-bit integer. Mistakes such as a wrong address checksum or a value that does not fit the type are reported before anything is read.

## Provide the RPC URL

`${RPC_URL}` is read from the environment. nodrift also loads a `.env` file from the config's directory (or, if there is none, from the working directory):

```bash
# .env
RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_API_KEY
```

Variables that are already set in the environment take precedence over `.env`. The report header shows only the host of the URL, not the key in its path.

## Validate

`validate` checks the config without contacting the chain: structure, function lookups and value types.

```bash
nodrift validate nodrift.yaml
```

```text
✓ nodrift.yaml is valid: 1 contract(s), 4 check(s), chain 1
```

## Run

`verify` is the default command, so `nodrift <config>` runs it:

```bash
nodrift nodrift.yaml
```

```text
nodrift v0.1.0 · nodrift.yaml
chain 1 via eth-mainnet.g.alchemy.com · block 26192742 · multicall

USDC  0xA0b8…eB48 · chain 1
  ✓ name         USD Coin
  ✓ symbol       USDC
  ✓ decimals     6
  ✓ totalSupply  48178146094431221

4 checks: 4 passed, 0 drifted, 0 errors · 1 contract · 2763 ms
```

The header names the block that every check read. `multicall` means the calls were batched through Multicall3. Each line shows a check's key and, for passing checks, the value that was read.

## See drift

Change the expected `decimals` to `18` and run again:

```text
USDC  0xA0b8…eB48 · chain 1
  ✓ name         USD Coin
  ✓ symbol       USDC
  ✗ decimals
      actual    6
      expected  18
  ✓ totalSupply  48178146094431221

4 checks: 3 passed, 1 drifted, 0 errors · 1 contract · 2272 ms
```

`--plan` prints only what differs, in the style of a Terraform plan:

```bash
nodrift nodrift.yaml --plan
```

```text
nodrift v0.1.0 · nodrift.yaml
chain 1 via eth-mainnet.g.alchemy.com · block 26192743 · multicall

  # contract.USDC (0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48, chain 1)
  ~ decimals
      6 -> 18

Plan: 1 drifted, 0 errors, 3 in sync.
nodrift only reads state; it never sends transactions.
```

## Drift, errors and exit codes

A check ends as `pass`, `drift` (the value was read and differs), `error` (the value could not be read, for example because the call reverted) or `skipped` (a conditional check with no applicable branch).

By default drift is reported but the exit code stays `0`. Add `--fail-on-drift` to exit with `1` instead, which is what CI pipelines usually want. A check error always exits with `4`, with or without that flag, so a broken check can never look like a passing one. All exit codes are listed in [CI/CD integration](ci-cd-integration.md#exit-codes).

```bash
nodrift nodrift.yaml --fail-on-drift
```

## Create a config interactively

`nodrift init` asks for the network, the environment variable that holds the RPC URL, and one or more contracts, and writes `nodrift.yaml` (or the file name you pass). For each contract you can pick a preset, add an owner check, select getters from the ABI and enter their expected values, and add function checks.

```bash
nodrift init
```

If `ETHERSCAN_API_KEY` is set, `init` offers to fetch each contract's verified ABI through the Etherscan V2 API, which serves many chains with one key. It saves the read-only functions to `abis/<contract>.json` next to the config and references the file from the contract.

## Next steps

- [Configuration](configuration.md): networks, ABIs, templates, imports and variables.
- [State types](state-types.md): every kind of check, from owners and roles to storage slots, proxies and invariants between contracts.
- [CI/CD integration](ci-cd-integration.md): run nodrift on a schedule and after deployments, with JUnit and JSON reports.
- [Examples](../examples/README.md): configs for real mainnet contracts.
