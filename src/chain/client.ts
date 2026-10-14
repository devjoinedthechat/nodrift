/** One connection per network: chain id check, block pinning, retries, batching. */

import { FetchRequest, JsonRpcProvider, Network, isError } from 'ethers';
import { ConnectionError, errorMessage } from '../common/errors';
import { logger } from '../common/logger';
import type { NetworkSettings } from '../config/normalize';
import { MULTICALL3_ADDRESS, MulticallBatcher } from './multicall';
import { CallRevertedError } from './revert';

export interface PinnedBlock {
  number: number;
  timestamp: bigint;
  hash: string;
}

/** RPC URLs often embed API keys; only the host is ever printed. */
export function redactUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '(invalid url)';
  }
}

const TRANSIENT_NODE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_SOCKET',
]);

/** HTTP statuses worth retrying: timeouts, rate limits and server-side failures. */
function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function isTransient(error: unknown): boolean {
  if (isError(error, 'NETWORK_ERROR') || isError(error, 'TIMEOUT')) return true;
  if (isError(error, 'SERVER_ERROR')) {
    const status = error.response?.statusCode;
    return status === undefined || retryableStatus(status);
  }
  const code = (error as { code?: unknown })?.code;
  const causeCode = (error as { cause?: { code?: unknown } })?.cause?.code;
  if (TRANSIENT_NODE_CODES.has(String(code)) || TRANSIENT_NODE_CODES.has(String(causeCode))) return true;
  return /\b(429|502|503|504)\b|rate limit|too many requests|temporarily unavailable|ECONNRESET|ECONNREFUSED|socket hang up/i.test(
    errorMessage(error),
  );
}

/**
 * Remove the RPC URL from text. ethers puts the full request URL, which often carries an
 * API key in its path or query, into the message of every HTTP error. Path segments, query
 * values and credentials long enough to be keys are removed wherever they appear.
 */
export function scrubSecrets(text: string, rpcUrl: string): string {
  const host = redactUrl(rpcUrl);
  const urls = new Set([rpcUrl, rpcUrl.replace(/\/+$/, '')]);
  const fragments = new Set<string>();
  try {
    const url = new URL(rpcUrl);
    urls.add(url.href);
    urls.add(url.href.replace(/\/+$/, ''));
    for (const part of [url.username, url.password, ...url.pathname.split('/'), ...url.searchParams.values()]) {
      const decoded = safeDecode(part);
      if (decoded.length >= 8) fragments.add(decoded);
      if (part.length >= 8) fragments.add(part);
    }
  } catch {
    // Not a URL: only the literal string can be removed.
  }
  let out = text.replace(/("requestUrl":\s*")[^"]*(")/g, `$1${host}$2`);
  for (const url of [...urls].sort((a, b) => b.length - a.length)) out = out.split(url).join(host);
  for (const fragment of [...fragments].sort((a, b) => b.length - a.length))
    out = out.split(fragment).join('[redacted]');
  return out;
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

interface RpcFailure extends Error {
  code?: unknown;
  data?: unknown;
  shortMessage?: unknown;
  response?: { statusCode?: number };
  info?: { responseBody?: unknown };
}

/**
 * Replace an RPC error with a plain one whose message cannot leak the RPC URL. Only what the
 * client needs is kept: `code` (retry and revert handling), revert `data` and the HTTP status.
 * ethers errors are read-only, so they cannot be cleaned in place.
 */
export function scrubError(error: unknown, rpcUrl: string): unknown {
  if (!(error instanceof Error)) return error;
  const source = error as RpcFailure;
  const short = typeof source.shortMessage === 'string' ? source.shortMessage : source.message;
  const body = typeof source.info?.responseBody === 'string' ? source.info.responseBody.trim() : '';
  const clean: RpcFailure = new Error(scrubSecrets(body ? `${short}: ${body.slice(0, 200)}` : short, rpcUrl));
  if (source.code !== undefined) clean.code = source.code;
  if (source.data !== undefined) clean.data = source.data;
  if (source.response?.statusCode !== undefined) clean.response = { statusCode: source.response.statusCode };
  return clean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class ChainClient {
  private readonly provider: JsonRpcProvider;
  private readonly calls = new Map<string, Promise<string>>();
  private batcher?: MulticallBatcher;
  private pinned?: PinnedBlock;
  requests = 0;

  constructor(readonly settings: NetworkSettings) {
    const request = new FetchRequest(settings.rpcUrl);
    request.timeout = settings.timeoutMs;
    const network = Network.from(settings.chainId);
    // cacheTimeout -1: ethers would otherwise hand a retry the cached failure of the previous attempt.
    // Identical calls are deduplicated by this client instead.
    this.provider = new JsonRpcProvider(request, network, {
      staticNetwork: network,
      batchMaxCount: 1,
      cacheTimeout: -1,
    });
  }

  get host(): string {
    return redactUrl(this.settings.rpcUrl);
  }

  get block(): PinnedBlock {
    if (!this.pinned) throw new Error('ChainClient.connect() has not been called');
    return this.pinned;
  }

  get multicall(): boolean {
    return this.batcher !== undefined;
  }

  get batches(): number {
    return this.batcher?.batches ?? 0;
  }

  /** Verify the chain id, pin the block, and detect Multicall3. */
  async connect(): Promise<void> {
    const { chainId, block } = this.settings;
    let remoteChainId: bigint;
    try {
      remoteChainId = BigInt(await this.withRetry(() => this.provider.send('eth_chainId', []), 'eth_chainId'));
    } catch (error) {
      throw new ConnectionError(`Cannot reach RPC endpoint ${this.host} (chain_id ${chainId}): ${errorMessage(error)}`);
    }
    if (remoteChainId !== BigInt(chainId)) {
      throw new ConnectionError(
        `RPC endpoint ${this.host} is on chain ${remoteChainId}, but the config says chain_id ${chainId}`,
      );
    }

    let fetched;
    try {
      fetched = await this.withRetry(() => this.provider.getBlock(block), 'getBlock');
    } catch (error) {
      throw new ConnectionError(`Cannot fetch block '${block}' from ${this.host}: ${errorMessage(error)}`);
    }
    if (!fetched || fetched.hash === null) {
      throw new ConnectionError(`Block '${block}' was not found on chain ${chainId} (${this.host})`);
    }
    this.pinned = { number: fetched.number, timestamp: BigInt(fetched.timestamp), hash: fetched.hash };

    if (this.settings.multicall) {
      const code = await this.getCode(MULTICALL3_ADDRESS).catch(() => '0x');
      if (code !== '0x') {
        this.batcher = new MulticallBatcher(
          (to, data) => this.ethCall(to, data),
          (to, data) => this.ethCall(to, data),
        );
      }
    }
    logger.info(
      `chain ${chainId} via ${this.host}: block ${this.pinned.number}, multicall ${this.multicall ? 'on' : 'off'}`,
    );
  }

  /** eth_call at the pinned block. Identical calls are made once. */
  call(to: string, data: string): Promise<string> {
    const key = `${to.toLowerCase()}:${data}`;
    let result = this.calls.get(key);
    if (!result) {
      result = this.batcher ? this.batcher.call(to, data) : this.ethCall(to, data);
      this.calls.set(key, result);
    }
    return result;
  }

  getStorage(address: string, slot: string): Promise<string> {
    return this.withRetry(() => this.provider.getStorage(address, slot, this.block.number), 'eth_getStorageAt');
  }

  getCode(address: string): Promise<string> {
    return this.withRetry(() => this.provider.getCode(address, this.block.number), 'eth_getCode');
  }

  destroy(): void {
    this.provider.destroy();
  }

  private async ethCall(to: string, data: string): Promise<string> {
    try {
      return await this.withRetry(() => this.provider.call({ to, data, blockTag: this.block.number }), 'eth_call');
    } catch (error) {
      if (isError(error, 'CALL_EXCEPTION')) throw new CallRevertedError(error.data ?? '0x');
      throw error;
    }
  }

  private async withRetry<T>(operation: () => Promise<T>, what: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        this.requests++;
        return await operation();
      } catch (raw) {
        const error = scrubError(raw, this.settings.rpcUrl);
        if (attempt >= this.settings.maxRetries || !isTransient(error)) throw error;
        const delay = Math.min(250 * 2 ** attempt, 4000);
        logger.debug(`${what} on ${this.host} failed (${errorMessage(error)}); retrying in ${delay}ms`);
        await sleep(delay);
      }
    }
  }
}
