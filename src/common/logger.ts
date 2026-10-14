/** Minimal leveled logger. Writes to stderr so stdout stays machine-readable. */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

let current: LogLevel = 'warn';

export function setLogLevel(level: LogLevel): void {
  current = level;
}

function write(level: Exclude<LogLevel, 'silent'>, message: string): void {
  if (LEVELS[level] >= LEVELS[current]) {
    process.stderr.write(`[nodrift] ${level}: ${message}\n`);
  }
}

export const logger = {
  debug: (message: string) => write('debug', message),
  info: (message: string) => write('info', message),
  warn: (message: string) => write('warn', message),
  error: (message: string) => write('error', message),
};
