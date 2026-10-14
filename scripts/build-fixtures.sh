#!/usr/bin/env bash
# Compile the e2e test contracts and write their ABIs and bytecode to tests/fixtures/artifacts.json.
# Requires Foundry (forge). The output is committed so the test suite itself only needs anvil.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
fixtures="$root/tests/fixtures"

forge build --root "$fixtures" --contracts contracts --out out --cache-path cache --use 0.8.30 --optimize --silent

node - "$fixtures" <<'EOF'
const fs = require('node:fs');
const path = require('node:path');
const dir = process.argv[2];
const artifacts = {};
for (const name of ['Fixture', 'Legacy', 'Multicall3']) {
  const json = JSON.parse(fs.readFileSync(path.join(dir, 'out', 'Fixture.sol', `${name}.json`), 'utf8'));
  artifacts[name] = { abi: json.abi, bytecode: json.bytecode.object, deployedBytecode: json.deployedBytecode.object };
}
fs.writeFileSync(path.join(dir, 'artifacts.json'), `${JSON.stringify(artifacts, null, 2)}\n`);
console.log(`wrote ${path.join(dir, 'artifacts.json')}`);
EOF
