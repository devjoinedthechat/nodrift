import { AbiCoder, Interface } from 'ethers';
import { isTransient, redactUrl } from '../../src/chain/client';
import { MULTICALL3_ADDRESS, MulticallBatcher } from '../../src/chain/multicall';
import { CallRevertedError, describeRevert } from '../../src/chain/revert';

const coder = AbiCoder.defaultAbiCoder();
const MULTICALL = new Interface([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
]);

function aggregateResponse(results: Array<[boolean, string]>): string {
  return MULTICALL.encodeFunctionResult('aggregate3', [
    results.map(([success, returnData]) => ({ success, returnData })),
  ]);
}

describe('MulticallBatcher', () => {
  it('sends calls from the same tick as one aggregate3 request', async () => {
    const send = jest.fn(async (to: string, data: string) => {
      expect(to).toBe(MULTICALL3_ADDRESS);
      const [calls] = MULTICALL.decodeFunctionData('aggregate3', data);
      return aggregateResponse((calls as Array<{ callData: string }>).map((c) => [true, c.callData]));
    });
    const single = jest.fn();
    const batcher = new MulticallBatcher(send, single);
    const results = await Promise.all(
      ['0x01', '0x02', '0x03'].map((data) => batcher.call('0x' + '11'.repeat(20), data)),
    );
    expect(results).toEqual(['0x01', '0x02', '0x03']);
    expect(send).toHaveBeenCalledTimes(1);
    expect(single).not.toHaveBeenCalled();
    expect(batcher.batches).toBe(1);
  });

  it('splits large batches and maps per-call reverts', async () => {
    const send = jest.fn(async (_to: string, data: string) => {
      const [calls] = MULTICALL.decodeFunctionData('aggregate3', data);
      return aggregateResponse((calls as Array<{ callData: string }>).map((c) => [c.callData !== '0xff', c.callData]));
    });
    const batcher = new MulticallBatcher(send, jest.fn(), 2);
    const settled = await Promise.allSettled(
      ['0x01', '0xff', '0x03', '0x04'].map((d) => batcher.call('0x' + '22'.repeat(20), d)),
    );
    expect(send).toHaveBeenCalledTimes(2);
    expect(settled[0]).toEqual({ status: 'fulfilled', value: '0x01' });
    expect(settled[1].status).toBe('rejected');
    expect((settled[1] as PromiseRejectedResult).reason).toBeInstanceOf(CallRevertedError);
  });

  it('falls back to single calls when the batch itself fails, and for lone calls', async () => {
    const send = jest.fn(async () => {
      throw new Error('payload too large');
    });
    const single = jest.fn(async (_to: string, data: string) => `${data}aa`);
    const batcher = new MulticallBatcher(send, single);
    expect(
      await Promise.all([batcher.call(MULTICALL3_ADDRESS, '0x01'), batcher.call(MULTICALL3_ADDRESS, '0x02')]),
    ).toEqual(['0x01aa', '0x02aa']);
    expect(await batcher.call(MULTICALL3_ADDRESS, '0x03')).toBe('0x03aa');
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('describeRevert', () => {
  it('decodes standard and custom errors', () => {
    expect(describeRevert('0x')).toBe('reverted without a reason');
    expect(describeRevert('0x08c379a0' + coder.encode(['string'], ['paused']).slice(2))).toBe('reverted: paused');
    expect(describeRevert('0x4e487b71' + coder.encode(['uint256'], [0x11]).slice(2))).toBe('panicked with code 0x11');
    const iface = new Interface(['error NotAllowed(address caller)']);
    const data = iface.encodeErrorResult('NotAllowed', ['0x1111111111111111111111111111111111111111']);
    expect(describeRevert(data, iface)).toBe('reverted with NotAllowed(0x1111111111111111111111111111111111111111)');
    expect(describeRevert('0xdeadbeef')).toBe('reverted with data 0xdeadbeef');
  });
});

describe('RPC helpers', () => {
  it('never prints more than the host of an RPC URL', () => {
    expect(redactUrl('https://eth-mainnet.g.alchemy.com/v2/SECRET_KEY')).toBe('eth-mainnet.g.alchemy.com');
    expect(redactUrl('https://user:pass@rpc.example:8545/x?key=1')).toBe('rpc.example:8545');
    expect(redactUrl('not a url')).toBe('(invalid url)');
  });

  it('retries only transient failures', () => {
    const ethersError = (code: string) => Object.assign(new Error(code), { code });
    expect(isTransient(ethersError('TIMEOUT'))).toBe(true);
    expect(isTransient(ethersError('SERVER_ERROR'))).toBe(true);
    expect(isTransient(ethersError('NETWORK_ERROR'))).toBe(true);
    expect(isTransient(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } }))).toBe(true);
    expect(isTransient(new Error('429 Too Many Requests'))).toBe(true);
    expect(isTransient(ethersError('CALL_EXCEPTION'))).toBe(false);
    expect(isTransient(ethersError('BAD_DATA'))).toBe(false);
    expect(isTransient(new Error('invalid argument'))).toBe(false);
  });
});
