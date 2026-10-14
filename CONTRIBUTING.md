# Contributing to nodrift

Thanks for helping. Bug reports, docs fixes and pull requests are all welcome.

## Setup

You need Node.js 22.13 or newer and [Foundry](https://getfoundry.sh) (the end-to-end tests run against a local `anvil` chain).

```bash
git clone https://github.com/devjoinedthechat/nodrift.git
cd nodrift
npm ci
npm test
```

Run the CLI from source with `npm run dev -- <args>`, for example `npm run dev -- validate examples/basic/01-erc20-token.yaml`.

## Checks

Every pull request must pass these, which is what CI runs:

| Command                | What it does                                  |
| ---------------------- | --------------------------------------------- |
| `npm run lint`         | ESLint                                        |
| `npm run format:check` | Prettier (`npm run format` fixes it)          |
| `npm run typecheck`    | TypeScript, strict mode                       |
| `npm test`             | Unit tests and end-to-end tests against anvil |

The end-to-end tests are skipped locally when `anvil` is not installed, and required in CI.

## Project layout

```text
src/config/   load YAML, substitute variables, merge imports/templates/presets, validate, normalize to checks
src/chain/    RPC client: chain id check, block pinning, retries, Multicall3 batching
src/check/    typed values, exact comparison, check evaluation
src/output/   text, plan, JSON and JUnit reports
src/cli.ts    command-line interface
tests/unit/   fast tests, no chain needed
tests/e2e/    tests against anvil with the contracts in tests/fixtures
```

## Making changes

- Keep pull requests focused. Open an issue first for larger changes or new check types.
- Add or update tests. Bug fixes should come with a test that fails without the fix.
- Configs are untrusted input: never add features that execute code or read files outside the project.
- Never report a check as passing when it could not be evaluated.
- If you change `src/config/schema.ts`, run `npm run schema` and commit the regenerated `nodrift.schema.json`.
- If you change the fixture contracts, run `npm run fixtures` (needs `forge`) and commit `tests/fixtures/artifacts.json`.
- Update the docs and `CHANGELOG.md` for user-facing changes.

## Releases

Maintainers release by bumping the version in `package.json` and `src/version.ts`, updating `CHANGELOG.md`, and pushing a `vX.Y.Z` tag. The release workflow runs the tests and creates the GitHub release. It also publishes to npm once an `NPM_TOKEN` repository secret is configured; until then, nodrift is installed from GitHub.
