import type { CheckResult } from '../../src/check/evaluate';
import { setColorEnabled } from '../../src/common/style';
import { renderJson } from '../../src/output/json';
import { renderJUnit } from '../../src/output/junit';
import { renderPlan, renderText } from '../../src/output/text';
import { summarize, type VerificationResult } from '../../src/verify';

const base = { contract: 'Token', address: '0x5FbDB2315678afecb367f032d93F642f64180aa3', chainId: 1 };

const results: CheckResult[] = [
  { ...base, key: 'symbol', type: 'variable', status: 'pass', actual: 'TKN', expected: 'TKN' },
  {
    ...base,
    key: 'totalSupply',
    type: 'variable',
    status: 'drift',
    actual: 10n ** 24n + 1n,
    expected: '1000000000000000000000000',
    metric: { name: 'supply', category: 'supply', severity: 'critical' },
  },
  {
    ...base,
    key: 'MINTER_ROLE members',
    type: 'role',
    status: 'drift',
    actual: [],
    expected: '[]',
    missing: ['0x1111111111111111111111111111111111111111'],
    unexpected: [],
  },
  { ...base, key: 'cap() <&>"\'', type: 'function_call', status: 'error', message: 'reverted: <nope> & "why"' },
  { ...base, key: 'if paused() == true', type: 'conditional', status: 'skipped', message: 'condition is false' },
];

const result: VerificationResult = {
  version: '0.1.0',
  file: 'nodrift.yaml',
  startedAt: '2026-01-01T00:00:00.000Z',
  durationMs: 1234,
  status: 'error',
  networks: [
    {
      chainId: 1,
      host: 'rpc.example',
      block: 100,
      blockHash: '0xabc',
      blockTimestamp: 1,
      multicall: true,
      requests: 3,
    },
  ],
  contracts: [{ name: 'Token', address: base.address, chainId: 1 }],
  results,
  summary: summarize(results, 1),
};

beforeAll(() => setColorEnabled(false));

describe('text report', () => {
  it('lists every check with its status and details', () => {
    const text = renderText(result);
    expect(text).toContain('chain 1 via rpc.example · block 100 · multicall');
    expect(text).toMatch(/✓ symbol\s+TKN/);
    expect(text).toMatch(/✗ totalSupply\s+\[CRITICAL\] supply/);
    expect(text).toContain('actual    1000000000000000000000001');
    expect(text).toContain('missing    ["0x1111111111111111111111111111111111111111"]');
    expect(text).toContain('reverted: <nope> & "why"');
    expect(text).toContain('- if paused() == true');
    expect(text).toContain('5 checks: 1 passed, 2 drifted, 1 error, 1 skipped · 1 contract · 1234 ms');
  });

  it('hides passing and skipped checks in quiet mode', () => {
    const text = renderText(result, { quiet: true });
    expect(text).not.toContain('symbol');
    expect(text).not.toContain('if paused');
    expect(text).toContain('totalSupply');
  });

  it('renders a plan of drift only', () => {
    const plan = renderPlan(result);
    expect(plan).toContain('# contract.Token');
    expect(plan).toContain('~ totalSupply');
    expect(plan).toContain('+ ["0x1111111111111111111111111111111111111111"]');
    expect(plan).not.toContain('symbol');
    expect(plan).toContain('Plan: 2 drifted, 1 error, 1 in sync, 1 skipped.');
  });
});

describe('JSON report', () => {
  it('writes integers as exact strings', () => {
    const parsed = JSON.parse(renderJson(result));
    expect(parsed.results[1].actual).toBe('1000000000000000000000001');
    expect(parsed.summary).toEqual({ contracts: 1, checks: 5, passed: 1, drifted: 2, errors: 1, skipped: 1 });
    expect(renderJson(result, true)).not.toContain('\n');
  });
});

describe('JUnit report', () => {
  it('emits one escaped test case per check', () => {
    const xml = renderJUnit(result);
    expect(xml.match(/<testcase /g)).toHaveLength(5);
    expect(xml).toContain('<testsuites name="nodrift" tests="5" failures="2" errors="1" skipped="1" time="1.234">');
    expect(xml).toContain('name="cap() &lt;&amp;&gt;&quot;&apos;"');
    expect(xml).toContain('<skipped message="condition is false"/>');
    expect(xml).toContain('<property name="block" value="100"/>');
    expect(xml).not.toMatch(/<[^>]*<nope>/);
  });
});
