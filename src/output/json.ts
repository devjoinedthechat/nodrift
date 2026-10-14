/** JSON report. Integers are written as decimal strings so no consumer loses precision. */

import { jsonReplacer } from '../check/values';
import type { VerificationResult } from '../verify';

export function renderJson(result: VerificationResult, compact = false): string {
  return JSON.stringify(result, jsonReplacer, compact ? undefined : 2);
}
