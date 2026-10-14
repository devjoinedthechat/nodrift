/** `nodrift init`: build a starter config interactively. */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { style } from '../common/style';
import { FunctionFragment, Interface, getAddress, isAddress } from 'ethers';
import * as yaml from 'js-yaml';
import { errorMessage } from '../common/errors';
import type { AbiInput } from '../config/abi';
import { PRESET_NAMES, type PresetName } from '../config/schema';
import { PRESETS } from '../presets';
import { fetchAbi, readOnlyFunctions } from '../services/etherscan';

export const SCHEMA_URL = 'https://raw.githubusercontent.com/devjoinedthechat/nodrift/main/nodrift.schema.json';

const CHAINS: Array<[string, number]> = [
  ['Ethereum', 1],
  ['Sepolia', 11155111],
  ['Base', 8453],
  ['Arbitrum One', 42161],
  ['OP Mainnet', 10],
  ['Polygon PoS', 137],
  ['BNB Smart Chain', 56],
  ['Avalanche C-Chain', 43114],
];

type Prompts = typeof import('@inquirer/prompts');
type Entry = Record<string, unknown>;

const validAddress = (value: string) => isAddress(value.trim()) || 'not a valid address (check the checksum casing)';

async function customChecks(prompts: Prompts, state: Entry[]): Promise<void> {
  const { input, confirm } = prompts;
  while (state.length === 0 || (await confirm({ message: 'Add a custom function check?', default: false }))) {
    if (state.length === 0) process.stdout.write(style.dim('Every contract needs at least one check.\n'));
    const fn = await input({
      message: 'Function (name from the ABI, or a signature like "balanceOf(address) returns (uint256)")',
      validate: (v) => v.trim() !== '' || 'required',
    });
    const args = await input({ message: 'Arguments, comma separated (empty for none)' });
    const value = await input({ message: 'Expected value', validate: (v) => v.trim() !== '' || 'required' });
    state.push({
      type: 'function_call',
      function: fn.trim(),
      ...(args.trim() ? { args: args.split(',').map((a) => a.trim()) } : {}),
      value: value.trim(),
    });
  }
}

async function promptContract(
  prompts: Prompts,
  chainId: number,
  output: string,
  taken: Set<string>,
): Promise<[string, Entry]> {
  const { input, select, confirm, checkbox } = prompts;
  const name = await input({
    message: 'Contract name',
    validate: (v) => (/^[A-Za-z0-9_-]+$/.test(v) && !taken.has(v)) || 'use letters, digits, _ or -, and a unique name',
  });
  const address = getAddress((await input({ message: 'Address', validate: validAddress })).trim());
  const preset = await select<PresetName | ''>({
    message: 'ABI preset',
    choices: [
      { name: 'none', value: '' },
      ...PRESET_NAMES.map((n) => ({ name: `${n}: ${PRESETS[n].description}`, value: n })),
    ],
  });

  const contract: Entry = { address };
  const abi: AbiInput = preset ? [...PRESETS[preset].abi] : [];
  if (preset) contract.preset = preset;

  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) {
    process.stdout.write(style.dim('Set ETHERSCAN_API_KEY to fetch verified ABIs automatically.\n'));
  } else if (await confirm({ message: 'Fetch the verified ABI from Etherscan?', default: !preset })) {
    try {
      const fetched = readOnlyFunctions(await fetchAbi(address, chainId, apiKey));
      const abiFile = path.join(path.dirname(path.resolve(output)), 'abis', `${name}.json`);
      fs.mkdirSync(path.dirname(abiFile), { recursive: true });
      fs.writeFileSync(abiFile, `${JSON.stringify(fetched, null, 2)}\n`);
      contract.abi = `./${path
        .relative(path.dirname(path.resolve(output)), abiFile)
        .split(path.sep)
        .join('/')}`;
      abi.push(...fetched);
      process.stdout.write(style.dim(`Saved ${fetched.length} read-only functions to ${contract.abi}\n`));
    } catch (error) {
      process.stdout.write(style.yellow(`Could not fetch the ABI: ${errorMessage(error)}\n`));
    }
  }

  const state: Entry[] = [];
  if (await confirm({ message: 'Check the owner (Ownable)?', default: false })) {
    const owner = await input({ message: 'Expected owner address', validate: validAddress });
    state.push({ type: 'owner', value: getAddress(owner.trim()) });
  }

  const getters = new Interface(abi as never).fragments.filter(
    (f): f is FunctionFragment => f instanceof FunctionFragment && f.inputs.length === 0 && f.outputs.length === 1,
  );
  if (getters.length > 0) {
    const picked = await checkbox({
      message: 'Values to check',
      choices: getters.map((f) => ({ name: `${f.name}() -> ${f.outputs[0].type}`, value: f.name })),
    });
    for (const fn of picked) {
      const value = await input({ message: `Expected ${fn}()`, validate: (v) => v.trim() !== '' || 'required' });
      state.push({ type: 'variable', name: fn, value: value.trim() });
    }
  }
  await customChecks(prompts, state);
  contract.state = state;
  return [name, contract];
}

export async function runInit(output: string): Promise<void> {
  const prompts: Prompts = await import('@inquirer/prompts');
  const { input, select, confirm } = prompts;

  if (fs.existsSync(output) && !(await confirm({ message: `${output} exists. Overwrite it?`, default: false }))) return;

  const picked = await select<number>({
    message: 'Network',
    choices: [...CHAINS.map(([label, id]) => ({ name: `${label} (${id})`, value: id })), { name: 'Other', value: 0 }],
  });
  const chainId =
    picked ||
    Number(
      await input({
        message: 'Chain id',
        validate: (v) => (/^\d+$/.test(v) && Number(v) > 0) || 'enter a positive integer',
      }),
    );
  const rpcVar = await input({
    message: 'Environment variable that holds the RPC URL',
    default: 'RPC_URL',
    validate: (v) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(v) || 'not a valid variable name',
  });

  const contracts: Record<string, Entry> = {};
  do {
    const [name, contract] = await promptContract(prompts, chainId, output, new Set(Object.keys(contracts)));
    contracts[name] = contract;
  } while (await confirm({ message: 'Add another contract?', default: false }));

  const config = { version: 1, network: { rpc_url: `\${${rpcVar}}`, chain_id: chainId }, contracts };
  const text = `# yaml-language-server: $schema=${SCHEMA_URL}\n${yaml.dump(config, { lineWidth: 120, noRefs: true })}`;
  fs.writeFileSync(output, text);
  process.stdout.write(
    `${style.green('✓')} wrote ${output}\n` +
      `Next: export ${rpcVar}=<your RPC URL>, then run\n  nodrift validate ${output}\n  nodrift ${output}\n`,
  );
}
