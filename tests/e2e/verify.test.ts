import * as fs from 'node:fs';
import * as path from 'node:path';
import { ConnectionError } from '../../src/common/errors';
import { ExitCode, exitCodeForResult } from '../../src/common/exit-codes';
import { loadConfig } from '../../src/config/load';
import { verify, type VerificationResult, type VerifyOptions } from '../../src/verify';
import { BEEF, DEAD, HAS_ANVIL, IMPLEMENTATION, OWNER, startChain, tempDir, type Chain } from './anvil';

if (!HAS_ANVIL && process.env.CI) throw new Error('anvil (Foundry) is required for the e2e suite in CI');
const suite = HAS_ANVIL ? describe : describe.skip;

const MINTER_A = '0x2222222222222222222222222222222222222222';
const MINTER_B = '0x3333333333333333333333333333333333333333';
const NOBODY = '0x1234567890123456789012345678901234567890';
const SUPPLY = '1000000000000000001000000'; // 1e24 + 1e6

function dedent(text: string): string {
  const lines = text.replace(/^\n/, '').replace(/\s+$/, '').split('\n');
  const margin = Math.min(...lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)![0].length));
  return lines.map((l) => l.slice(margin)).join('\n');
}

function indent(text: string, spaces: number): string {
  return dedent(text)
    .split('\n')
    .map((line) => (line ? ' '.repeat(spaces) + line : line))
    .join('\n');
}

suite('verify against a local chain', () => {
  let chain: Chain;
  const tmp = tempDir();
  let count = 0;

  beforeAll(async () => {
    chain = await startChain();
    const artifacts = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/artifacts.json'), 'utf8'));
    tmp.write('Fixture.abi.json', JSON.stringify(artifacts.Fixture.abi));
  }, 60_000);

  afterAll(async () => {
    await chain?.stop();
    tmp.cleanup();
  });

  const fixture = (state: string, name = 'Fixture') =>
    `  ${name}:\n    address: "${chain.fixtureAddress}"\n    abi: ./Fixture.abi.json\n    state:\n${indent(state, 6)}\n`;

  function writeConfig(contracts: string, networkExtra = ''): string {
    const network = `network:\n  rpc_url: ${chain.url}\n  chain_id: 31337\n${networkExtra ? indent(networkExtra, 2) + '\n' : ''}`;
    return tmp.write(`config-${count++}.yaml`, `${network}contracts:\n${contracts}`);
  }

  async function run(
    contracts: string,
    options: VerifyOptions & { env?: NodeJS.ProcessEnv; network?: string } = {},
  ): Promise<VerificationResult> {
    const file = writeConfig(contracts, options.network);
    return verify(loadConfig(file, { env: options.env ?? {} }), options);
  }

  const status = (result: VerificationResult) =>
    Object.fromEntries(result.results.map((r) => [`${r.contract}.${r.key}`, r.status]));
  const find = (result: VerificationResult, key: string) => {
    const found = result.results.find((r) => r.key === key);
    if (!found) throw new Error(`no result ${key}; have ${result.results.map((r) => r.key).join(', ')}`);
    return found;
  };

  const EVERYTHING = `
    - type: owner
      value: "${OWNER}"
    - type: variable
      name: totalSupply
      value: "${SUPPLY}"
    - type: variable
      name: symbol
      value: FIX
    - type: function_call
      function: balanceOf
      args: ["${DEAD}"]
      value: 100
    - type: function_call
      function: balanceOf
      args: ["${BEEF}"]
      value: 200
    - type: role
      role: MINTER_ROLE
      account: "${MINTER_A}"
    - type: role
      role: MINTER_ROLE
      account: "${NOBODY}"
      value: false
    - type: role
      role: MINTER_ROLE
      members: ["${MINTER_B}", "${MINTER_A}"]
    - type: role
      role: DEFAULT_ADMIN_ROLE
      account: "${OWNER}"
    - type: proxy
      checks:
        implementation: "${IMPLEMENTATION}"
    - type: storage_slot
      slot: 1
      value: "${SUPPLY}"
    - type: storage_slot
      slot: 0
      value: "${OWNER}"
      options: { decode_as: address, offset: 0, size: 20 }
    - type: storage_slot
      slot: 0
      value: 1
      options: { offset: 20, size: 12 }
    - type: array_state
      function: members
      checks:
        length: 2
        contains: ["${BEEF}"]
        not_contains: ["${NOBODY}"]
        exact: ["${BEEF}", "${DEAD}"]
      options: { ignore_order: true }
    - type: mapping_state
      function: allowance
      keys:
        - key: ["${DEAD}", "${BEEF}"]
          value: 5
    - type: aggregate
      operation: sum
      sources:
        - { function: balanceOf, args: ["${DEAD}"] }
        - { function: balanceOf, args: ["${BEEF}"] }
      value: 300
    - type: comparison
      left: { function: balanceOf, args: ["${BEEF}"] }
      operator: ">"
      right: { function: balanceOf, args: ["${DEAD}"] }
    - type: time_based
      function: latestRoundData
      field: updatedAt
      max_age_seconds: 3600
    - type: function_call
      function: latestRoundData
      field: answer
      value: 0
      options: { comparison: ">" }
    - type: conditional
      condition: { name: paused, value: false }
      then:
        - type: variable
          name: flags
          value: 1
  `;

  it('passes every check type when state matches', async () => {
    const result = await run(fixture(EVERYTHING));
    expect(result.results.filter((r) => r.status !== 'pass')).toEqual([]);
    expect(result.summary).toMatchObject({ contracts: 1, drifted: 0, errors: 0, skipped: 0 });
    expect(result.summary.checks).toBe(23);
    expect(result.networks[0]).toMatchObject({ chainId: 31337, multicall: true });
    expect(exitCodeForResult(result, true)).toBe(ExitCode.SUCCESS);
  });

  it('gives identical results with and without multicall, in fewer requests', async () => {
    const batched = await run(fixture(EVERYTHING));
    const direct = await run(fixture(EVERYTHING), { network: 'multicall: false' });
    expect(direct.networks[0].multicall).toBe(false);
    expect(status(direct)).toEqual(status(batched));
    expect(batched.networks[0].requests).toBeLessThan(direct.networks[0].requests);
  });

  it('evaluates repeated calls to the same function separately', async () => {
    const result = await run(
      fixture(`
        - { type: function_call, function: balanceOf, args: ["${DEAD}"], value: 999999 }
        - { type: function_call, function: balanceOf, args: ["${BEEF}"], value: 200 }
        - { type: function_call, function: balanceOf, args: ["${BEEF}"], value: 201 }
      `),
    );
    expect(result.results.map((r) => [r.key, r.status])).toEqual([
      [`balanceOf(${DEAD})`, 'drift'],
      [`balanceOf(${BEEF})`, 'pass'],
      [`balanceOf(${BEEF}) #2`, 'drift'],
    ]);
  });

  it('compares large integers exactly', async () => {
    const result = await run(
      fixture(`
        - { id: unquoted-yaml-number, type: variable, name: totalSupply, value: 1000000000000000000000000 }
        - { id: relative-tolerance, type: variable, name: totalSupply, value: "1000000 ether", options: { tolerance: "0.0001%" } }
        - { id: absolute-too-tight, type: variable, name: totalSupply, value: "1e24", options: { tolerance: "999999" } }
        - { id: absolute-enough, type: variable, name: totalSupply, value: "1e24", options: { tolerance: 1000000 } }
        - { id: from-env, type: variable, name: totalSupply, value: "\${SUPPLY}" }
      `),
      { env: { SUPPLY } },
    );
    expect(status(result)).toEqual({
      'Fixture.unquoted-yaml-number': 'drift',
      'Fixture.relative-tolerance': 'pass',
      'Fixture.absolute-too-tight': 'drift',
      'Fixture.absolute-enough': 'pass',
      'Fixture.from-env': 'pass',
    });
    expect(find(result, 'unquoted-yaml-number').actual).toBe(BigInt(SUPPLY));
  });

  it('does not treat a packed storage slot as an address', async () => {
    const full = `0x${'00'.repeat(11)}01${OWNER.slice(2).toLowerCase()}`;
    const result = await run(
      fixture(`
        - { id: as-address, type: storage_slot, slot: 0, value: "${OWNER}" }
        - { id: full-word, type: storage_slot, slot: "0x0", value: "${full}" }
      `),
    );
    const asAddress = find(result, 'as-address');
    expect(asAddress.status).toBe('drift');
    expect(asAddress.message).toMatch(/upper 12 bytes are non-zero/);
    expect(find(result, 'full-word').status).toBe('pass');
  });

  it('pins every read to one block and detects later changes', async () => {
    const snapshot = await chain.snapshot();
    try {
      const before = await chain.provider.getBlockNumber();
      await chain.send('setFlags', 999);
      await chain.send('setBalance', DEAD, 1);
      const config = fixture(`
        - { type: variable, name: flags, value: 1 }
        - { type: function_call, function: balanceOf, args: ["${DEAD}"], value: 100 }
      `);
      const latest = await run(config);
      expect(latest.results.map((r) => r.status)).toEqual(['drift', 'drift']);
      expect(find(latest, 'flags').actual).toBe(999n);

      const pinned = await run(config, { block: before });
      expect(pinned.networks[0].block).toBe(before);
      expect(pinned.results.map((r) => r.status)).toEqual(['pass', 'pass']);
    } finally {
      await chain.revert(snapshot);
    }
  });

  it('reports role membership differences', async () => {
    const result = await run(
      fixture(`
        - type: role
          role: MINTER_ROLE
          members: ["${MINTER_A}", "0x5555555555555555555555555555555555555555"]
      `),
    );
    const [members] = result.results;
    expect(members.status).toBe('drift');
    expect(members.missing).toEqual(['0x5555555555555555555555555555555555555555']);
    expect(members.unexpected).toEqual([MINTER_B]);
  });

  it('falls back to getOwner() and explains non-enumerable roles', async () => {
    const legacy = `  Legacy:\n    address: "${chain.legacyAddress}"\n    state:\n${indent(
      `
        - { type: owner, value: "${OWNER}" }
        - { type: role, role: MINTER_ROLE, account: "${MINTER_A}", value: false }
        - { type: role, role: MINTER_ROLE, members: ["${MINTER_A}"] }
      `,
      6,
    )}\n`;
    const result = await run(legacy);
    expect(result.results.map((r) => r.status)).toEqual(['pass', 'pass', 'error']);
    expect(result.results[2].message).toMatch(/AccessControlEnumerable/);
  });

  it('turns reverts and missing code into errors, never into a pass', async () => {
    const ghost = `  Ghost:\n    address: "0x000000000000000000000000000000000000c0DE"\n    state:\n${indent(
      `
        - { type: function_call, function: "totalSupply() returns (uint256)", value: 1 }
      `,
      6,
    )}\n`;
    const result = await run(
      fixture(`
        - { type: function_call, function: guarded, value: 0 }
        - { type: function_call, function: failing, value: 0 }
      `) + ghost,
    );
    expect(result.results.map((r) => r.status)).toEqual(['error', 'error', 'error']);
    expect(result.results[0].message).toMatch(/NotAllowed\(/);
    expect(result.results[1].message).toMatch(/reverted: always fails/);
    expect(result.results[2].message).toMatch(/no contract code at 0x000000000000000000000000000000000000c0DE/);
    expect(exitCodeForResult(result, false)).toBe(ExitCode.CHECK_ERROR);
  });

  it('applies comparison operators, ranges and patterns', async () => {
    const result = await run(
      fixture(`
        - { id: gt, type: function_call, function: balanceOf, args: ["${DEAD}"], value: 0, options: { comparison: ">" } }
        - { id: lt, type: function_call, function: balanceOf, args: ["${DEAD}"], value: 50, options: { comparison: less_than } }
        - { id: range, type: function_call, function: balanceOf, args: ["${DEAD}"], options: { range: { min: 50, max: 150 } } }
        - { id: pattern, type: variable, name: symbol, options: { pattern: "^f", ignore_case: true } }
      `),
    );
    expect(status(result)).toEqual({
      'Fixture.gt': 'pass',
      'Fixture.lt': 'drift',
      'Fixture.range': 'pass',
      'Fixture.pattern': 'pass',
    });
  });

  it('runs conditional branches and skips when no branch applies', async () => {
    const result = await run(
      fixture(`
        - id: when-paused
          type: conditional
          condition: { name: paused, value: true }
          then:
            - { type: variable, name: flags, value: 7 }
        - id: unpaused
          type: conditional
          condition: { name: paused, value: true }
          then:
            - { type: variable, name: flags, value: 7 }
          else:
            - { type: variable, name: flags, value: 1 }
      `),
    );
    expect(status(result)).toEqual({ 'Fixture.when-paused': 'skipped', 'Fixture.unpaused -> else -> flags': 'pass' });
  });

  it('aggregates exactly', async () => {
    const balances = [DEAD, BEEF, NOBODY].map((a) => `{ function: balanceOf, args: ["${a}"] }`).join(', ');
    const result = await run(
      fixture(`
        - { id: count, type: aggregate, operation: count, value: 2, sources: [${balances}] }
        - { id: average, type: aggregate, operation: average, value: 100, sources: [${balances}] }
        - { id: min, type: aggregate, operation: min, value: 0, sources: [${balances}] }
        - { id: max, type: aggregate, operation: max, value: 200, sources: [${balances}] }
      `),
    );
    expect(status(result)).toEqual({
      'Fixture.count': 'pass',
      'Fixture.average': 'pass',
      'Fixture.min': 'pass',
      'Fixture.max': 'pass',
    });
  });

  it('flags stale timestamps against the pinned block time', async () => {
    const snapshot = await chain.snapshot();
    try {
      await chain.send('setLastUpdate', 1);
      const result = await run(
        fixture(`- { type: time_based, function: latestRoundData, field: updatedAt, max_age_seconds: 3600 }`),
      );
      expect(result.results[0].status).toBe('drift');
      expect(result.results[0].expected).toBe('age <= 3600s');
    } finally {
      await chain.revert(snapshot);
    }
  });

  it('reads across contracts', async () => {
    const legacy = `  Legacy:\n    address: "${chain.legacyAddress}"\n    state:\n${indent(
      `
        - { type: cross_contract, target_contract: Fixture, function: totalSupply, value: "${SUPPLY}" }
        - type: comparison
          left: { contract: Fixture, function: balanceOf, args: ["${BEEF}"] }
          operator: "=="
          right: { value: 200 }
      `,
      6,
    )}\n`;
    const result = await run(fixture(`- { type: owner, value: "${OWNER}" }`) + legacy);
    expect(result.results.filter((r) => r.status !== 'pass')).toEqual([]);
    expect(result.results.map((r) => r.key)).toContain('Fixture.totalSupply()');
  });

  it('fails fast when the RPC is unreachable or on another chain', async () => {
    const dead = tmp.write(
      'dead.yaml',
      `network:\n  rpc_url: http://127.0.0.1:9\n  chain_id: 31337\n  max_retries: 0\ncontracts:\n${fixture(`- { type: owner, value: "${OWNER}" }`)}`,
    );
    await expect(verify(loadConfig(dead, { env: {} }))).rejects.toThrow(ConnectionError);

    const wrong = tmp.write(
      'wrong-chain.yaml',
      `network:\n  rpc_url: ${chain.url}\n  chain_id: 1\ncontracts:\n${fixture(`- { type: owner, value: "${OWNER}" }`)}`,
    );
    await expect(verify(loadConfig(wrong, { env: {} }))).rejects.toThrow(
      /is on chain 31337, but the config says chain_id 1/,
    );
  });
});
