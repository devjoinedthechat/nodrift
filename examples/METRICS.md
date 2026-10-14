# Metrics

`metric` is an optional field of every check. It classifies the check by category and severity, so that reports and the tools that read them can rank drift by importance. A metric does not change how the check is evaluated, its status, or the exit code: a `critical` drift and a `low` drift are both drift.

## Fields

| Field         | Required | Values                                                                  |
| ------------- | -------- | ----------------------------------------------------------------------- |
| `name`        | yes      | Your identifier for the metric, such as `usdc_supply`.                  |
| `category`    | yes      | `integrity`, `solvency`, `liquidity`, `risk`, `supply` or `governance`. |
| `severity`    | yes      | `critical`, `high`, `medium` or `low`.                                  |
| `description` | no       | Free text. It is included in the JSON report.                           |

Other values or extra fields are validation errors.

```yaml
- type: owner
  value: '0xA8bACE4F426772483D2b4E6350Fd948b58E06cA8'
  metric:
    name: token_owner
    category: integrity
    severity: critical
    description: The token must be owned by the timelock

- type: function_call
  function: balanceOf
  args: ['0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc']
  value: '1000000e6'
  options:
    comparison: '>'
  metric:
    name: pool_usdc_reserves
    category: liquidity
    severity: high
```

## Categories and severities

nodrift does not interpret categories; they are labels for grouping. A common reading:

| Category     | Typical checks                                                                                        |
| ------------ | ----------------------------------------------------------------------------------------------------- |
| `integrity`  | The contract is the one you expect: owners, admins, proxy implementations, token addresses of a pool. |
| `solvency`   | Assets cover liabilities: reserves, collateral, balances that back a supply.                          |
| `liquidity`  | Enough funds are available: pool balances, vault limits.                                              |
| `risk`       | Exposure and concentration limits.                                                                    |
| `supply`     | Token supply and minting.                                                                             |
| `governance` | Parameters and permissions controlled by governance: roles, fees, timelock delays, thresholds.        |

Severities only affect how a result is displayed. Reserve `critical` for drift that needs action right away, such as an unexpected owner or implementation, and use `low` for informational checks.

## How metrics appear in reports

| Report | What is shown                                                                                                 |
| ------ | ------------------------------------------------------------------------------------------------------------- |
| Text   | `[SEVERITY] name` after the key of every check that did not pass. The severity is colored when colors are on. |
| Plan   | `[SEVERITY] name` after the key of every drifted check.                                                       |
| JSON   | The `metric` object, with all its fields, on every result of the check, whatever its status.                  |
| JUnit  | The text of a failure or error ends with `metric: name (severity, category)`.                                 |

A text report line looks like this:

```text
  ✗ supply             (supply ceiling) [HIGH] usdc_supply
      actual    48178135090342286
      expected  in [-inf, 40000000000000000]
```

A check that expands into several results, such as `proxy`, `array_state` or `mapping_state`, attaches its metric to each of them. On a `conditional`, the metric belongs to the conditional's own result, which appears only when no branch applies or the condition cannot be read; give the checks inside the branches their own metrics.

## Acting on severity

The exit code does not depend on metrics, but the JSON report makes them easy to filter. This script fails a CI job on critical drift only, while check errors and configuration problems still fail it through the exit code:

```bash
code=0
nodrift nodrift.yaml --output json > report.json || code=$?
if [ "$code" -ne 0 ]; then exit "$code"; fi
jq -e '[.results[] | select(.status == "drift" and .metric.severity == "critical")] | length == 0' report.json
```

Without `--fail-on-drift`, drift alone exits with `0`, so a non-zero `code` means errors. `jq -e` exits with `1` when the expression is false, that is when critical drift exists.

To count drifted checks per severity:

```bash
jq -r '[.results[] | select(.status == "drift") | .metric.severity // "none"] | group_by(.) | map("\(.[0]): \(length)") | .[]' report.json
```

[`risk-management/04-comprehensive-metrics.yaml`](risk-management/04-comprehensive-metrics.yaml) puts a metric on every check, and [`stablecoins/02-usdc-distribution.yaml`](stablecoins/02-usdc-distribution.yaml) on selected ones.
