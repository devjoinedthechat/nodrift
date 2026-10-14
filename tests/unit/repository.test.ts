/** Keeps the published artifacts consistent with the code: version, JSON schema, examples and docs. */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildJsonSchema, SCHEMA_PATH } from '../../scripts/generate-schema';
import { loadConfig } from '../../src/config/load';
import { StateEntrySchema } from '../../src/config/schema';
import { parseYaml } from '../../src/config/yaml';
import { VERSION } from '../../src/version';
import { tempDir } from '../helpers';

const ROOT = path.resolve(__dirname, '../..');

/** Deterministic stand-ins for the variables used in docs and examples. */
const env = new Proxy({} as NodeJS.ProcessEnv, {
  get: (_target, name) => {
    const key = String(name);
    if (/RPC|URL/.test(key)) return 'https://rpc.example';
    if (/CHAIN/.test(key)) return '1';
    if (
      /ADDRESS|OWNER|ADMIN|MULTISIG|TREASURY|MINTER|IMPLEMENTATION|ACCOUNT|USER|VAULT|TOKEN|SAFE|GUARDIAN|SPENDER/.test(
        key,
      )
    ) {
      return '0x000000000000000000000000000000000000dEaD';
    }
    return '1';
  },
});

function files(dir: string, extension: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? files(full, extension) : full.endsWith(extension) ? [full] : [];
  });
}

function yamlBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```ya?ml\n([\s\S]*?)```/g)].map((m) => m[1]);
}

it('keeps VERSION in sync with package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  expect(VERSION).toBe(pkg.version);
});

it('has an up-to-date nodrift.schema.json (run `npm run schema`)', () => {
  expect(fs.readFileSync(SCHEMA_PATH, 'utf8')).toBe(buildJsonSchema());
});

describe('examples', () => {
  const examples = files(path.join(ROOT, 'examples'), '.yaml');

  it('exist', () => {
    expect(examples.length).toBeGreaterThan(0);
  });

  it.each(examples.map((f) => [path.relative(ROOT, f)]))('%s is valid', (relative) => {
    const config = loadConfig(path.join(ROOT, relative), { env, roots: [ROOT] });
    expect(config.checks.length).toBeGreaterThan(0);
  });
});

describe('documentation snippets', () => {
  const docs = [path.join(ROOT, 'README.md'), ...files(path.join(ROOT, 'docs'), '.md')];
  const tmp = tempDir();
  afterAll(() => tmp.cleanup());

  const cases = docs.flatMap((doc) =>
    yamlBlocks(fs.readFileSync(doc, 'utf8')).map(
      (block, i) => [`${path.relative(ROOT, doc)} #${i + 1}`, block] as const,
    ),
  );

  it.each(cases.filter(([, block]) => /^contracts:/m.test(block)))('%s is a valid config', (name, block) => {
    // Snippets that focus on contracts may leave out the network section.
    const full = /^(network|imports):/m.test(block)
      ? block
      : `network:\n  rpc_url: \${RPC_URL}\n  chain_id: 1\n${block}`;
    const file = tmp.write(`${name.replace(/[^a-z0-9]+/gi, '-')}.yaml`, full);
    expect(() => loadConfig(file, { env, roots: [tmp.dir, ROOT] })).not.toThrow();
  });

  it.each(cases.filter(([, block]) => /^- type:/m.test(block) && !/^contracts:/m.test(block)))(
    '%s uses valid state entries',
    (_name, block) => {
      const entries = parseYaml(block, 'snippet.yaml') as unknown[];
      for (const entry of entries) {
        const parsed = StateEntrySchema.safeParse(entry);
        if (!parsed.success) throw new Error(`${JSON.stringify(entry)}\n${parsed.error.message}`);
      }
    },
  );
});
