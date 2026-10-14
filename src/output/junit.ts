/** JUnit XML report: one test suite per contract, one test case per check. */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CheckResult } from '../check/evaluate';
import { formatTyped } from '../check/values';
import type { VerificationResult } from '../verify';

function xml(text: string): string {
  return (
    text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  );
}

function body(result: CheckResult): string {
  const lines = [`${result.contract}.${result.key} (${result.type}) at ${result.address}, chain ${result.chainId}`];
  if (result.actual !== undefined) lines.push(`actual:   ${formatTyped(result.actual)}`);
  if (result.expected !== undefined) lines.push(`expected: ${result.expected}`);
  if (result.missing?.length) lines.push(`missing:  ${formatTyped(result.missing)}`);
  if (result.unexpected?.length) lines.push(`unexpected: ${formatTyped(result.unexpected)}`);
  if (result.message) lines.push(result.message);
  if (result.metric) lines.push(`metric: ${result.metric.name} (${result.metric.severity}, ${result.metric.category})`);
  return lines.join('\n');
}

function testcase(result: CheckResult): string {
  const open = `    <testcase classname="nodrift.${xml(result.contract)}" name="${xml(result.key)}" time="0">`;
  switch (result.status) {
    case 'pass':
      return `${open}</testcase>`;
    case 'skipped':
      return `${open}\n      <skipped message="${xml(result.message ?? '')}"/>\n    </testcase>`;
    case 'drift': {
      const message = result.message ?? `expected ${result.expected}, got ${formatTyped(result.actual)}`;
      return `${open}\n      <failure type="drift" message="${xml(message)}">${xml(body(result))}</failure>\n    </testcase>`;
    }
    case 'error':
      return `${open}\n      <error type="error" message="${xml(result.message ?? '')}">${xml(body(result))}</error>\n    </testcase>`;
  }
}

export function renderJUnit(result: VerificationResult): string {
  const seconds = (result.durationMs / 1000).toFixed(3);
  const count = (results: CheckResult[], status: CheckResult['status']) =>
    results.filter((r) => r.status === status).length;
  const s = result.summary;
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="nodrift" tests="${s.checks}" failures="${s.drifted}" errors="${s.errors}" skipped="${s.skipped}" time="${seconds}">`,
  ];
  for (const contract of result.contracts) {
    const results = result.results.filter((r) => r.contract === contract.name);
    const network = result.networks.find((n) => n.chainId === contract.chainId);
    out.push(
      `  <testsuite name="${xml(contract.name)}" tests="${results.length}" failures="${count(results, 'drift')}" ` +
        `errors="${count(results, 'error')}" skipped="${count(results, 'skipped')}" time="0" timestamp="${result.startedAt}">`,
      '    <properties>',
      `      <property name="address" value="${contract.address}"/>`,
      `      <property name="chain_id" value="${contract.chainId}"/>`,
      ...(network ? [`      <property name="block" value="${network.block}"/>`] : []),
      '    </properties>',
      ...results.map(testcase),
      '  </testsuite>',
    );
  }
  out.push('</testsuites>', '');
  return out.join('\n');
}

export function writeJUnit(result: VerificationResult, file: string): void {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, renderJUnit(result), 'utf8');
}
