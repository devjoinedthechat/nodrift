import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const CLI = path.resolve(__dirname, '../../src/cli.ts');
const TSX = pathToFileURL(require.resolve('tsx')).href;

function cli(...args: string[]) {
  return spawnSync(process.execPath, ['--import', TSX, CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
}

describe('command-line usage', () => {
  it('exits 0 for --version and --help', () => {
    expect(cli('--version')).toMatchObject({ status: 0, stdout: expect.stringMatching(/^\d+\.\d+\.\d+/) });
    expect(cli('--help')).toMatchObject({ status: 0, stdout: expect.stringContaining('Usage: nodrift') });
  });

  it.each([
    [['verify']],
    [['validate']],
    [['x.yaml', '--bogus']],
    [['x.yaml', '--block', 'abc']],
    [['x.yaml', '-o', 'xml']],
  ])('exits 2, not the drift code, for invalid arguments: %j', (args) => {
    const run = cli(...args);
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/error:/);
  });
});
