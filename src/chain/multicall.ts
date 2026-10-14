/**
 * Multicall3 batching. Calls issued in the same tick are sent as one `aggregate3` eth_call,
 * so a config with hundreds of checks costs a handful of RPC requests, and every result
 * comes from the same block by construction.
 */

import { Interface } from 'ethers';
import { logger } from '../common/logger';
import { errorMessage } from '../common/errors';
import { CallRevertedError } from './revert';

/** Deployed at the same address on most EVM chains. See https://www.multicall3.com */
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

const MULTICALL3 = new Interface([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
]);

interface Pending {
  target: string;
  data: string;
  resolve: (value: string) => void;
  reject: (reason: unknown) => void;
}

type Send = (to: string, data: string) => Promise<string>;

export class MulticallBatcher {
  private queue: Pending[] = [];
  private scheduled = false;
  batches = 0;

  /**
   * @param send   eth_call used for the aggregate3 request
   * @param single eth_call used for lone calls and when a whole batch fails
   */
  constructor(
    private readonly send: Send,
    private readonly single: Send,
    private readonly maxBatchSize = 200,
  ) {}

  call(target: string, data: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.queue.push({ target, data, resolve, reject });
      if (!this.scheduled) {
        this.scheduled = true;
        setImmediate(() => this.flush());
      }
    });
  }

  private flush(): void {
    this.scheduled = false;
    const pending = this.queue;
    this.queue = [];
    for (let i = 0; i < pending.length; i += this.maxBatchSize) {
      void this.run(pending.slice(i, i + this.maxBatchSize));
    }
  }

  private individually(batch: Pending[]): void {
    for (const p of batch) {
      Promise.resolve()
        .then(() => this.single(p.target, p.data))
        .then(p.resolve, p.reject);
    }
  }

  private async run(batch: Pending[]): Promise<void> {
    if (batch.length === 1) return this.individually(batch);
    let results: Array<{ success: boolean; returnData: string }>;
    try {
      const data = MULTICALL3.encodeFunctionData('aggregate3', [
        batch.map((p) => ({ target: p.target, allowFailure: true, callData: p.data })),
      ]);
      const raw = await this.send(MULTICALL3_ADDRESS, data);
      [results] = MULTICALL3.decodeFunctionResult('aggregate3', raw) as unknown as [typeof results];
      this.batches++;
    } catch (error) {
      logger.debug(`multicall batch of ${batch.length} failed (${errorMessage(error)}); falling back to single calls`);
      return this.individually(batch);
    }
    batch.forEach((p, i) => {
      const { success, returnData } = results[i];
      if (success) p.resolve(returnData);
      else p.reject(new CallRevertedError(returnData));
    });
  }
}
