/** Shared test helpers. */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Temporary directory for config files, removed by the returned cleanup function. */
export function tempDir(): { dir: string; write(name: string, text: string): string; cleanup(): void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodrift-'));
  return {
    dir,
    write(name, text) {
      const file = path.join(dir, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      return file;
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
