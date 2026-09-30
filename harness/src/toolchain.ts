// Тулчейн харнесса вне рабочих деревьев. TypeScript нужен гейтам и проверкам как парсер (К1). Пин на
// node_modules чужого воркtree гниёт молча: дерево сносят, а гейты отвечают unknown в каждой сессии.
// Версия и хеши — в TOOLCHAIN.lock, файлы — в кеше пользователя, ставит их scripts/toolchain.ts.
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HARNESS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

export interface ToolchainLock {
  typescript: { version: string; tarball: string; integrity: string; entry: string; entry_sha256: string };
}

export function readLock(root: string = HARNESS_DIR): ToolchainLock {
  return JSON.parse(readFileSync(join(root, 'TOOLCHAIN.lock'), 'utf8')) as ToolchainLock;
}

/** Явный CLAUDE_HARNESS_TOOLCHAIN, иначе кеш под HOME окружения; без HOME каталога нет. */
export function toolchainDir(env: NodeJS.ProcessEnv): string | null {
  if (env.CLAUDE_HARNESS_TOOLCHAIN) return env.CLAUDE_HARNESS_TOOLCHAIN;
  return env.HOME ? join(env.HOME, '.cache', 'claude-harness', 'toolchain') : null;
}

export function typescriptEntry(env: NodeJS.ProcessEnv, root: string = HARNESS_DIR): string | null {
  const dir = toolchainDir(env);
  if (!dir) return null;
  const t = readLock(root).typescript;
  return join(dir, `typescript@${t.version}`, t.entry);
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

export function verifyTypescript(env: NodeJS.ProcessEnv, root: string = HARNESS_DIR): Verification {
  const r = resolveTypescript(env, root);
  if (!r.path) return { ok: false, reason: r.reason };
  const want = readLock(root).typescript.entry_sha256;
  const got = sha256File(r.path);
  if (got === want) return { ok: true, path: r.path };
  return { ok: false, reason: `тулчейн харнесса: ${r.path} не совпадает с TOOLCHAIN.lock (sha256 ${got.slice(0, 12)}… ≠ ${want.slice(0, 12)}…) — ~/.claude/harness/bin/run scripts/toolchain.ts --install` };
}
