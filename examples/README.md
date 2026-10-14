# Examples

Configs for contracts on Ethereum mainnet: tokens, Uniswap V2, Chainlink price feeds, stablecoin distribution and treasury holdings. Each file is a complete config that reads the RPC endpoint from `RPC_URL`.

## Running an example

```bash
RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_API_KEY nodrift examples/basic/01-erc20-token.yaml
```

This needs nodrift installed (see [Install](../README.md#install)). In a clone of the repository, `npm ci` builds the CLI and `npx nodrift` runs that build. `RPC_URL` can also come from a `.env` file in the working directory (see [`.env.example`](../.env.example)).

To check an example without contacting the chain, validate it:

```bash
RPC_URL=https://rpc.invalid nodrift validate examples/basic/01-erc20-token.yaml
```

## Expected values are snapshots

The expected values match Ethereum mainnet as of October 2026. Balances, supplies, reserves, fee settings and treasury holdings change, so checks will start to drift over time. [`basic/05-drift-demo.yaml`](basic/05-drift-demo.yaml) contains one deliberately stale value, which makes it a quick way to see drift in each report format:

```bash
nodrift examples/basic/05-drift-demo.yaml
nodrift examples/basic/05-drift-demo.yaml --plan
nodrift examples/basic/05-drift-demo.yaml --output json
```

None of these commands use `--fail-on-drift`, so drift is reported and the exit code stays `0`.

## The examples

### basic/

| File                                                               | Contracts | Shows                                                                                       |
| ------------------------------------------------------------------ | --------- | ------------------------------------------------------------------------------------------- |
| [`01-erc20-token.yaml`](basic/01-erc20-token.yaml)                 | USDC      | `name`, `symbol` and `decimals` through an inline JSON ABI.                                 |
| [`02-stablecoin.yaml`](basic/02-stablecoin.yaml)                   | DAI       | The same checks for a token with 18 decimals.                                               |
| [`03-erc20-with-balances.yaml`](basic/03-erc20-with-balances.yaml) | USDC      | A relative `tolerance` on the total supply and an upper bound (`<=`) on a router's balance. |
| [`04-erc20-with-preset.yaml`](basic/04-erc20-with-preset.yaml)     | USDC, DAI | The same kind of checks with an inline ABI and with `preset: erc20`.                        |
| [`05-drift-demo.yaml`](basic/05-drift-demo.yaml)                   | USDC      | Owner, minter configuration and pause state, plus one stale value that drifts on purpose.   |

### defi/

| File                                                                              | Contracts                            | Shows                                                                                                                                                                                 |
| --------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`01-dex-factory.yaml`](defi/01-dex-factory.yaml)                                 | Uniswap V2 factory                   | The fee settings `feeTo` and `feeToSetter`.                                                                                                                                           |
| [`02-uniswap-v2-pair.yaml`](defi/02-uniswap-v2-pair.yaml)                         | USDC/WETH pair                       | The pair's tokens and factory, and a minimum LP token supply.                                                                                                                         |
| [`03-uniswap-v2-ecosystem.yaml`](defi/03-uniswap-v2-ecosystem.yaml)               | Router, factory, pair                | Related contracts that point to each other, and `getPair` with two arguments.                                                                                                         |
| [`04-multi-pool-comparison.yaml`](defi/04-multi-pool-comparison.yaml)             | Three pairs, USDC, WETH              | Minimum liquidity and token balances across pools.                                                                                                                                    |
| [`05-oracle-freshness-check.yaml`](defi/05-oracle-freshness-check.yaml)           | Your own contracts                   | `time_based` freshness checks with human-readable ABI entries. Set `PRICE_FEED_ADDRESS`, `DATA_FEED_ADDRESS` and `TIMELOCK_ADDRESS` to contracts that implement the listed functions. |
| [`06-chainlink-oracle-monitoring.yaml`](defi/06-chainlink-oracle-monitoring.yaml) | Chainlink ETH/USD, BTC/USD, USDC/USD | Feed freshness with `time_based`, positive answers, a tolerance around $1, and `description` texts.                                                                                   |

### governance/

| File                                                | Contracts | Shows                                                                           |
| --------------------------------------------------- | --------- | ------------------------------------------------------------------------------- |
| [`01-uni-token.yaml`](governance/01-uni-token.yaml) | UNI       | Token metadata, the fixed total supply and a threshold on the treasury balance. |

### stablecoins/

| File                                                                         | Contracts | Shows                                                                                                            |
| ---------------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------- |
| [`01-dai-supply-monitoring.yaml`](stablecoins/01-dai-supply-monitoring.yaml) | DAI       | Total supply with a tolerance, and DAI held by the PSM, Uniswap V3 and Curve.                                    |
| [`02-usdc-distribution.yaml`](stablecoins/02-usdc-distribution.yaml)         | USDC      | USDC held by lending and DEX protocols, a concentration limit for an exchange wallet, and [metrics](METRICS.md). |

### risk-management/

| File                                                                                 | Contracts                       | Shows                                                                                                        |
| ------------------------------------------------------------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [`01-treasury-allocation.yaml`](risk-management/01-treasury-allocation.yaml)         | UNI, USDC, WETH, DAI            | A treasury's holdings across tokens. Two checks read the same balance, so the second key gets a `#2` suffix. |
| [`02-liquidity-pool-health.yaml`](risk-management/02-liquidity-pool-health.yaml)     | USDC/WETH pair, USDC, WETH, DAI | Pool tokens, reserves and thresholds, with metrics.                                                          |
| [`03-protocol-solvency-check.yaml`](risk-management/03-protocol-solvency-check.yaml) | Pair, USDC, WETH, factory       | The pair's token balances and its registration in the factory.                                               |
| [`04-comprehensive-metrics.yaml`](risk-management/04-comprehensive-metrics.yaml)     | USDC, WETH, pair, factory       | A metric on every check, across categories and severities.                                                   |

## Notes

- The examples read values with `function_call`. For functions without arguments, `type: variable` with `name:` is a shorter form, and `preset: erc20` replaces the inline ERC-20 ABI entries.
- For a starting point of your own, copy [`templates/nodrift-config.yaml.template`](../templates/nodrift-config.yaml.template). The [documentation](../docs/README.md) describes every check type and option.
