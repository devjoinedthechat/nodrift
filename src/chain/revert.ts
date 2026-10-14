/** Revert data decoding for readable error messages. */

import { AbiCoder, type Interface } from 'ethers';
import { CheckError } from '../common/errors';

export class CallRevertedError extends CheckError {
  constructor(readonly data: string) {
    super(describeRevert(data));
  }
}

const ERROR_STRING = '0x08c379a0';
const PANIC = '0x4e487b71';

export function describeRevert(data: string, iface?: Interface): string {
  if (!data || data === '0x') return 'reverted without a reason';
  const selector = data.slice(0, 10).toLowerCase();
  const coder = AbiCoder.defaultAbiCoder();
  try {
    if (selector === ERROR_STRING) return `reverted: ${coder.decode(['string'], `0x${data.slice(10)}`)[0]}`;
    if (selector === PANIC)
      return `panicked with code 0x${(coder.decode(['uint256'], `0x${data.slice(10)}`)[0] as bigint).toString(16)}`;
    const parsed = iface?.parseError(data);
    if (parsed) return `reverted with ${parsed.name}(${parsed.args.map(String).join(', ')})`;
  } catch {
    // fall through to raw data
  }
  return `reverted with data ${data.length > 74 ? `${data.slice(0, 74)}...` : data}`;
}
