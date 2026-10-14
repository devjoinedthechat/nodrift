/** Error types. Each maps to a distinct CLI exit code (see exit-codes.ts). */

export class NodriftError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The config file cannot be read, parsed, or resolved (missing file, env var, import, ABI). */
export class ConfigurationError extends NodriftError {}

/** The config was read but does not satisfy the schema or contains invalid values. */
export class ValidationError extends NodriftError {
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(issues.length > 0 ? `${message}\n  - ${issues.join('\n  - ')}` : message);
    this.issues = issues;
  }
}

/** An RPC endpoint is unreachable or reports a different chain than configured. */
export class ConnectionError extends NodriftError {}

/** A single check could not be evaluated (revert, undecodable return data, missing code). */
export class CheckError extends NodriftError {}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
