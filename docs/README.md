# nodrift documentation

nodrift reads the state of deployed EVM contracts and compares it with a YAML config: owners, roles, proxy implementations, parameters, balances, storage slots and relations between contracts. It reports every difference and exits with a code that CI can act on.

## Guides

| Page                                        | Contents                                                                                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| [Getting started](getting-started.md)       | Install nodrift, write a first config, validate and run it, read the report.                                                  |
| [Configuration](configuration.md)           | The config file: networks, contracts, ABIs, check keys, templates, imports, variables and file references.                    |
| [State types](state-types.md)               | Every check type, with its fields, an example and the key it reports under.                                                   |
| [Comparison options](comparison-options.md) | How expected values are typed, integer forms, operators, tolerance, range, pattern and which options each check type accepts. |
| [Presets](presets.md)                       | The built-in ABIs for ERC-20, ERC-721, ERC-1155, ERC-4626, diamonds, proxies and AccessControl.                               |
| [CI/CD integration](ci-cd-integration.md)   | Command-line reference, exit codes, text, plan, JSON and JUnit reports, GitHub Actions and GitLab CI.                         |
| [Troubleshooting](troubleshooting.md)       | Error messages by exit code, with causes and fixes.                                                                           |
| [FAQ](faq.md)                               | Short answers, including security questions.                                                                                  |
| [Architecture](architecture.md)             | How a run works, the design decisions behind it, and the library API.                                                         |

## Elsewhere in the repository

- [Examples](../examples/README.md): configs for mainnet contracts such as USDC, DAI, Uniswap V2 and Chainlink feeds.
- [Metrics](../examples/METRICS.md): the optional `metric` field for classifying checks by category and severity.
- [Templates](../templates/): a starter config and CI workflows for GitHub Actions and GitLab CI.
- [nodrift.schema.json](../nodrift.schema.json): JSON Schema of the config format, for editor completion and validation.
- [Contributing](../CONTRIBUTING.md): development setup and project layout.

## Where to start

- New to nodrift: [Getting started](getting-started.md), then [State types](state-types.md).
- Adding nodrift to a pipeline: [CI/CD integration](ci-cd-integration.md) and the [templates](../templates/).
- Reviewing nodrift before relying on it: [Architecture](architecture.md) and the [FAQ](faq.md).
