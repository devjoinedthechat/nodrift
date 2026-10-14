# CI/CD integration

nodrift reads state, compares it with the config, prints a report and exits with a code that says what it found. That makes it an ordinary CI step. Typical uses:

- After a deployment or upgrade: confirm that the deployed contracts are configured as intended.
- On a schedule: notice changes made on-chain outside your release process, such as ownership transfers, role grants, upgrades or parameter changes.
- On pull requests that change the config: validate the expectations before they are merged.

- [Command-line reference](#command-line-reference)
- [Exit codes](#exit-codes)
- [Reports](#reports)
- [GitHub Actions](#github-actions)
- [GitLab CI](#gitlab-ci)
- [Other CI systems](#other-ci-systems)
- [Validating configs in pull requests](#validating-configs-in-pull-requests)
- [Practices](#practices)

## Command-line reference

```text
nodrift <config> [options]            same as nodrift verify <config>
nodrift verify <config> [options]     read on-chain state and compare it with the config
nodrift validate <config> [options]   check a config offline: schema, ABI lookups and value types
nodrift init [output]                 create a config interactively (default: nodrift.yaml)
nodrift presets                       list the built-in ABI presets
```

Options of `verify`:

| Option                  | Description                                                                                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-o, --output <format>` | `text` (default), `json` or `junit`.                                                                                                                       |
| `--junit-file <path>`   | Where `--output junit` writes its report. Default `test-results/nodrift-junit.xml`; missing directories are created.                                       |
| `--fail-on-drift`       | Exit with code 1 when a check drifted.                                                                                                                     |
| `--plan`                | Print only drifted and failed checks, in the style of a Terraform plan.                                                                                    |
| `--block <block>`       | Read at this block on every network: a block number, `latest`, `safe` or `finalized`. A block number is only accepted when the config uses a single chain. |
| `--compact-json`        | Print the JSON report on a single line.                                                                                                                    |
| `-q, --quiet`           | Print only drifted and failed checks, and the summary line.                                                                                                |
| `-v, --verbose`         | Log RPC activity to stderr: the pinned block, Multicall3 detection, retries.                                                                               |
| `--no-env-file`         | Do not load a `.env` file.                                                                                                                                 |

`validate` accepts `--no-env-file` and `-v, --verbose` (stack traces for unexpected errors). `nodrift --version` prints the version.

With `--output json`, stdout contains only the JSON report. With `--output junit`, the text report is printed as usual and the JUnit file is written in addition; `--plan` and `--quiet` change that text report. Logs and error messages always go to stderr.

## Exit codes

| Code | Meaning                                                                                                                                                                                                                                                                                                                 |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Every check passed, or drift was found without `--fail-on-drift`. Skipped checks do not change the code.                                                                                                                                                                                                                |
| `1`  | Drift was found and `--fail-on-drift` is set.                                                                                                                                                                                                                                                                           |
| `2`  | Invalid command-line arguments (the usage is printed), or the config could not be loaded: a missing file or environment variable, invalid YAML, an unsupported `${...}` form, a file reference outside the project, an unknown template, an import cycle, or a `--block` number with a config that uses several chains. |
| `3`  | An RPC endpoint was unreachable, reported a different chain id than the config, or could not provide the requested block.                                                                                                                                                                                               |
| `4`  | At least one check could not be evaluated (status `error`). This takes precedence over drift and does not depend on `--fail-on-drift`.                                                                                                                                                                                  |
| `5`  | The config is invalid: unknown keys, wrong types, address checksums, functions that are not in the ABI, values that do not fit their type.                                                                                                                                                                              |
| `6`  | Unexpected internal error. Run again with `--verbose` for the stack trace.                                                                                                                                                                                                                                              |

Reports, including the JUnit file, are written only when the checks ran: exit code `0`, `4`, or `1` because of drift. With `2`, `3` and `5` the run stops before any check is evaluated, and only an error message is printed to stderr.

## Reports

The examples below come from this config. It is deliberately not clean: the USDC supply is above the configured ceiling, USDC is not paused, and WETH has no `owner()` function.

```yaml
network:
  rpc_url: '${RPC_URL}'
  chain_id: 1

contracts:
  USDC:
    address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
    preset: erc20
    abi:
      - 'function paused() view returns (bool)'
      - 'function pauser() view returns (address)'
    state:
      - type: variable
        name: symbol
        value: USDC
      - type: variable
        id: supply
        name: totalSupply
        options:
          range: { max: '40_000_000_000e6' } # at most 40 billion USDC
          description: supply ceiling
        metric: { name: usdc_supply, category: supply, severity: high }
      - type: conditional
        condition: { name: paused, value: true }
        then:
          - type: variable
            name: pauser
            value: '0x19C3C182A18DE1681C666237A91c875c58A56260'

  ETH_USD:
    address: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419'
    abi:
      - 'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)'
    state:
      - type: time_based
        function: latestRoundData
        field: updatedAt
        max_age_seconds: 3600

  WETH:
    address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
    state:
      - type: owner
        value: '0x85c94597Fb2efeaf0196F42F7b9e4d3B9AE899ED'
```

### Text

The default report lists every check: `✓` pass, `✗` drift, `!` error, `-` skipped. Passing checks show the value that was read; the others show details. A check's `description` appears in parentheses, and its `metric` as `[SEVERITY] name` when the check did not pass.

```text
nodrift v0.1.0 · nodrift.yaml
chain 1 via eth-mainnet.g.alchemy.com · block 26192749 · multicall

USDC  0xA0b8…eB48 · chain 1
  ✓ symbol             USDC
  ✗ supply             (supply ceiling) [HIGH] usdc_supply
      actual    48178135090342286
      expected  in [-inf, 40000000000000000]
  - if paused == true
      condition is false; no else branch

ETH_USD  0x5f4e…8419 · chain 1
  ✓ latestRoundData().updatedAt age  1764

WETH  0xC02a…6Cc2 · chain 1
  ! owner()
      WETH.owner() returned no data; does 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 implement owner()?

5 checks: 2 passed, 1 drifted, 1 error, 1 skipped · 3 contracts · 4053 ms
```

This run exits with `4` because of the error, with or without `--fail-on-drift`. `--quiet` drops the header, passing and skipped checks, and keeps the summary line. Colors are used only when stdout is a terminal; `NO_COLOR=1` turns them off and `FORCE_COLOR=1` turns them on.

### Plan

`--plan` shows only what differs from the config: `~` for drift with the actual and expected value, `+` and `-` for missing and unexpected members of a set, `!` for errors.

```text
nodrift v0.1.0 · nodrift.yaml
chain 1 via eth-mainnet.g.alchemy.com · block 26192750 · multicall

  # contract.USDC (0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48, chain 1)
  ~ supply [HIGH] usdc_supply
      48178135090342286 -> in [-inf, 40000000000000000]

  # contract.WETH (0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2, chain 1)
  ! owner()
      WETH.owner() returned no data; does 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 implement owner()?

Plan: 1 drifted, 1 error, 2 in sync, 1 skipped.
nodrift only reads state; it never sends transactions.
```

### JSON

`--output json` prints one JSON document, indented with two spaces (`--compact-json` prints it on one line; below, small objects are condensed onto one line). Integers are written as decimal strings, so no consumer loses precision on 256-bit values.

```json
{
  "version": "0.1.0",
  "file": "nodrift.yaml",
  "startedAt": "2026-10-14T19:11:29.484Z",
  "durationMs": 3805,
  "status": "error",
  "networks": [
    {
      "chainId": 1,
      "host": "eth-mainnet.g.alchemy.com",
      "block": 26192750,
      "blockHash": "0xb0eb1495d4e81d036d59fa24d851d03f5b0c945ab164e0c32237bc9330535b32",
      "blockTimestamp": 1792005083,
      "multicall": true,
      "requests": 11
    }
  ],
  "contracts": [
    { "name": "USDC", "address": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "chainId": 1 },
    { "name": "ETH_USD", "address": "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419", "chainId": 1 },
    { "name": "WETH", "address": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", "chainId": 1 }
  ],
  "results": [
    {
      "contract": "USDC",
      "address": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      "chainId": 1,
      "key": "symbol",
      "type": "variable",
      "status": "pass",
      "actual": "USDC",
      "expected": "USDC"
    },
    {
      "contract": "USDC",
      "address": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      "chainId": 1,
      "key": "supply",
      "type": "variable",
      "description": "supply ceiling",
      "metric": { "name": "usdc_supply", "category": "supply", "severity": "high" },
      "status": "drift",
      "actual": "48178135090342286",
      "expected": "in [-inf, 40000000000000000]"
    },
    {
      "contract": "USDC",
      "address": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      "chainId": 1,
      "key": "if paused == true",
      "type": "conditional",
      "status": "skipped",
      "actual": false,
      "message": "condition is false; no else branch"
    },
    {
      "contract": "ETH_USD",
      "address": "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
      "chainId": 1,
      "key": "latestRoundData().updatedAt age",
      "type": "time_based",
      "status": "pass",
      "actual": "1776",
      "expected": "age <= 3600s",
      "message": "updated at 1792003307, block time 1792005083"
    },
    {
      "contract": "WETH",
      "address": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      "chainId": 1,
      "key": "owner()",
      "type": "owner",
      "status": "error",
      "message": "WETH.owner() returned no data; does 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 implement owner()?"
    }
  ],
  "summary": { "contracts": 3, "checks": 5, "passed": 2, "drifted": 1, "errors": 1, "skipped": 1 }
}
```

| Field        | Description                                                                                                                                                                                                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`     | `pass`, `drift` or `error` for the whole run. `error` if any check errored, else `drift` if any drifted.                                                                                                                                                                                                            |
| `file`       | The config path, relative to the working directory, or the file name for configs outside it.                                                                                                                                                                                                                        |
| `networks[]` | One entry per connection: the chain id, the RPC host (never the full URL), the pinned block with its hash and timestamp, whether Multicall3 was used, and the number of RPC requests sent.                                                                                                                          |
| `results[]`  | One entry per check result. `status` is `pass`, `drift`, `error` or `skipped`. `actual` is the value read, `expected` the rendered expectation, `message` an explanation for errors, skips and some drifts. Set checks add `missing` and `unexpected` lists. `description` and `metric` are copied from the config. |
| `summary`    | Counts of contracts, results and each status.                                                                                                                                                                                                                                                                       |

For example, to list every drifted check with a critical metric:

```bash
nodrift nodrift.yaml --output json \
  | jq -r '.results[] | select(.status == "drift" and .metric.severity == "critical") | "\(.contract).\(.key)"'
```

### JUnit

`--output junit` writes a JUnit XML file that CI systems display as test results: one test suite per contract, one test case per check. Drift is a `failure`, an error is an `error`, and a skipped check is `skipped`. Each suite records the contract address, the chain id and the pinned block as properties.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="nodrift" tests="5" failures="1" errors="1" skipped="1" time="3.113">
  <testsuite name="USDC" tests="3" failures="1" errors="0" skipped="1" time="0" timestamp="2026-10-14T19:11:33.408Z">
    <properties>
      <property name="address" value="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"/>
      <property name="chain_id" value="1"/>
      <property name="block" value="26192750"/>
    </properties>
    <testcase classname="nodrift.USDC" name="symbol" time="0"></testcase>
    <testcase classname="nodrift.USDC" name="supply" time="0">
      <failure type="drift" message="expected in [-inf, 40000000000000000], got 48178135090342286">USDC.supply (variable) at 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48, chain 1
actual:   48178135090342286
expected: in [-inf, 40000000000000000]
metric: usdc_supply (high, supply)</failure>
    </testcase>
    <testcase classname="nodrift.USDC" name="if paused == true" time="0">
      <skipped message="condition is false; no else branch"/>
    </testcase>
  </testsuite>
  <!-- ETH_USD and WETH suites omitted -->
</testsuites>
```

Test case names are the check keys. Give checks an `id` when you want test names, and therefore test history, to stay stable while arguments change.

## GitHub Actions

[`templates/github-actions.yml.template`](../templates/github-actions.yml.template) contains this workflow. Copy it to `.github/workflows/nodrift.yml` and add the RPC URL as a repository secret named `RPC_URL`.

```yaml
name: nodrift

on:
  push:
    branches: [main]
  pull_request:
  schedule:
    - cron: '0 */6 * * *'
  workflow_dispatch:

permissions:
  contents: read

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7

      - uses: actions/setup-node@v7
        with:
          node-version: 22

      # Pin a commit for reproducible runs: github:devjoinedthechat/nodrift#<commit>
      - name: Check on-chain state
        run: npx --yes github:devjoinedthechat/nodrift nodrift.yaml --fail-on-drift --output junit --junit-file test-results/nodrift.xml
        env:
          RPC_URL: ${{ secrets.RPC_URL }}

      - name: Upload JUnit report
        if: always()
        uses: actions/upload-artifact@v7
        with:
          name: nodrift-report
          path: test-results/nodrift.xml
```

- `if: always()` uploads the report when the check step failed because of drift or check errors. When the run stopped early (exit code 2, 3 or 5) there is no report, and the upload step warns that no file was found.
- Workflows triggered by pull requests from forks do not receive repository secrets, so `RPC_URL` is empty there and nodrift exits with code 2. Validate such pull requests offline instead (see [below](#validating-configs-in-pull-requests)).
- Scheduled workflows run on the default branch. GitHub may delay scheduled runs, and disables them in public repositories without recent activity.
- To show results in the pull request UI, point a JUnit reporting action of your choice at `test-results/nodrift.xml`.

## GitLab CI

[`templates/gitlab-ci.yml.template`](../templates/gitlab-ci.yml.template) contains this job. Add `RPC_URL` as a masked CI/CD variable (Settings > CI/CD > Variables); GitLab exposes it to the job as an environment variable.

```yaml
nodrift:
  image: node:22
  stage: test
  script:
    - npx --yes github:devjoinedthechat/nodrift nodrift.yaml --fail-on-drift --output junit --junit-file test-results/nodrift.xml
  artifacts:
    when: always
    paths:
      - test-results/nodrift.xml
    reports:
      junit: test-results/nodrift.xml
```

GitLab shows the JUnit results in merge requests and on the pipeline's Tests tab. For periodic drift detection, add a pipeline schedule (Build > Pipeline schedules).

## Other CI systems

Any runner with Node.js 22.13 or newer works:

```bash
npx --yes github:devjoinedthechat/nodrift nodrift.yaml --fail-on-drift --output junit --junit-file test-results/nodrift.xml
```

Point the system's JUnit test report step at `test-results/nodrift.xml`, and keep it running when the command fails (the equivalent of `if: always()`). Use `--output json` when another program consumes the result.

## Validating configs in pull requests

`nodrift validate` checks a config without contacting the chain: structure, function lookups and value types. It still resolves variables, so they need values of the right shape, but not real ones:

```bash
RPC_URL=https://rpc.invalid npx --yes github:devjoinedthechat/nodrift validate nodrift.yaml --no-env-file
```

`rpc_url` must look like an HTTP(S) URL, and variables used as addresses need a valid address, for example `0x0000000000000000000000000000000000000000`. `validate` exits with `0` when the config is valid, `2` when it cannot be loaded and `5` when it is invalid.

## Practices

- Use `--fail-on-drift` in CI. Without it, drift is reported but the job succeeds.
- Keep the RPC URL in a secret. Reports, logs and error messages show only its host.
- For scheduled monitoring on chains with finality, `block: finalized` (or `--block finalized`) reads state that can no longer be reorganized.
- A report names the block it read. To reproduce it, run the same config with `--block <number>`. Reading older state requires an endpoint that serves historical state (an archive node).
- `npx --yes github:devjoinedthechat/nodrift` runs the latest commit on `main`. Pin a commit (`github:devjoinedthechat/nodrift#<commit>`) to make upgrades explicit.
- In CI, `--no-env-file` makes sure that a stray `.env` file in the repository is not loaded. Variables set by the CI system take precedence over `.env` in any case.
