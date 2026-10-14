import * as fs from 'node:fs';
import * as path from 'node:path';
import { ConfigurationError, ValidationError } from '../../src/common/errors';
import { loadConfig } from '../../src/config/load';
import { parseYaml } from '../../src/config/yaml';
import { verify } from '../../src/verify';
import { tempDir } from '../helpers';

const ADDRESS = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const OTHER = '0x1111111111111111111111111111111111111111';
const NETWORK = 'network:\n  rpc_url: http://127.0.0.1:8545\n  chain_id: 1\n';

const tmp = tempDir();
afterAll(() => tmp.cleanup());

let n = 0;
function load(body: string, env: NodeJS.ProcessEnv = {}) {
  const file = tmp.write(`case-${n++}.yaml`, body);
  return loadConfig(file, { env, roots: [tmp.dir] });
}

function contract(state: string, extra = '', address = ADDRESS) {
  const indented = state
    .trim()
    .split('\n')
    .map((l) => `      ${l}`)
    .join('\n');
  return `${NETWORK}contracts:\n  Token:\n    address: "${address}"\n${extra}    state:\n${indented}\n`;
}

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

function issues(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected an error');
}

describe('YAML parsing', () => {
  it('keeps hex values and unsafe integers as strings', () => {
    expect(parseYaml(`a: ${ADDRESS}\nb: 1000000000000000000000000\nc: 6\nd: true\ne: 0o17`, 'x.yaml')).toEqual({
      a: ADDRESS,
      b: '1000000000000000000000000',
      c: 6,
      d: true,
      e: '0o17',
    });
  });

  it('reports syntax errors with a location', () => {
    expect(() => parseYaml('a: [1, 2', 'bad.yaml')).toThrow(/Invalid YAML in bad\.yaml \(line \d+, column \d+\)/);
  });

  it('rejects empty files and non-mapping documents', () => {
    expect(issues(() => load(''))).toMatch(/empty/);
    expect(issues(() => load('- a\n- b\n'))).toMatch(/mapping at the top level/);
  });
});

describe('substitution', () => {
  it('resolves variables, defaults and embedded references', () => {
    const config = load(
      `network:\n  rpc_url: "https://rpc.example/\${KEY}"\n  chain_id: "\${CHAIN || 1}"\ncontracts:\n  Token:\n    address: "\${TOKEN}"\n    state:\n      - { type: owner, value: "\${OWNER || ${OTHER}}" }\n      - { type: function_call, function: "name() returns (string)", value: "$\${literal}" }\n`,
      { KEY: 'secret', TOKEN: ADDRESS },
    );
    expect(config.networks[0]).toMatchObject({ rpcUrl: 'https://rpc.example/secret', chainId: 1 });
    expect(config.checks[0]).toMatchObject({ kind: 'owner', expected: OTHER });
    expect(config.checks[1]).toMatchObject({ expect: { expected: '${literal}' } });
  });

  it('lists every missing variable at once', () => {
    const message = issues(() =>
      load(`network:\n  rpc_url: \${RPC}\n  chain_id: 1\ncontracts:\n  T:\n    address: \${TOKEN}\n    state: []\n`),
    );
    expect(message).toMatch(/Environment variables not set/);
    expect(message).toMatch(/RPC \(used at network\.rpc_url\)/);
    expect(message).toMatch(/TOKEN \(used at contracts\.T\.address\)/);
  });

  it('refuses command execution and expression evaluation', () => {
    for (const expr of ['${cmd:touch /tmp/pwned}', '${math:1+1}']) {
      const error = caught(() =>
        load(
          `${NETWORK}contracts:\n  T:\n    address: "${ADDRESS}"\n    state:\n      - { type: owner, value: "${expr}" }\n`,
        ),
      );
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as Error).message).toMatch(/Unsupported substitution/);
    }
  });

  it('reads files and JSON fields inside the project only', () => {
    tmp.write('owner.txt', `${OTHER}\n`);
    tmp.write('deploy.json', JSON.stringify({ token: { address: ADDRESS } }));
    const config = load(
      `${NETWORK}contracts:\n  T:\n    address: "\${file:deploy.json:token.address}"\n    state:\n      - { type: owner, value: "\${file:owner.txt}" }\n`,
    );
    expect(config.contracts[0].address).toBe(ADDRESS);
    expect(config.checks[0]).toMatchObject({ expected: OTHER });

    const outside = path.join(path.dirname(tmp.dir), `nodrift-outside-${process.pid}.txt`);
    fs.writeFileSync(outside, OTHER);
    try {
      expect(issues(() => load(contract(`- { type: owner, value: "\${file:${outside}}" }`)))).toMatch(
        /outside the project directory/,
      );
      fs.symlinkSync(outside, path.join(tmp.dir, 'link.txt'));
      expect(issues(() => load(contract(`- { type: owner, value: "\${file:link.txt}" }`)))).toMatch(
        /outside the project directory/,
      );
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });
});

describe('imports, templates and presets', () => {
  it('merges imported networks, templates and contracts with their own relative paths', () => {
    tmp.write('shared/abi/Token.json', JSON.stringify({ abi: ['function cap() view returns (uint256)'] }));
    tmp.write(
      'shared/base.yaml',
      `${NETWORK}templates:\n  Capped:\n    abi: ./abi/Token.json\n    state:\n      - { type: variable, name: cap, value: 100 }\n`,
    );
    const config = load(
      `imports: [./shared/base.yaml]\ncontracts:\n  A:\n    address: "${ADDRESS}"\n    template: Capped\n    state:\n      - { type: owner, value: "${OTHER}" }\n`,
    );
    expect(config.networks[0].chainId).toBe(1);
    expect(config.checks.map((c) => c.key)).toEqual(['cap', 'owner()']);
  });

  it('detects import cycles and unknown templates', () => {
    tmp.write('cycle-a.yaml', 'imports: [./cycle-b.yaml]\n');
    tmp.write('cycle-b.yaml', 'imports: [./cycle-a.yaml]\n');
    expect(issues(() => loadConfig(path.join(tmp.dir, 'cycle-a.yaml'), { env: {}, roots: [tmp.dir] }))).toMatch(
      /Import cycle/,
    );
    expect(
      issues(() => load(contract('- { type: owner, value: "' + OTHER + '" }', '    template: Missing\n'))),
    ).toMatch(/unknown template 'Missing'/);
  });

  it('adds preset ABIs', () => {
    const config = load(contract('- { type: variable, name: decimals, value: 6 }', '    preset: erc20\n'));
    expect(config.checks[0]).toMatchObject({ key: 'decimals', expect: { expected: 6n } });
  });
});

describe('validation messages', () => {
  it('points at unknown keys with suggestions', () => {
    const error = issues(() => load(contract(`- { type: owner, expected: "${OTHER}" }`)));
    expect(error).toMatch(/contracts\.Token\.state\[0\]: unknown key 'expected' \(did you mean 'value'\?\)/);
    expect(issues(() => load(`${NETWORK}includes: []\ncontracts: {}\n`))).toMatch(
      /includes \(did you mean 'imports'\?\)/,
    );
  });

  it('lists valid state types', () => {
    expect(issues(() => load(contract('- { type: balance, value: 1 }')))).toMatch(
      /contracts\.Token\.state\[0\]\.type: must be one of owner, role/,
    );
  });

  it('rejects addresses with a bad checksum', () => {
    const typo = '0x5FbDB2315678afecb367f032d93F642f64180aA3';
    expect(issues(() => load(contract(`- { type: owner, value: "${OTHER}" }`, '', typo)))).toMatch(
      /contracts\.Token\.address: not a valid address \(check the EIP-55 checksum/,
    );
  });

  it('resolves functions against the ABI or a signature', () => {
    expect(issues(() => load(contract('- { type: function_call, function: cap, value: 1 }')))).toMatch(
      /function 'cap' is not in the ABI of Token/,
    );
    expect(issues(() => load(contract('- { type: function_call, function: "cap()", value: 1 }')))).toMatch(
      /must declare what it returns/,
    );
    const overloaded = `    abi:\n      - "function f(uint256) view returns (uint256)"\n      - "function f(address) view returns (uint256)"\n`;
    expect(
      issues(() => load(contract('- { type: function_call, function: f, args: [1, 2], value: 1 }', overloaded))),
    ).toMatch(/overloaded|takes 1 argument/);
    expect(
      issues(() =>
        load(
          contract('- { type: function_call, function: "balanceOf(address) returns (uint256)", args: [12], value: 1 }'),
        ),
      ),
    ).toMatch(/args\[0\]: 12 is not a valid address/);
  });

  it('types expected values against the ABI', () => {
    expect(
      issues(() =>
        load(contract('- { type: function_call, function: "totalSupply() returns (uint256)", value: "abc" }')),
      ),
    ).toMatch(/contracts\.Token\.state\[0\]\.value: expected an integer for uint256, got "abc"/);
    expect(
      issues(() =>
        load(
          contract('- { type: variable, name: "symbol() returns (string)", value: 1, options: { comparison: ">" } }'),
        ),
      ),
    ).toMatch(/> needs a numeric value/);
    expect(
      issues(() =>
        load(
          contract('- { type: variable, name: "symbol() returns (string)", value: X, options: { tolerance: "1%" } }'),
        ),
      ),
    ).toMatch(/tolerance: needs a numeric value/);
    expect(
      issues(() =>
        load(
          contract('- { type: variable, name: "cap() returns (uint256)", value: 1, options: { range: { min: 0 } } }'),
        ),
      ),
    ).toMatch(/use only one of value, options\.range/);
  });

  it('requires unique ids and keeps derived keys unique', () => {
    expect(
      issues(() =>
        load(
          contract(
            `- { id: a, type: owner, value: "${OTHER}" }\n- { id: a, type: variable, name: "cap() returns (uint256)", value: 1 }`,
          ),
        ),
      ),
    ).toMatch(/duplicate id 'a'/);
    const config = load(contract(`- { type: owner, value: "${OTHER}" }\n- { type: owner, value: "${OTHER}" }`));
    expect(config.checks.map((c) => c.key)).toEqual(['owner()', 'owner() #2']);
  });

  it('validates type-specific fields', () => {
    expect(
      issues(() => load(contract(`- { type: role, role: MINTER_ROLE, account: "${OTHER}", members: ["${OTHER}"] }`))),
    ).toMatch(/either 'account'/);
    expect(
      issues(() =>
        load(contract('- { type: variable, name: "cap() returns (uint256)", value: 1, options: { offset: 1 } }')),
      ),
    ).toMatch(/options\.offset: does not apply to variable checks/);
    expect(
      issues(() => load(contract('- { type: storage_slot, slot: 0, value: 1, options: { offset: 30, size: 4 } }'))),
    ).toMatch(/must fit in 32 bytes/);
    expect(
      issues(() =>
        load(contract('- { type: array_state, function: "cap() returns (uint256)", checks: { length: 1 } }')),
      ),
    ).toMatch(/does not return an array/);
    expect(issues(() => load(contract('- { type: proxy, checks: {} }')))).toMatch(/set at least one of implementation/);
    expect(issues(() => load(contract(`- { type: owner, value: "${OTHER}", options: { comparison: "!=" } }`)))).toMatch(
      /options\.comparison: does not apply to owner checks/,
    );
  });

  it('collects all problems before failing', () => {
    const error = caught(() =>
      load(
        contract(
          '- { type: function_call, function: nope, value: 1 }\n- { type: variable, name: "x() returns (bool)", value: maybe }',
        ),
      ),
    );
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).issues).toHaveLength(2);
  });
});

describe('verify options', () => {
  it('refuses a block number when several chains are configured', async () => {
    const config = load(
      `${NETWORK}contracts:\n  A:\n    address: "${ADDRESS}"\n    state:\n      - { type: owner, value: "${OTHER}" }\n  B:\n    address: "${ADDRESS}"\n    network: { rpc_url: "http://127.0.0.1:8546", chain_id: 10 }\n    state:\n      - { type: owner, value: "${OTHER}" }\n`,
    );
    await expect(verify(config, { block: 5 })).rejects.toThrow(/needs a single chain/);
  });
});
