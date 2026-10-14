/** File references in configs are confined to trusted directories. */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ConfigurationError } from '../common/errors';

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Resolve `ref` relative to `baseDir` and require the real path (symlinks followed) to be
 * inside one of `roots`. This stops a config from reading files such as ~/.ssh/id_rsa or
 * /proc/self/environ and echoing them into reports.
 */
export function resolveConfinedPath(ref: string, baseDir: string, roots: readonly string[], what: string): string {
  const resolved = path.resolve(baseDir, ref);
  let real: string;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    throw new ConfigurationError(`${what} not found: ${ref} (resolved to ${resolved})`);
  }
  const realRoots = roots.map((root) => {
    try {
      return fs.realpathSync(root);
    } catch {
      return path.resolve(root);
    }
  });
  if (!realRoots.some((root) => isInside(real, root))) {
    throw new ConfigurationError(
      `${what} ${ref} is outside the project directory. ` +
        `Only files under ${realRoots.join(' or ')} can be referenced.`,
    );
  }
  return real;
}
