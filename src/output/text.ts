/** Human-readable reports: the default check list and a Terraform-style plan. */

import { style } from '../common/style';
import type { CheckResult, CheckStatus } from '../check/evaluate';
import { formatTyped } from '../check/values';
import type { VerificationResult } from '../verify';

export interface TextOptions {
  /** Only print drift, errors and the summary line. */
  quiet?: boolean;
}

const SYMBOL: Record<CheckStatus, string> = {
  pass: style.green('✓'),
  drift: style.yellow('✗'),
  error: style.red('!'),
  skipped: style.dim('-'),
};

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function clip(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function metricTag(result: CheckResult): string {
  if (!result.metric) return '';
  const severity = result.metric.severity.toUpperCase();
  const color = { critical: style.redBold, high: style.red, medium: style.yellow, low: style.dim }[
    result.metric.severity
  ];
  return `${color(`[${severity}]`)} ${style.dim(result.metric.name)}`;
}

function detailLines(result: CheckResult): string[] {
  const lines: string[] = [];
  const pad = '      ';
  if (result.status === 'error') {
    lines.push(`${pad}${style.red(result.message ?? 'error')}`);
    return lines;
  }
  if (result.status === 'skipped') {
    lines.push(`${pad}${style.dim(result.message ?? 'skipped')}`);
    return lines;
  }
  if (result.status === 'drift') {
    if (result.missing?.length)
      lines.push(`${pad}${style.dim('missing   ')} ${style.red(clip(formatTyped(result.missing)))}`);
    if (result.unexpected?.length)
      lines.push(`${pad}${style.dim('unexpected')} ${style.red(clip(formatTyped(result.unexpected)))}`);
    if (!result.missing?.length && !result.unexpected?.length) {
      lines.push(`${pad}${style.dim('actual   ')} ${style.red(clip(formatTyped(result.actual)))}`);
    }
    lines.push(`${pad}${style.dim('expected ')} ${style.green(clip(result.expected ?? ''))}`);
    if (result.message) lines.push(`${pad}${style.dim(result.message)}`);
  }
  return lines;
}

function header(result: VerificationResult): string[] {
  const lines = [style.bold(`nodrift v${result.version}`) + (result.file ? style.dim(` · ${result.file}`) : '')];
  for (const n of result.networks) {
    lines.push(style.dim(`chain ${n.chainId} via ${n.host} · block ${n.block}${n.multicall ? ' · multicall' : ''}`));
  }
  return lines;
}

export function summaryLine(result: VerificationResult): string {
  const s = result.summary;
  const parts = [
    style.green(`${s.passed} passed`),
    s.drifted > 0 ? style.yellow(`${s.drifted} drifted`) : `${s.drifted} drifted`,
    s.errors > 0 ? style.red(`${s.errors} error${s.errors === 1 ? '' : 's'}`) : '0 errors',
  ];
  if (s.skipped > 0) parts.push(style.dim(`${s.skipped} skipped`));
  return `${s.checks} checks: ${parts.join(', ')} · ${s.contracts} contract${s.contracts === 1 ? '' : 's'} · ${result.durationMs} ms`;
}

function grouped(result: VerificationResult): Map<string, CheckResult[]> {
  const groups = new Map<string, CheckResult[]>(result.contracts.map((c) => [c.name, []]));
  for (const r of result.results) groups.get(r.contract)?.push(r);
  return groups;
}

export function renderText(result: VerificationResult, options: TextOptions = {}): string {
  const lines: string[] = [];
  if (!options.quiet) lines.push(...header(result), '');

  for (const [name, results] of grouped(result)) {
    const shown = options.quiet ? results.filter((r) => r.status === 'drift' || r.status === 'error') : results;
    if (shown.length === 0) continue;
    const contract = result.contracts.find((c) => c.name === name)!;
    lines.push(`${style.bold(name)}  ${style.dim(`${shortAddress(contract.address)} · chain ${contract.chainId}`)}`);
    const width = Math.min(60, Math.max(...shown.map((r) => r.key.length)));
    for (const r of shown) {
      const extras = [
        r.status === 'pass' ? style.dim(clip(formatTyped(r.actual), 60)) : '',
        r.description ? style.dim(`(${r.description})`) : '',
        r.status !== 'pass' ? metricTag(r) : '',
      ].filter(Boolean);
      lines.push(`  ${SYMBOL[r.status]} ${r.key.padEnd(width)}  ${extras.join(' ')}`.trimEnd());
      lines.push(...detailLines(r));
    }
    lines.push('');
  }
  lines.push(summaryLine(result));
  return lines.join('\n');
}

export function renderPlan(result: VerificationResult): string {
  const lines: string[] = [...header(result), ''];
  let changes = 0;
  for (const [name, results] of grouped(result)) {
    const drifted = results.filter((r) => r.status === 'drift' || r.status === 'error');
    if (drifted.length === 0) continue;
    const contract = result.contracts.find((c) => c.name === name)!;
    lines.push(style.bold(`  # contract.${name}`) + style.dim(` (${contract.address}, chain ${contract.chainId})`));
    for (const r of drifted) {
      changes++;
      if (r.status === 'error') {
        lines.push(`  ${style.red('!')} ${r.key}`, `      ${style.red(r.message ?? 'error')}`);
        continue;
      }
      lines.push(`  ${style.yellow('~')} ${[r.key, metricTag(r)].filter(Boolean).join(' ')}`);
      if (r.missing?.length) lines.push(`      ${style.green('+')} ${clip(formatTyped(r.missing))}`);
      if (r.unexpected?.length) lines.push(`      ${style.red('-')} ${clip(formatTyped(r.unexpected))}`);
      if (!r.missing?.length && !r.unexpected?.length) {
        lines.push(
          `      ${style.red(clip(formatTyped(r.actual), 60))} ${style.dim('->')} ${style.green(clip(r.expected ?? '', 60))}`,
        );
      }
    }
    lines.push('');
  }
  const s = result.summary;
  if (changes === 0) lines.push(style.green('No drift. On-chain state matches the config.'), '');
  lines.push(
    `Plan: ${s.drifted} drifted, ${s.errors} error${s.errors === 1 ? '' : 's'}, ${s.passed} in sync` +
      (s.skipped ? `, ${s.skipped} skipped` : '') +
      '.',
    style.dim('nodrift only reads state; it never sends transactions.'),
  );
  return lines.join('\n');
}
