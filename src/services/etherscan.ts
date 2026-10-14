/** Fetch verified contract ABIs through the Etherscan V2 multichain API (one key, many chains). */

import type { AbiInput } from '../config/abi';

const ENDPOINT = 'https://api.etherscan.io/v2/api';

export async function fetchAbi(address: string, chainId: number, apiKey: string): Promise<AbiInput> {
  const url = new URL(ENDPOINT);
  url.search = new URLSearchParams({
    chainid: String(chainId),
    module: 'contract',
    action: 'getabi',
    address,
    apikey: apiKey,
  }).toString();

  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Etherscan returned HTTP ${response.status}`);
  const data = (await response.json()) as { status?: string; message?: string; result?: unknown };
  if (data.status !== '1' || typeof data.result !== 'string') {
    throw new Error(
      `Etherscan: ${typeof data.result === 'string' ? data.result : (data.message ?? 'unexpected response')}`,
    );
  }
  const abi = JSON.parse(data.result) as unknown;
  if (!Array.isArray(abi)) throw new Error('Etherscan returned an ABI that is not a list');
  return abi as AbiInput;
}

/** Keep only read-only functions, which is all nodrift can call. */
export function readOnlyFunctions(abi: AbiInput): AbiInput {
  return abi.filter(
    (item) =>
      typeof item === 'object' &&
      item.type === 'function' &&
      (item.stateMutability === 'view' || item.stateMutability === 'pure' || item.constant === true),
  );
}
