/** Library entry point. The CLI is a thin layer over these functions. */

export { VERSION } from './version';

export { loadConfig, loadRawConfig, type LoadOptions } from './config/load';
export {
  normalize,
  type BlockSpec,
  type Check,
  type ContractInfo,
  type NetworkSettings,
  type NormalizedConfig,
} from './config/normalize';
export {
  ConfigSchema,
  StateEntrySchema,
  type Metric,
  type Operator,
  type RawConfig,
  type RawStateEntry,
  type StateType,
} from './config/schema';

export {
  verify,
  verifyFile,
  type NetworkReport,
  type Summary,
  type VerificationResult,
  type VerifyOptions,
} from './verify';
export type { CheckResult, CheckStatus } from './check/evaluate';
export type { Typed } from './check/values';

export { renderText, renderPlan, summaryLine } from './output/text';
export { renderJson } from './output/json';
export { renderJUnit, writeJUnit } from './output/junit';

export { ExitCode, exitCodeForError, exitCodeForResult } from './common/exit-codes';
export { CheckError, ConfigurationError, ConnectionError, NodriftError, ValidationError } from './common/errors';
export { PRESETS, type Preset } from './presets';
