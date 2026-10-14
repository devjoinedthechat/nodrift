#!/usr/bin/env node
/** Command-line interface. */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { style } from './common/style';
import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { errorMessage, NodriftError } from './common/errors';
import { ExitCode, exitCodeForError, exitCodeForResult } from './common/exit-codes';
import { logger, setLogLevel } from './common/logger';
import { runInit } from './cli/init';
import { loadConfig } from './config/load';
import type { BlockSpec } from './config/normalize';
import { renderJson } from './output/json';
import { writeJUnit } from './output/junit';
import { renderPlan, renderText } from './output/text';
import { PRESETS } from './presets';
import { verify } from './verify';
import { VERSION } from './version';

interface CommonOptions {
  verbose?: boolean;
  envFile: boolean;
}

interface VerifyCliOptions extends CommonOptions {
  output: 'text' | 'json' | 'junit';
  junitFile: string;
  failOnDrift?: boolean;
  plan?: boolean;
  block?: BlockSpec;
  compactJson?: boolean;
  quiet?: boolean;
}

function parseBlock(value: string): BlockSpec {
  if (value === 'latest' || value === 'safe' || value === 'finalized') return value;
  if (/^\d+$/.test(value)) return Number(value);
  throw new InvalidArgumentError('expected a block number, latest, safe or finalized');
}

/** Load `.env` next to the config, else in the working directory. Existing variables win. */
function loadEnvFile(configFile: string): void {
  for (const dir of [path.dirname(path.resolve(configFile)), process.cwd()]) {
    const file = path.join(dir, '.env');
    if (fs.existsSync(file)) {
      process.loadEnvFile(file);
      logger.debug(`loaded environment from ${file}`);
      return;
    }
  }
}

function setup(file: string, options: CommonOptions): void {
  setLogLevel(options.verbose ? 'debug' : 'warn');
  if (options.envFile) loadEnvFile(file);
}

function fail(error: unknown, verbose?: boolean): ExitCode {
  const code = exitCodeForError(error);
  process.stderr.write(`${style.red('error:')} ${errorMessage(error)}\n`);
  if (!(error instanceof NodriftError)) {
    process.stderr.write(
      verbose && error instanceof Error && error.stack ? `${error.stack}\n` : 'Run with --verbose for details.\n',
    );
  }
  return code;
}

async function runVerify(file: string, options: VerifyCliOptions): Promise<ExitCode> {
  try {
    setup(file, options);
    const config = loadConfig(file);
    const result = await verify(config, { block: options.block });
    if (options.output === 'json') {
      process.stdout.write(`${renderJson(result, options.compactJson)}\n`);
    } else {
      const report = options.plan ? renderPlan(result) : renderText(result, { quiet: options.quiet });
      process.stdout.write(`${report}\n`);
      if (options.output === 'junit') {
        writeJUnit(result, options.junitFile);
        process.stdout.write(style.dim(`JUnit report written to ${options.junitFile}\n`));
      }
    }
    return exitCodeForResult(result, options.failOnDrift ?? false);
  } catch (error) {
    return fail(error, options.verbose);
  }
}

function runValidate(file: string, options: CommonOptions): ExitCode {
  try {
    setup(file, options);
    const config = loadConfig(file);
    const chains = [...new Set(config.networks.map((n) => n.chainId))].join(', ');
    process.stdout.write(
      `${style.green('✓')} ${file} is valid: ${config.contracts.length} contract(s), ` +
        `${config.checks.length} check(s), chain ${chains}\n`,
    );
    return ExitCode.SUCCESS;
  } catch (error) {
    return fail(error, options.verbose);
  }
}

export function buildProgram(): Command {
  const program = new Command()
    .name('nodrift')
    .description('Verify that deployed smart contract state matches a YAML config.')
    .version(VERSION)
    .showHelpAfterError()
    // Throw instead of exiting so usage errors get exit code 2 rather than 1 (drift).
    .exitOverride();

  program
    .command('verify', { isDefault: true })
    .description('read on-chain state and compare it with the config (default command)')
    .argument('<config>', 'path to the YAML config')
    .addOption(new Option('-o, --output <format>', 'report format').choices(['text', 'json', 'junit']).default('text'))
    .option('--junit-file <path>', 'where --output junit writes its report', 'test-results/nodrift-junit.xml')
    .option('--fail-on-drift', 'exit with code 1 when drift is found')
    .option('--plan', 'print a Terraform-style plan of drifted state')
    .option('--block <block>', 'block number or tag to read at (latest, safe, finalized)', parseBlock)
    .option('--compact-json', 'print JSON on a single line')
    .option('-q, --quiet', 'only print drift, errors and the summary')
    .option('-v, --verbose', 'log RPC activity to stderr')
    .option('--no-env-file', 'do not load a .env file')
    .action(async (file: string, options: VerifyCliOptions) => {
      process.exitCode = await runVerify(file, options);
    });

  program
    .command('validate')
    .description('check a config offline: schema, ABI lookups and value types')
    .argument('<config>', 'path to the YAML config')
    .option('-v, --verbose', 'show stack traces for unexpected errors')
    .option('--no-env-file', 'do not load a .env file')
    .action((file: string, options: CommonOptions) => {
      process.exitCode = runValidate(file, options);
    });

  program
    .command('init')
    .description('create a config interactively')
    .argument('[output]', 'file to write', 'nodrift.yaml')
    .action(async (output: string) => {
      try {
        await runInit(output);
      } catch (error) {
        // Ctrl+C or closed input while a prompt is open.
        if (error instanceof Error && error.name === 'ExitPromptError') {
          process.stderr.write('init cancelled\n');
          process.exitCode = 130;
          return;
        }
        process.exitCode = fail(error);
      }
    });

  program
    .command('presets')
    .description('list built-in ABI presets')
    .action(() => {
      for (const [name, preset] of Object.entries(PRESETS)) {
        process.stdout.write(`${style.cyan(name.padEnd(14))} ${preset.description}\n`);
      }
    });

  return program;
}

if (require.main === module) {
  buildProgram()
    .parseAsync()
    .catch((error: unknown) => {
      if (error instanceof CommanderError) {
        process.exitCode = error.exitCode === 0 ? ExitCode.SUCCESS : ExitCode.CONFIGURATION_ERROR;
        return;
      }
      process.exitCode = fail(error, true);
    });
}
