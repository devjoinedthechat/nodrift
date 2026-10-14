/** Local anvil chain with the fixture contracts deployed. */

import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { Contract, ContractFactory, JsonRpcProvider, Wallet, type InterfaceAbi } from 'ethers';
import { MULTICALL3_ADDRESS } from '../../src/chain/multicall';

export { tempDir } from '../helpers';

interface Artifact {
  abi: InterfaceAbi;
  bytecode: string;
  deployedBytecode: string;
}

const artifacts = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/artifacts.json'), 'utf8')) as Record<
  'Fixture' | 'Legacy' | 'Multicall3',
  Artifact
>;

export const HAS_ANVIL = spawnSync('anvil', ['--version']).status === 0;

/** Anvil's first default account. */
const DEV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

export const IMPLEMENTATION = '0x4444444444444444444444444444444444444444';
export const OWNER = '0x1111111111111111111111111111111111111111';
export const DEAD = '0x000000000000000000000000000000000000dEaD';
export const BEEF = '0x00000000000000000000000000000000DeaDBeef';

export interface Chain {
  url: string;
  provider: JsonRpcProvider;
  fixture: Contract;
  fixtureAddress: string;
  legacyAddress: string;
  /** Send a state-changing transaction to the fixture and wait for it. */
  send(method: string, ...args: unknown[]): Promise<void>;
  snapshot(): Promise<string>;
  revert(id: string): Promise<void>;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as net.AddressInfo;
  server.close();
  await once(server, 'close');
  return port;
}

export async function startChain(): Promise<Chain> {
  const port = await freePort();
  const child = spawn('anvil', ['--port', String(port), '--chain-id', '31337', '--silent'], { stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  // cacheTimeout -1: the default 250ms request cache would hand out stale nonces between deployments.
  const provider = new JsonRpcProvider(url, 31337, { staticNetwork: true, pollingInterval: 50, cacheTimeout: -1 });
  const kill = async () => {
    provider.destroy();
    child.kill();
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
  };
  try {
    return await setup(url, provider, kill);
  } catch (error) {
    await kill();
    throw error;
  }
}

async function setup(url: string, provider: JsonRpcProvider, kill: () => Promise<void>): Promise<Chain> {
  for (let attempt = 0; ; attempt++) {
    try {
      await provider.send('eth_chainId', []);
      break;
    } catch (error) {
      if (attempt > 100) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  const wallet = new Wallet(DEV_KEY, provider);
  const deploy = async (name: 'Fixture' | 'Legacy', ...args: unknown[]) => {
    const contract = await new ContractFactory(artifacts[name].abi, artifacts[name].bytecode, wallet).deploy(...args);
    await contract.waitForDeployment();
    return contract;
  };
  const fixture = (await deploy('Fixture', IMPLEMENTATION)) as Contract;
  const legacy = await deploy('Legacy');
  await provider.send('anvil_setCode', [MULTICALL3_ADDRESS, artifacts.Multicall3.deployedBytecode]);

  return {
    url,
    provider,
    fixture,
    fixtureAddress: await fixture.getAddress(),
    legacyAddress: await legacy.getAddress(),
    async send(method, ...args) {
      const tx = await fixture.getFunction(method)(...args);
      await tx.wait();
    },
    snapshot: () => provider.send('evm_snapshot', []),
    async revert(id) {
      await provider.send('evm_revert', [id]);
    },
    stop: kill,
  };
}
