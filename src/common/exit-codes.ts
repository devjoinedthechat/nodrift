/** Process exit codes for CI integration. */

import { ConfigurationError, ConnectionError, ValidationError } from './errors';
import type { VerificationResult } from '../verify';

export enum ExitCode {
  /** Every check passed (or drift was found without --fail-on-drift). */
  SUCCESS = 0,
  /** Drift detected and --fail-on-drift was set. */
  DRIFT = 1,
  /** The config file could not be read or resolved. */
  CONFIGURATION_ERROR = 2,
  /** An RPC endpoint was unreachable or on the wrong chain. */
  CONNECTION_ERROR = 3,
  /** One or more checks could not be evaluated. Never treated as success. */
  CHECK_ERROR = 4,
  /** The config failed schema validation. */
  VALIDATION_ERROR = 5,
  /** Unexpected internal error. */
  INTERNAL_ERROR = 6,
}

export function exitCodeForError(error: unknown): ExitCode {
  if (error instanceof ValidationError) return ExitCode.VALIDATION_ERROR;
  if (error instanceof ConfigurationError) return ExitCode.CONFIGURATION_ERROR;
  if (error instanceof ConnectionError) return ExitCode.CONNECTION_ERROR;
  return ExitCode.INTERNAL_ERROR;
}

export function exitCodeForResult(result: VerificationResult, failOnDrift: boolean): ExitCode {
  if (result.summary.errors > 0) return ExitCode.CHECK_ERROR;
  if (result.summary.drifted > 0 && failOnDrift) return ExitCode.DRIFT;
  return ExitCode.SUCCESS;
}
