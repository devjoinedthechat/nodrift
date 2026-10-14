/** Run all checks of a normalized config against the configured networks. */

import { ChainClient } from './chain/client';
import { evaluateCheck, type CheckResult } from './check/evaluate';
import { ConfigurationError } from './common/errors';
import { mapWithConcurrency } from './common/limit';
import { loadConfig, type LoadOptions } from './config/load';
import type { BlockSpec, ContractInfo, NetworkSettings, NormalizedConfig } from './config/normalize';
import { VERSION } from './version';

export interface VerifyOptions {
  /** Override the block for every network (a block number is only allowed with a single chain). */
  block?: BlockSpec;
  /** Maximum checks evaluated at once (default 32). Calls are still batched per tick. */
  concurrency?: number;
}

export interface NetworkReport {
  chainId: number;
  host: string;
  block: number;
  blockHash: string;
  blockTimestamp: number;
  multicall: boolean;
  requests: number;
}

export interface Summary {
  contracts: number;
  checks: number;
  passed: number;
  drifted: number;
  errors: number;
  skipped: number;
}

export interface VerificationResult {
  version: string;
  file?: string;
  startedAt: string;
  durationMs: number;
  status: 'pass' | 'drift' | 'error';
  networks: NetworkReport[];
  contracts: Array<{ name: string; address: string; chainId: number }>;
  results: CheckResult[];
  summary: Summary;
}

function applyBlockOverride(networks: NetworkSettings[], block: BlockSpec | undefined): Map<string, NetworkSettings> {
  const chains = new Set(networks.map((n) => n.chainId));
  if (typeof block === 'number' && chains.size > 1) {
    throw new ConfigurationError('A block number override needs a single chain; this config reads from several');
  }
  return new Map(networks.map((n) => [n.key, block === undefined ? n : { ...n, block }]));
}

export function summarize(results: CheckResult[], contracts: number): Summary {
  const count = (status: CheckResult['status']) => results.filter((r) => r.status === status).length;
  return {
    contracts,
    checks: results.length,
    passed: count('pass'),
    drifted: count('drift'),
    errors: count('error'),
    skipped: count('skipped'),
  };
}

export async function verify(config: NormalizedConfig, options: VerifyOptions = {}): Promise<VerificationResult> {
  const startedAt = new Date();
  const started = performance.now();
  const settings = applyBlockOverride(config.networks, options.block);
  const clients = new Map([...settings].map(([key, s]) => [key, new ChainClient(s)]));
  const code = new Map<string, Promise<boolean>>();

  try {
    await Promise.all([...clients.values()].map((client) => client.connect()));

    const clientFor = (contract: ContractInfo) => clients.get(contract.network.key)!;
    const ctx = {
      clientFor,
      hasCode: (contract: ContractInfo) => {
        const key = `${contract.network.key}|${contract.address}`;
        let result = code.get(key);
        if (!result) {
          result = clientFor(contract)
            .getCode(contract.address)
            .then((bytecode) => bytecode !== '0x');
          code.set(key, result);
        }
        return result;
      },
    };

    const nested = await mapWithConcurrency(config.checks, options.concurrency ?? 32, (check) =>
      evaluateCheck(check, ctx),
    );
    const results = nested.flat();
    const summary = summarize(results, config.contracts.length);

    return {
      version: VERSION,
      file: config.file,
      startedAt: startedAt.toISOString(),
      durationMs: Math.round(performance.now() - started),
      status: summary.errors > 0 ? 'error' : summary.drifted > 0 ? 'drift' : 'pass',
      networks: [...clients.values()].map((client) => ({
        chainId: client.settings.chainId,
        host: client.host,
        block: client.block.number,
        blockHash: client.block.hash,
        blockTimestamp: Number(client.block.timestamp),
        multicall: client.multicall,
        requests: client.requests,
      })),
      contracts: config.contracts.map((c) => ({ name: c.name, address: c.address, chainId: c.network.chainId })),
      results,
      summary,
    };
  } finally {
    for (const client of clients.values()) client.destroy();
  }
}

/** Load a config file and verify it. */
export async function verifyFile(file: string, options: VerifyOptions & LoadOptions = {}): Promise<VerificationResult> {
  return verify(loadConfig(file, options), options);
}
