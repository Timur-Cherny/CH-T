// The one answer to «was this module started as the program?» for every entry point of the harness.
// Both sides go through realpath: ~/.claude/harness is a symlink to the repository, import.meta.url is always the
// real path and argv[1] is the path as typed — compared raw, they differ, main() is skipped, and the process ends
// with rc 0 and no output. For tools whose contract is «silence means nothing to report» that is a false all-clear.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isMainModule(metaUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (!argv1) return false;
  try { return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argv1); } catch { return false; }
}
