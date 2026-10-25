// migration-name — контракт имени миграции: имя файла задаёт порядок применения, имя класса и поле `name`
// задают запись в таблице migrations. Разошлись — порядок и учёт применённого расходятся тоже.
// Круглый timestamp (пять нулей на конце) назначен вручную «с запасом от соседей»: две ветки независимо
// приходят к одному значению, поэтому число обязано быть снятым.
//
// Regex — только по имени файла и строке цифр (грамматики там нет). Класс и поле `name` берутся из AST:
// текстовый поиск считает совпадением `name = '...'` внутри SQL-строки. Нет typescript рядом с файлом →
// `unknown` с причиной, не pass.
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { register } from './registry.ts';
import { loadTypescript, parseSource, type TsModule } from '../parsers/ts.ts';
import { git } from '../git.ts';
import type { GateContext, PreToolUsePayload, Verdict } from '../types.ts';
import type * as TS from 'typescript';

export const NAME = 'migration-name';
export const KILL = 'CLAUDE_SKIP_MIGRATION_NAME_GUARD';

const IN_MIGRATIONS = /(^|\/)migrations?\//;
const FILE_FORM = /^(\d{13})-([a-z0-9]+(?:-[a-z0-9]+)*)\.ts$/;
const KNEX_FORM = /^\d{14}_[a-z0-9_]+\.(ts|js)$/i;
const MAIN_DEV = /^(?:[A-Za-z0-9._-]+\/)?(main|dev)$/;

const SILENT: Verdict = { kind: 'silent' };
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

interface GitOk { ok: true; stdout: string }
interface GitBad { ok: false; reason: string }
type GitResult = GitOk | GitBad;
interface MigrationEntry { stamp: string; relPath: string; where: string; mainDev: boolean }
interface Inventory { repo: string; dirRel: string; fileRel: string; entries: MigrationEntry[] }

function gitRead(cwd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 5000): GitResult {
  void env;
  const r = git(cwd, args, timeoutMs);
  if (r.rc === 0) return { ok: true, stdout: r.stdout };
  const msg = (r.stderr || r.stdout || `exit ${r.rc}`).split('\n')[0];
  return { ok: false, reason: `git ${args.join(' ')}: ${msg}` };
}

function existingDir(start: string): string | null {
  let d = start;
  for (;;) {
    try { if (statSync(d).isDirectory()) return d; } catch {}
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

function migrationDirAbs(fileAbs: string): string | null {
  const parts = dirname(fileAbs).split('/');
  let at = -1;
  for (let i = parts.length - 1; i >= 0; i--) if (/^migrations?$/.test(parts[i] ?? '')) { at = i; break; }
  return at < 0 ? null : (parts.slice(0, at + 1).join('/') || '/');
}

/** The directory sets the convention: knex orders by its own `YYYYMMDDHHMMSS_name` stamp, where the TypeORM form would break ordering. */
function knexDirectory(dirAbs: string): boolean {
  let names: string[];
  try { names = readdirSync(dirAbs, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name); }
  catch { return false; }
  return names.some((n) => KNEX_FORM.test(n)) && !names.some((n) => FILE_FORM.test(n));
}

function rel(root: string, path: string): string { return relative(root, path).split('/').join('/'); }
function shortRef(ref: string): string { return ref.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\//, ''); }
function branchPart(ref: string): string {
  const s = shortRef(ref);
  return ref.startsWith('refs/remotes/') ? s.split('/').slice(1).join('/') : s;
}
function isMainDevRef(ref: string): boolean { return MAIN_DEV.test(branchPart(ref)); }
function nextHint(repo: string, dirRel: string): string {
  return `~/.claude/harness/bin/run scripts/next-migration-stamp.ts --repo ${repo} --dir ${dirRel}`;
}

function refEntries(repo: string, ref: string, dirRel: string, env: NodeJS.ProcessEnv): GitResult | { ok: true; entries: MigrationEntry[] } {
  const tree = gitRead(repo, ['ls-tree', '-r', '--name-only', ref, '--', dirRel], env);
  if (!tree.ok) return tree;
  const where = ref === 'HEAD' ? 'HEAD' : shortRef(ref);
  const mainDev = ref !== 'HEAD' && isMainDevRef(ref);
  const entries = tree.stdout.split('\n').filter(Boolean).map((p) => {
    const m = FILE_FORM.exec(basename(p));
    return m ? { stamp: m[1]!, relPath: p, where: `ref ${where}`, mainDev } : null;
  }).filter((e): e is MigrationEntry => e !== null);
  return { ok: true, entries };
}

function branchLogEntries(repo: string, dirRel: string, env: NodeJS.ProcessEnv): GitResult | { ok: true; entries: MigrationEntry[] } {
  const log = gitRead(repo, ['log', '--branches', '--source', '--format=>%S', '--name-only', '--diff-filter=AR', '--', dirRel], env);
  if (!log.ok) return log;
  const entries: MigrationEntry[] = [];
  let source: string | null = null;
  for (const line of log.stdout.split('\n')) {
    if (!line) continue;
    if (line.startsWith('>')) {
      source = line.slice(1);
      continue;
    }
    const m = FILE_FORM.exec(basename(line));
    if (m && source) {
      // Local branch history is intentionally sticky: a once-added stamp stays taken after a rename.
      entries.push({ stamp: m[1]!, relPath: line, where: `ref ${shortRef(source)}`, mainDev: false });
    }
  }
  return { ok: true, entries };
}

function worktreeEntries(repo: string, dirRel: string, env: NodeJS.ProcessEnv): GitResult | { ok: true; entries: MigrationEntry[] } {
  const listed = gitRead(repo, ['worktree', 'list', '--porcelain'], env);
  if (!listed.ok) return listed;
  const entries: MigrationEntry[] = [];
  for (const line of listed.stdout.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const root = line.slice('worktree '.length);
    const dir = join(root, dirRel);
    let names: string[];
    try { names = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return { ok: false, reason: `readdir ${dir}: ${(e as Error).message}` };
    }
    for (const name of names) {
      const m = FILE_FORM.exec(name);
      if (m) entries.push({ stamp: m[1]!, relPath: `${dirRel}/${name}`, where: `worktree ${root}`, mainDev: false });
    }
  }
  return { ok: true, entries };
}

export function migrationInventory(filePath: string, cwd: string, env: NodeJS.ProcessEnv): GitResult | { ok: true; inventory: Inventory } {
  const fileAbs = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath);
  const dirAbs = migrationDirAbs(fileAbs);
  if (!dirAbs) return { ok: false, reason: `${filePath}: каталог migrations не найден` };
  const anchor = existingDir(dirAbs) ?? existingDir(dirname(fileAbs));
  if (!anchor) return { ok: false, reason: `${filePath}: нет существующего каталога для git` };
  const top = gitRead(anchor, ['rev-parse', '--show-toplevel'], env, 3000);
  if (!top.ok) return top;
  const repo = top.stdout.trim();
  const realDirAbs = (() => { try { return realpathSync(dirAbs); } catch { return dirAbs; } })();
  const realFileAbs = resolve(realDirAbs, relative(dirAbs, fileAbs));
  const dirRel = rel(repo, realDirAbs);
  const fileRel = rel(repo, realFileAbs);
  const entries: MigrationEntry[] = [];

  const head = refEntries(repo, 'HEAD', dirRel, env);
  if (!head.ok) return head;
  entries.push(...head.entries);

  const refs = gitRead(repo, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'], env, 5000);
  if (!refs.ok) return refs;
  const mainDevRefs = refs.stdout.split('\n').filter(Boolean).filter(isMainDevRef).sort();
  for (const ref of mainDevRefs) {
    const got = refEntries(repo, ref, dirRel, env);
    if (!got.ok) return got;
    entries.push(...got.entries);
  }

  const branches = branchLogEntries(repo, dirRel, env);
  if (!branches.ok) return branches;
  entries.push(...branches.entries);

  const wts = worktreeEntries(repo, dirRel, env);
  if (!wts.ok) return wts;
  entries.push(...wts.entries);
  return { ok: true, inventory: { repo, dirRel, fileRel, entries } };
}

export function nextFreeMigrationStamp(repo: string, dirRel: string, env: NodeJS.ProcessEnv = process.env): GitResult | { ok: true; stamp: string } {
  const fake = join(repo, dirRel, '0000000000000-next.ts');
  const inv = migrationInventory(fake, repo, env);
  if (!inv.ok) return inv;
  const max = inv.inventory.entries.reduce((m, e) => Math.max(m, Number(e.stamp)), 0);
  return { ok: true, stamp: String(max + 1).padStart(13, '0') };
}

/** Текст, который БУДЕТ записан. Для Edit/MultiEdit — только добавляемые куски: остальной файл не меняется. */
export function writtenText(p: PreToolUsePayload): { kind: 'text'; text: string } | { kind: 'unknown'; reason: string } {
  const ti = p.tool_input ?? {};
  if (p.tool_name === 'Write') {
    const content = str(ti.content);
    return content === null ? { kind: 'unknown', reason: 'Write без content — что ляжет в файл, неизвестно' } : { kind: 'text', text: content };
  }
  if (p.tool_name === 'MultiEdit') {
    const edits = Array.isArray(ti.edits) ? ti.edits : null;
    if (!edits) return { kind: 'unknown', reason: 'MultiEdit без edits — что ляжет в файл, неизвестно' };
    return { kind: 'text', text: edits.map((e) => str((e as Record<string, unknown>)?.new_string) ?? '').join('\n') };
  }
  const newStr = str(ti.new_string);
  return newStr === null ? { kind: 'unknown', reason: 'Edit без new_string — что ляжет в файл, неизвестно' } : { kind: 'text', text: newStr };
}

export interface Identifiers { cls: string | null; name: string | null }

/** Имя класса миграции и значение поля `name` из AST. Форма `name = '...'` вне класса — тоже присваивание,
 *  а не строка: фрагмент Edit разбирается так же, как целый файл. Литерал внутри SQL-строки сюда не попадает. */
export function identifiers(ts: TsModule, sf: TS.SourceFile): Identifiers {
  let cls: string | null = null;
  let name: string | null = null;
  const literal = (n: TS.Node | undefined): string | null =>
    n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null;
  const visit = (node: TS.Node): void => {
    if (ts.isClassDeclaration(node) && node.name && cls === null) cls = node.name.text;
    if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'name' && name === null) {
      name = literal(node.initializer);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && name === null) {
      const lhs = node.left;
      const isName = (ts.isIdentifier(lhs) && lhs.text === 'name')
        || (ts.isPropertyAccessExpression(lhs) && lhs.name.text === 'name');
      if (isName) name = literal(node.right);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return { cls, name };
}

const expectedClass = (slug: string, stamp: string): string =>
  slug.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('') + stamp;

export function decide(ctx: GateContext): Verdict {
  const p = ctx.payload as PreToolUsePayload;
  if (ctx.event !== 'pre-write' || p.hook_event_name !== 'PreToolUse') return SILENT;
  if (p.tool_name !== 'Write' && p.tool_name !== 'Edit' && p.tool_name !== 'MultiEdit') return SILENT;
  const path = str(p.tool_input?.file_path) ?? '';
  if (!IN_MIGRATIONS.test(path) || !path.endsWith('.ts')) return SILENT;
  const cwdForDir = str((p as unknown as { cwd?: unknown }).cwd) ?? process.cwd();
  if (knexDirectory(dirname(isAbsolute(path) ? resolve(path) : resolve(cwdForDir, path)))) return SILENT;

  const base = basename(path);
  const form = FILE_FORM.exec(base);
  if (!form) {
    return { kind: 'deny', gate: NAME, reason: `имя файла «${base}» не в форме <timestamp13>-<kebab-name>.ts — TypeORM сортирует миграции по этому числу` };
  }
  const [, stamp, slug] = form;
  const problems: string[] = [];

  const written = writtenText(p);
  if (written.kind === 'unknown') return { kind: 'unknown', gate: NAME, reason: written.reason };

  const loaded = loadTypescript(path, ctx.env);
  if (!loaded.ts) {
    // Имя файла проверено, содержимое — нет. Молчать нельзя: половина контракта осталась недоказанной.
    const tail = `класс и поле name не проверены: ${loaded.missing_reason}`;
    return problems.length
      ? { kind: 'deny', gate: NAME, reason: `${base}: ${problems.join('; ')} (${tail})` }
      : { kind: 'unknown', gate: NAME, reason: `${base}: ${tail}` };
  }
  const { cls, name } = identifiers(loaded.ts, parseSource(loaded.ts, written.text, base).sf);
  if (cls !== null && !cls.endsWith(stamp)) problems.push(`класс «${cls}» не оканчивается на ${stamp} из имени файла`);
  if (name !== null && !name.endsWith(stamp)) problems.push(`поле name «${name}» не оканчивается на ${stamp} из имени файла`);
  const want = expectedClass(slug, stamp);
  if (cls !== null && cls !== want && cls.endsWith(stamp)) problems.push(`класс «${cls}» не совпадает с именем файла (ожидается «${want}»)`);

  if (problems.length) return { kind: 'deny', gate: NAME, reason: `${base}: ${problems.join('; ')}` };

  const cwd = str((p as unknown as { cwd?: unknown }).cwd) ?? process.cwd();
  const fileAbs = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  if (existsSync(fileAbs)) return SILENT;

  const inv = migrationInventory(path, cwd, ctx.env);
  if (!inv.ok) return { kind: 'unknown', gate: NAME, reason: `${base}: collision/ordering не проверены: ${inv.reason}` };
  if (inv.inventory.entries.some((e) => e.where === 'ref HEAD' && e.relPath === inv.inventory.fileRel)) return SILENT;

  const hint = nextHint(inv.inventory.repo, inv.inventory.dirRel);
  const collision = inv.inventory.entries.find((e) => e.stamp === stamp && basename(e.relPath) !== base);
  if (collision) {
    return {
      kind: 'deny',
      gate: NAME,
      reason: `${base}: stamp ${stamp} уже занят другим именем: ${collision.relPath} (${collision.where}). Следующий свободный: ${hint}`,
    };
  }

  const mainDev = inv.inventory.entries.filter((e) => e.mainDev);
  const sameOnMainDev = mainDev.some((e) => e.relPath === inv.inventory.fileRel);
  const max = mainDev.reduce<MigrationEntry | null>((m, e) => (m === null || Number(e.stamp) > Number(m.stamp) ? e : m), null);
  if (!sameOnMainDev && max && Number(stamp) <= Number(max.stamp)) {
    return {
      kind: 'deny',
      gate: NAME,
      reason: `${base}: stamp ${stamp} не больше максимального ${max.stamp} на main/dev (${max.relPath}, ${max.where}); TypeORM применит его не по порядку. Следующий свободный: ${hint}`,
    };
  }

  return SILENT;
}

register({ name: NAME, events: ['pre-write'], killSwitch: KILL, run: decide });
