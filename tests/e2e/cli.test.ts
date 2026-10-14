import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEAD, HAS_ANVIL, OWNER, startChain, tempDir, type Chain } from './anvil';

const ROOT = path.resolve(__dirname, '../..');
const CLI = path.join(ROOT, 'src/cli.ts');
/** Absolute loader URL: the CLI runs from a temp directory where `tsx` is not resolvable by name. */
const TSX = pathToFileURL(require.resolve('tsx')).href;

if (!HAS_ANVIL && process.env.CI) throw new Error('anvil (Foundry) is required for the e2e suite in CI');
const suite = HAS_ANVIL ? describe : describe.skip;

suite('nodrift CLI', () => {
  let chain: Chain;
  const tmp = tempDir();

  beforeAll(async () => {
    chain = await startChain();
  }, 60_000);

  afterAll(async () => {
    await chain?.stop();
    tmp.cleanup();
  });

  function cli(...args: string[]) {
    const result = spawnSync(process.execPath, ['--import', TSX, CLI, ...args], {
      cwd: tmp.dir,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: undefined },
    });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  function config(name: string, state: string, rpc = chain.url): string {
    return tmp.write(
      name,
      [
        'network:',
        `  rpc_url: ${rpc}`,
        '  chain_id: 31337',
        '  max_retries: 0',
        'contracts:',
        '  Fixture:',
        `    address: "${chain.fixtureAddress}"`,
        '    state:',
        ...state.split('\n').map((line) => `      ${line}`),
        '',
      ].join('\n'),
    );
  }

  const MATCHING = `- { type: owner, value: "${OWNER}" }`;
  const DRIFTING = `- { type: function_call, function: "totalSupply() returns (uint256)", value: "1000000000000000000000000" }`;
  const BROKEN = `- { type: function_call, function: "failing() returns (uint256)", value: 0 }`;

  it('validates offline and reports success', () => {
    const run = cli('validate', config('valid.yaml', MATCHING));
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/is valid: 1 contract\(s\), 1 check\(s\), chain 31337/);
  });

  it('rejects addresses with a bad checksum before touching the chain', () => {
    const run = cli(
      'validate',
      config('checksum.yaml', `- { type: owner, value: "0xAbCd111111111111111111111111111111111111" }`),
    );
    expect(run.code).toBe(5);
    expect(run.stderr).toMatch(/checksum/);
  });

  it('never executes commands from a config', () => {
    const marker = path.join(tmp.dir, 'executed');
    const file = tmp.write(
      'cmd.yaml',
      `network:\n  rpc_url: "\${cmd:touch ${marker} && echo ${chain.url}}"\n  chain_id: 31337\ncontracts: {}\n`,
    );
    const run = cli('validate', file);
    expect(run.code).toBe(2);
    expect(run.stderr).toMatch(/Unsupported substitution/);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('exits 0 on a match and on drift unless --fail-on-drift is set', () => {
    expect(cli(config('ok.yaml', MATCHING)).code).toBe(0);
    const drift = config('drift.yaml', DRIFTING);
    const plain = cli(drift);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toMatch(/1 checks: 0 passed, 1 drifted, 0 errors/);
    expect(cli('verify', drift, '--fail-on-drift').code).toBe(1);
  });

  it('exits 4 when a check cannot be evaluated, with or without --fail-on-drift', () => {
    const file = config('broken.yaml', BROKEN);
    expect(cli(file).code).toBe(4);
    expect(cli(file, '--fail-on-drift').code).toBe(4);
  });

  it('exits 3 when the RPC endpoint is unreachable', () => {
    const run = cli(config('dead.yaml', MATCHING, 'http://127.0.0.1:9'));
    expect(run.code).toBe(3);
    expect(run.stderr).toMatch(/Cannot reach RPC endpoint 127\.0\.0\.1:9/);
  });

  it('writes JSON with exact integers', () => {
    const run = cli(config('json.yaml', DRIFTING), '--output', 'json');
    expect(run.code).toBe(0);
    const report = JSON.parse(run.stdout);
    expect(report.status).toBe('drift');
    expect(report.results[0]).toMatchObject({ status: 'drift', actual: '1000000000000000001000000' });
    expect(report.networks[0]).toMatchObject({ chainId: 31337, host: expect.stringMatching(/^127\.0\.0\.1:/) });
  });

  it('writes a JUnit report with one test case per check', () => {
    const report = path.join(tmp.dir, 'reports/junit.xml');
    const run = cli(config('junit.yaml', `${MATCHING}\n${DRIFTING}\n${BROKEN}`), '-o', 'junit', '--junit-file', report);
    expect(run.code).toBe(4);
    const xml = fs.readFileSync(report, 'utf8');
    expect(xml.match(/<testcase /g)).toHaveLength(3);
    expect(xml).toMatch(/<testsuites name="nodrift" tests="3" failures="1" errors="1" skipped="0"/);
  });

  it('prints a plan that lists only drift', () => {
    const run = cli(config('plan.yaml', `${MATCHING}\n${DRIFTING}`), '--plan');
    expect(run.stdout).toMatch(/~ totalSupply\(\)/);
    expect(run.stdout).not.toMatch(/~ owner\(\)/);
    expect(run.stdout).toMatch(/Plan: 1 drifted, 0 errors, 1 in sync\./);
  });

  it('reads at a pinned block', async () => {
    const file = config(
      'block.yaml',
      `- { type: function_call, function: "balanceOf(address) returns (uint256)", args: ["${DEAD}"], value: 100 }`,
    );
    const snapshot = await chain.snapshot();
    try {
      const before = await chain.provider.getBlockNumber();
      await chain.send('setBalance', DEAD, 5);
      expect(cli(file, '--fail-on-drift').code).toBe(1);
      expect(cli(file, '--fail-on-drift', '--block', String(before)).code).toBe(0);
    } finally {
      await chain.revert(snapshot);
    }
  });
});
