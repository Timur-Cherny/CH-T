// Единственная точка обращения к git: только read-глаголы (I2). fetch — отдельная функция с явным именем,
// чтобы lint-тест видел его как единственное исключение. Всегда --no-optional-locks: сверка бежит рядом
// с чужими `git add`, и не имеет права ждать index.lock.
// Write verbs live outside, through spawnTool('git', …) in session/git-freshness.ts only: fetch and the local ff fetch.
import { spawnTool } from './platform.ts';
import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const READ_VERBS = new Set(['status', 'diff', 'diff-index', 'rev-parse', 'ls-files', 'log', 'show', 'rev-list', 'merge-base', 'cherry', 'branch', 'cat-file', 'config', 'for-each-ref', 'remote']);

export function git(cwd: string, args: string[], timeoutMs = 8000): { rc: number; stdout: string; stderr: string } {
  const verb = args.find((a) => !a.startsWith('-')) ?? '';
  if (!READ_VERBS.has(verb)) throw new Error(`git: глагол «${verb}» вне allowlist чтения`);
  if (verb === 'config' && !args.includes('--get') && !args.includes('--get-all')) throw new Error('git config: только --get');
  return spawnTool('git', ['--no-optional-locks', ...args], { cwd, timeoutMs });
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

export interface StatusEntry { xy: string; path: string }

/** `git status --porcelain -z -uall`: -uall обязателен (без него новый каталог схлопывается в одну строку `?? dir/`). */
export function status(repo: string): StatusEntry[] | null {
  const r = git(repo, ['status', '--porcelain', '-z', '-uall'], 15000);
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

export function diffNames(repo: string, from: string, to: string): string[] {
  const r = git(repo, ['diff', '--name-only', `${from}..${to}`], 8000);
  return r.rc === 0 ? r.stdout.split('\n').filter(Boolean) : [];
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
