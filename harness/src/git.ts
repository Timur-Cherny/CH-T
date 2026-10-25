// Единственная точка обращения к git: только read-глаголы (I2). fetch — отдельная функция с явным именем,
// чтобы lint-тест видел его как единственное исключение. Всегда --no-optional-locks: сверка бежит рядом
// с чужими `git add`, и не имеет права ждать index.lock.
// Write verbs live outside, through spawnTool('git', …) in session/git-freshness.ts only: fetch and the local ff fetch.
import { spawnTool, spawnToolBytes } from './platform.ts';
import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

// A repository the agent writes may carry config that runs programs on read verbs (fsmonitor, external diff, textconv):
// hooks run outside the client's sandbox, so a read never executes what the tree configured.
const SAFE = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'];
const NO_EXTERNAL: ReadonlySet<string> = new Set(['diff', 'diff-index', 'show', 'log']);
const READ_VERBS = new Set(['status', 'blame', 'diff', 'diff-index', 'rev-parse', 'ls-files', 'log', 'show', 'rev-list', 'merge-base', 'cherry', 'branch', 'cat-file', 'config', 'for-each-ref', 'remote', 'ls-tree', 'worktree']);

export function git(cwd: string, args: string[], timeoutMs = 8000): { rc: number; stdout: string; stderr: string } {
  const verbAt = args.findIndex((a) => !a.startsWith('-'));
  const verb = verbAt >= 0 ? args[verbAt]! : '';
  if (!READ_VERBS.has(verb)) throw new Error(`git: глагол «${verb}» вне allowlist чтения`);
  if (verb === 'config' && !args.includes('--get') && !args.includes('--get-all')) throw new Error('git config: только --get');
  if (verb === 'worktree' && args[verbAt + 1] !== 'list') throw new Error('git worktree: только list');
  const hardened = NO_EXTERNAL.has(verb) ? [...args.slice(0, verbAt + 1), '--no-ext-diff', '--no-textconv', ...args.slice(verbAt + 1)] : args;
  return spawnTool('git', [...SAFE, ...hardened], { cwd, timeoutMs });
}

/** Blob texts by object id through `git cat-file --batch`, one process per CHUNK ids instead of one per blob. An id git
 *  reports missing, or a chunk that fails as a whole, is left out: the caller reads those one by one and owns the error. */
export function catBlobs(repo: string, oids: readonly string[], chunk = 400): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < oids.length; i += chunk) {
    const part = oids.slice(i, i + chunk);
    const r = spawnToolBytes('git', [...SAFE, 'cat-file', '--batch'], { cwd: repo, timeoutMs: 60000, input: part.map((o) => `${o}\n`).join('') });
    if (r.rc !== 0) continue;
    for (let at = 0; at < r.stdout.length;) {
      const eol = r.stdout.indexOf(10, at);
      if (eol < 0) break;
      const [oid, type, size] = r.stdout.subarray(at, eol).toString('utf8').split(' ');
      at = eol + 1;
      if (type === undefined || size === undefined) continue;
      const end = at + Number(size);
      if (type === 'blob') out.set(oid, r.stdout.subarray(at, end).toString('utf8'));
      at = end + 1;
    }
  }
  return out;
}

/** The object ids of `oids` the repository holds — committed, staged or stashed content, one `cat-file --batch-check`.
 *  Null — git did not answer, and the caller cannot tell a backup from a committed version. */
export function objectsExist(repo: string, oids: readonly string[], timeoutMs = 8000): Set<string> | null {
  if (!oids.length) return new Set();
  const r = spawnTool('git', ['--no-optional-locks', 'cat-file', '--batch-check'], { cwd: repo, timeoutMs, input: oids.map((o) => `${o}\n`).join('') });
  if (r.rc !== 0) return null;
  return new Set(r.stdout.split('\n').filter((l) => / (blob|tree|commit|tag) \d+$/.test(l)).map((l) => l.split(' ')[0]));
}

export function toplevel(cwd: string): string | null {
  try { if (!statSync(cwd).isDirectory()) return null; } catch { return null; }
  const r = git(cwd, ['rev-parse', '--show-toplevel'], 3000);
  return r.rc === 0 ? r.stdout.trim() : null;
}

export function head(repo: string): string | null {
  const r = git(repo, ['rev-parse', 'HEAD'], 3000);
  return r.rc === 0 ? r.stdout.trim() : null;
}

/** Dependency trees are not authored, whatever the repository ignores: `node_modules` at any depth and a macOS copy of one,
 * which Finder and iCloud name by a suffix after a space (` 2`, ` copy`, a time of day). A .gitignore naming the exact
 * directory misses the copies, and their files then crowded the authored ones out of the sweep. A glob pathspec does
 * not reach into a directory it names, hence the `/**` twin of each. */
const VENDORED_TREES = ['node_modules', 'node_modules *'].flatMap((d) => [`**/${d}`, `**/${d}/**`]).map((g) => `:(top,exclude,glob)${g}`);

export interface StatusEntry { xy: string; path: string }

/** `git status --porcelain -z -uall`: -uall обязателен (без него новый каталог схлопывается в одну строку `?? dir/`). */
export function status(repo: string): StatusEntry[] | null {
  const r = git(repo, ['status', '--porcelain', '-z', '-uall', '--', ...VENDORED_TREES], 15000);
  if (r.rc !== 0) return null;
  const out: StatusEntry[] = [];
  const parts = r.stdout.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e) continue;
    const xy = e.slice(0, 2); const path = e.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C') i++; // вторая запись — старое имя
    out.push({ xy, path });
  }
  return out;
}

/** Null when git did not answer: a range that could not be read is not an empty one. */
export function diffNames(repo: string, from: string, to: string): string[] | null {
  const r = git(repo, ['diff', '--name-only', `${from}..${to}`, '--', ...VENDORED_TREES], 8000);
  return r.rc === 0 ? r.stdout.split('\n').filter(Boolean) : null;
}

export function commitExists(repo: string, rev: string): boolean {
  return git(repo, ['cat-file', '-e', `${rev}^{commit}`], 3000).rc === 0;
}

export function gitDirMtime(repo: string): number {
  try { return statSync(join(repo, '.git')).mtimeMs; } catch { return 0; }
}

/** The worktree's own git directory: `.git` itself, or the gitdir a linked worktree's `.git` file names. No git spawned. */
function ownGitDir(root: string): string | null {
  const dotGit = join(root, '.git');
  try {
    if (statSync(dotGit).isDirectory()) return dotGit;
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
    return m ? resolve(root, m[1].trim()) : null;
  } catch { return null; }
}

/** mtime of this worktree's own HEAD reflog: git appends to it on every move of HEAD, so a stat answers
 * "did HEAD move since t" without spawning git. */
export function headLogMtime(root: string): number | null {
  const dir = ownGitDir(root);
  try { return dir ? statSync(join(dir, 'logs', 'HEAD')).mtimeMs : null; } catch { return null; }
}

/** The directory all worktrees of a repository share (objects, branches): `<common>/worktrees/<name>` → `<common>`. */
export function gitCommonDir(root: string): string | null {
  const dir = ownGitDir(root);
  return dir && basename(dirname(dir)) === 'worktrees' ? dirname(dirname(dir)) : dir;
}
