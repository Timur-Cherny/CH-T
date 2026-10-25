// The harness toolchain lives outside working trees: TypeScript as the parser of gates and checks (ADR v4, K1) and,
// with the declarations of @types/node, the compiler of the harness's own tsconfig.json. A pin into another worktree's
// node_modules rots silently: the tree is removed and the gates answer unknown in every session. Versions and hashes
// are in TOOLCHAIN.lock; the files sit in the user cache as a node_modules tree named by the lock's sha256, so two
// worktrees with different locks never share a tree; scripts/toolchain.ts installs it and writes INSTALLED_MARKER last.
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HARNESS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const INSTALLED_MARKER = '.installed';

export interface LockedPackage { version: string; tarball: string; integrity: string; files?: string[] }

export interface ToolchainLock {
  typescript: LockedPackage & { entry: string; entry_sha256: string };
  types: Record<string, LockedPackage>;
}

export function readLock(root: string = HARNESS_DIR): ToolchainLock {
  return JSON.parse(readFileSync(join(root, 'TOOLCHAIN.lock'), 'utf8')) as ToolchainLock;
}

export function lockDigest(root: string = HARNESS_DIR): string {
  return createHash('sha256').update(readFileSync(join(root, 'TOOLCHAIN.lock'))).digest('hex');
}

/** Явный CLAUDE_HARNESS_TOOLCHAIN, иначе кеш под HOME окружения; без HOME каталога нет. */
export function toolchainDir(env: NodeJS.ProcessEnv): string | null {
  if (env.CLAUDE_HARNESS_TOOLCHAIN) return env.CLAUDE_HARNESS_TOOLCHAIN;
  return env.HOME ? join(env.HOME, '.cache', 'claude-harness', 'toolchain') : null;
}

/** The directory holding node_modules/ of this lock's packages. */
export function toolchainRoot(env: NodeJS.ProcessEnv, root: string = HARNESS_DIR): string | null {
  const dir = toolchainDir(env);
  return dir ? join(dir, `typescript@${readLock(root).typescript.version}-${lockDigest(root).slice(0, 12)}`) : null;
}

export function typescriptEntry(env: NodeJS.ProcessEnv, root: string = HARNESS_DIR): string | null {
  const tree = toolchainRoot(env, root);
  return tree ? join(tree, readLock(root).typescript.entry) : null;
}

export type Resolution = { path: string } | { path: null; reason: string };

export function resolveTypescript(env: NodeJS.ProcessEnv, root: string = HARNESS_DIR): Resolution {
  const t = readLock(root).typescript;
  const entry = typescriptEntry(env, root);
  if (entry && existsSync(entry)) return { path: entry };
  const where = entry ? ` (${entry})` : ' (нет HOME и CLAUDE_HARNESS_TOOLCHAIN)';
  return { path: null, reason: `тулчейн харнесса: typescript@${t.version} не установлен${where} — ~/.claude/harness/bin/run scripts/toolchain.ts --install` };
}

export function sha256File(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

export type Verification = { ok: true; path: string } | { ok: false; reason: string };

/** The entry matches the lock's sha256 and the whole tree of this lock finished installing. */
export function verifyTypescript(env: NodeJS.ProcessEnv, root: string = HARNESS_DIR): Verification {
  const r = resolveTypescript(env, root);
  if (r.path === null) return { ok: false, reason: r.reason };
  const want = readLock(root).typescript.entry_sha256;
  const got = sha256File(r.path);
  if (got !== want) return { ok: false, reason: `тулчейн харнесса: ${r.path} не совпадает с TOOLCHAIN.lock (sha256 ${got.slice(0, 12)}… ≠ ${want.slice(0, 12)}…) — ~/.claude/harness/bin/run scripts/toolchain.ts --install` };
  const marker = join(toolchainRoot(env, root)!, INSTALLED_MARKER);
  let mark = '';
  try { mark = readFileSync(marker, 'utf8').trim(); } catch { mark = ''; }
  if (mark !== lockDigest(root)) return { ok: false, reason: `тулчейн харнесса: установка не завершена (нет ${marker}) — ~/.claude/harness/bin/run scripts/toolchain.ts --install` };
  return { ok: true, path: r.path };
}
