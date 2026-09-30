// Контур трения: порт hooks/capture-friction.sh + hooks/friction-classify.sh на события agent-start/agent-stop.
// Уровень (scope) и след (trace_kind) — свойства ДИФФА с начала окна агента, не текста отчёта:
// last_assistant_message и транскрипт не читаются (ADR, решение 1; I3). Наружу — только метки и счётчики
// через appendJsonl('friction'); пути и содержимое остаются в состоянии на машине (agent_window, friction_window).
// SQL виден только как AST (parseSql), TS — только как AST compiler API проекта; нет парсера → trace_kind unknown.
// Regex здесь применяется только к именам файлов, заголовкам hunk'ов git diff и к делению команды хука на слова.
// Документация (*.md, work-docs/**, любой путь вне src/**) описывает гарантию, а не создаёт её:
// не даёт ни domain, ни constraint (INC-FRICTION-DOC-AS-CONSTRAINT). .sql вне migrations*/ — образец запроса,
// применяемый руками: ни domain, ни constraint (рецидив 10.09). guard — только предохранитель, подключённый
// в settings.json (INC-FRICTION-TRACE-BY-PATH): файл из команды хука либо модуль реестра gates/index.ts
// харнесса, чей bin/hook стоит в команде. Путь hooks/ следа не даёт.
// Both events answer silent: an unknown stays in the journal (trace_kind, missing_reason) for /friction-review.
// SubagentStop output would be the subagent's next turn and replace its report; SubagentStart output is prompt noise.
import { statSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolveTypescript } from './toolchain.ts';
import { join, extname, posix, dirname, relative } from 'node:path';
import { register } from './gates/registry.ts';
import { State } from './state.ts';
import { appendJsonl } from './journal.ts';
import { toplevel, status, git } from './git.ts';
import { parseSql, walk } from './parsers/sql.ts';
import { type Snapshot, windowDigest } from './window.ts';
import type { GateContext, Verdict, SubagentStartPayload, SubagentStopPayload, PreToolUsePayload, PostToolUsePayload } from './types.ts';

export const NAME = 'friction';
export const KILL = 'CLAUDE_SKIP_FRICTION';
const ADAPTER = 'claude-friction-2'; // «/» в метке журнал отвергает как путь; bash писал claude-friction/1
// Authorship by the agent's own calls (INC-FRICTION-AGENT-WINDOW-PARENT-EDITS): files_changed means something else, so the label differs.
const ADAPTER_AUTHORED = 'claude-friction-3';
const ROW_TTL_MS = 24 * 3600 * 1000;
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const MAX_FILES = 200;
const MAX_BYTES = 400_000;

export type Scope = 'none' | 'function' | 'module' | 'domain';
export type TraceKind = 'constraint' | 'assertion' | 'guard' | 'rule' | 'none' | 'unknown';
export type Attribution = 'agent' | 'agent_overlapping' | 'window' | 'internal';

interface Changed { repo: string; path: string; untracked: boolean }

// ── имена файлов (строки без грамматики — regex допустим) ───────────────────────────────────────
const DOC_EXT = new Set(['.md', '.mdx', '.markdown', '.txt', '.rst']);
const DOC_DIRS = new Set(['work-docs', 'docs', 'graph', 'specs', 'context-packs', 'comms', 'sessions', 'epics']);
const DOMAIN_SEGMENT = new Set(['migration', 'migrations', 'schema', 'contract', 'contracts']);
const TS_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx']);
const TESTISH = /\.(spec|test)\.[a-z0-9]+$|(^|\/)(tests?|spec|__tests__)\/|(^|\/)test_[^/]+\.py$/i;
const RULE = /(^|\/)(skills|specs)\/|(^|\/)CLAUDE\.md$/i;

const segments = (p: string): string[] => p.split('/');
export function isDoc(p: string): boolean { return DOC_EXT.has(extname(p).toLowerCase()) || DOC_DIRS.has(segments(p)[0]); }
/** Кодовый путь: только под src/** — единственное место, где миграция или схема что-то создаёт. */
export function isCode(p: string): boolean { return !isDoc(p) && segments(p).slice(0, -1).includes('src'); }
// Расширение .sql само схему не меняет: domain дают каталог миграции/схемы/контракта, .proto и openapi.
export function isDomainPath(p: string): boolean {
  if (!isCode(p)) return false;
  const segs = segments(p); const file = segs[segs.length - 1].toLowerCase();
  return segs.slice(0, -1).some((s) => DOMAIN_SEGMENT.has(s.toLowerCase())) || extname(file) === '.proto' || file.includes('openapi');
}
const inMigrationDir = (p: string): boolean => segments(p).slice(0, -1).some((s) => s.toLowerCase().startsWith('migration'));
const isMigrationTs = (p: string): boolean => isCode(p) && TS_EXT.has(extname(p).toLowerCase()) && inMigrationDir(p);
const isSqlFile = (p: string): boolean => isCode(p) && extname(p).toLowerCase() === '.sql';

// ── состояние ───────────────────────────────────────────────────────────────────────────────────
function openState(ctx: GateContext): State {
  const st = State.open(ctx.stateDir);
  st.db.exec('CREATE TABLE IF NOT EXISTS friction_window(repo TEXT PRIMARY KEY, snapshot TEXT, at INTEGER)');
  // agent_tracked: a window opened by this version; agent_call: an agent's Bash between pre and post;
  // tool_write: a file a writer's call left ('' is the root), with its digest right after the call; since — the start of
  // the Bash call that found it (NULL for a named Edit/Write): such a row is only the agent's if no named write of another
  // writer left the same content after that start, decided at the stop because the other's post may land later.
  st.db.exec(`CREATE TABLE IF NOT EXISTS agent_tracked(session_id TEXT, agent_id TEXT, started_at INTEGER, missing TEXT, PRIMARY KEY(session_id, agent_id));
    CREATE TABLE IF NOT EXISTS agent_call(session_id TEXT, agent_id TEXT, call_key TEXT, started_at INTEGER, snapshot TEXT, capped INTEGER, background INTEGER, PRIMARY KEY(session_id, agent_id, call_key));
    CREATE TABLE IF NOT EXISTS tool_write(session_id TEXT, writer TEXT, repo TEXT, path TEXT, digest TEXT, at INTEGER, since INTEGER, PRIMARY KEY(session_id, writer, repo, path, at));`);
  return st;
}

function sessionRoots(st: State, sessionId: string, cwd: string): string[] {
  const rows = st.db.prepare('SELECT repo FROM session_roots WHERE session_id = ?').all(sessionId) as { repo: string }[];
  // Каждый корень нормализуется через git (realpath): /var/… и /private/var/… — один репозиторий.
  const roots = new Set<string>();
  for (const c of [cwd, ...rows.map((r) => r.repo)]) { const top = toplevel(c); if (top) roots.add(top); }
  return [...roots];
}

/** Текущие digest'ы изменённых и неотслеживаемых файлов корня (удалённые не считаются, -uall внутри status()). */
function snapshotRepo(repo: string): { files: Record<string, string>; untracked: Set<string>; capped: boolean } | null {
  const entries = status(repo); if (entries === null) return null;
  const live = entries.filter((e) => e.xy[0] !== 'D' && e.xy[1] !== 'D');
  const files: Record<string, string> = {}; const untracked = new Set<string>();
  let taken = 0;
  for (const e of live) {
    const abs = join(repo, e.path);
    try { if (!statSync(abs).isFile()) continue; } catch { continue; }
    if (taken >= MAX_FILES) return { files, untracked, capped: true };
    const d = windowDigest(abs); if (d === null) continue;
    files[e.path] = d; taken++;
    if (e.xy === '??' || e.xy[0] === 'A') untracked.add(e.path);
  }
  return { files, untracked, capped: false };
}

// ── добавленные строки: git diff -U0 HEAD, регэксп только по заголовку hunk'а ────────────────────
function addedLines(repo: string, path: string, untracked: boolean, totalLines: number): Set<number> | 'all' {
  if (untracked) return 'all';
  const r = git(repo, ['diff', '-U0', 'HEAD', '--', path], 8000);
  if (r.rc !== 0) return 'all';
  const added = new Set<number>();
  for (const line of r.stdout.split('\n')) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    const from = Number(m[1]); const count = m[2] === undefined ? 1 : Number(m[2]);
    for (let i = 0; i < count && added.size <= totalLines; i++) added.add(from + i);
  }
  return added;
}
const inAdded = (added: Set<number> | 'all', line: number): boolean => added === 'all' || added.has(line);

// ── TS compiler API проекта: node_modules/typescript ближайшего вверх от файла, иначе $CLAUDE_HARNESS_TS, иначе тулчейн харнесса ──
// Минимальный срез API, который здесь нужен (полные типы typescript в харнессе недоступны — node_modules нет).
interface TsNode { kind: number; pos: number; getStart(sf: TsSourceFile): number; text?: string; expression?: TsNode; name?: TsNode; arguments?: TsNode[] }
interface TsSourceFile extends TsNode { getLineAndCharacterOfPosition(pos: number): { line: number } }
interface TsApi {
  createSourceFile(name: string, text: string, target: number, setParents?: boolean, kind?: number): TsSourceFile;
  forEachChild(node: TsNode, cb: (n: TsNode) => void): void;
  isCallExpression(n: TsNode): boolean; isPropertyAccessExpression(n: TsNode): boolean; isIdentifier(n: TsNode): boolean;
  isStringLiteral(n: TsNode): boolean; isNoSubstitutionTemplateLiteral(n: TsNode): boolean; isTemplateExpression(n: TsNode): boolean;
  ScriptTarget: { Latest: number }; ScriptKind: { TS: number; TSX: number; JS: number; JSX: number };
}
function loadTs(absPath: string, env: NodeJS.ProcessEnv): TsApi | null {
  try { return createRequire(absPath)('typescript') as TsApi; } catch { /* у файла нет проекта с typescript */ }
  if (env.CLAUDE_HARNESS_TS) { try { return createRequire(import.meta.url)(env.CLAUDE_HARNESS_TS) as TsApi; } catch { /* пин протух */ } }
  const tc = resolveTypescript(env);
  if (tc.path) { try { return createRequire(import.meta.url)(tc.path) as TsApi; } catch { /* тулчейн повреждён */ } }
  return null;
}
function scriptKind(ts: TsApi, path: string): number {
  const e = extname(path).toLowerCase();
  return e === '.tsx' ? ts.ScriptKind.TSX : e === '.jsx' ? ts.ScriptKind.JSX : ['.js', '.mjs', '.cjs'].includes(e) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}
function rootIdentifier(ts: TsApi, n: TsNode): string | null {
  let cur = n;
  while (ts.isPropertyAccessExpression(cur) && cur.expression) cur = cur.expression;
  return ts.isIdentifier(cur) ? (cur.text ?? null) : null;
}
function lastName(ts: TsApi, n: TsNode): string | null {
  return ts.isPropertyAccessExpression(n) ? (n.name?.text ?? null) : ts.isIdentifier(n) ? (n.text ?? null) : null;
}
const ASSERT_ROOTS = new Set(['assert', 'expect', 'it', 'test', 'fc']);

type Cand = TraceKind;
interface FileVerdict { cand: Cand; missing?: string }

/** Литералы queryRunner.query(...) в добавленных строках миграции → parseSql → узлы констрейнта. */
async function migrationTs(ts: TsApi, absPath: string, path: string, added: Set<number> | 'all'): Promise<FileVerdict> {
  const text = readFileSync(absPath, 'utf8');
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(ts, path));
  const literals: string[] = []; let opaque = false;
  const visit = (n: TsNode): void => {
    if (ts.isCallExpression(n) && n.expression && lastName(ts, n.expression) === 'query' && ts.isPropertyAccessExpression(n.expression)
      && lastName(ts, n.expression.expression as TsNode) === 'queryRunner' && n.arguments?.length) {
      const arg = n.arguments[0];
      if (inAdded(added, sf.getLineAndCharacterOfPosition(arg.getStart(sf)).line + 1)) {
        if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) literals.push(arg.text ?? '');
        else if (ts.isTemplateExpression(arg)) opaque = true;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  let sawError = false;
  for (const sql of literals) {
    const r = await sqlConstraint(sql);
    if (r === 'constraint') return { cand: 'constraint' };
    if (r === 'error') sawError = true;
  }
  if (sawError) return { cand: 'unknown', missing: 'sql_parse_error' };
  if (opaque) return { cand: 'unknown', missing: 'sql_literal_has_substitutions' };
  return { cand: 'none' };
}

/** Живой ассерт среди добавленных строк: вызов с корнем assert/expect/it/test/fc — комментарий узлом не является. */
function assertionTs(ts: TsApi, absPath: string, path: string, added: Set<number> | 'all'): FileVerdict {
  const text = readFileSync(absPath, 'utf8');
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(ts, path));
  let found = false;
  const visit = (n: TsNode): void => {
    if (found) return;
    if (ts.isCallExpression(n) && n.expression) {
      const root = rootIdentifier(ts, n.expression);
      if (root && ASSERT_ROOTS.has(root) && inAdded(added, sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1)) { found = true; return; }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { cand: found ? 'assertion' : 'none' };
}

const CONSTR_KINDS = new Set(['CONSTR_CHECK', 'CONSTR_UNIQUE', 'CONSTR_PRIMARY', 'CONSTR_FOREIGN', 'CONSTR_EXCLUSION']);
/** Констрейнт/индекс как узел AST: Constraint{contype ∈ CHECK/UNIQUE/PK/FK/EXCLUSION} или IndexStmt. NOT NULL и новая колонка — нет. */
async function sqlConstraint(sql: string): Promise<'constraint' | 'none' | 'error'> {
  const p = await parseSql(sql);
  if (p.error) return 'error';
  for (const n of walk(p.stmts)) {
    if ('IndexStmt' in n) return 'constraint';
    const c = n.Constraint as { contype?: string } | undefined;
    if (c && typeof c === 'object' && c.contype && CONSTR_KINDS.has(c.contype)) return 'constraint';
  }
  return 'none';
}

async function sqlFile(repo: string, path: string, untracked: boolean): Promise<FileVerdict> {
  const abs = join(repo, path);
  let text: string;
  try { text = readFileSync(abs, 'utf8').slice(0, MAX_BYTES); } catch { return { cand: 'unknown', missing: 'file_unreadable' }; }
  if (!untracked) {
    // Изменённый файл: разбираем только добавленный текст; не разобрался как отдельные операторы — весь файл.
    const r = git(repo, ['diff', '-U0', 'HEAD', '--', path], 8000);
    if (r.rc === 0 && r.stdout.trim()) {
      const addedText = r.stdout.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)).join('\n');
      const a = await sqlConstraint(addedText);
      if (a !== 'error') return { cand: a };
    }
  }
  const whole = await sqlConstraint(text);
  return whole === 'error' ? { cand: 'unknown', missing: 'sql_parse_error' } : { cand: whole };
}

// ── подключённый предохранитель: settings.json → слово команды хука → файл или реестр харнесса ─────
const SETTINGS = ['settings.json', join('.claude', 'settings.json'), join('.claude', 'settings.local.json')];
const readCapped = (abs: string): string | null => { try { return readFileSync(abs, 'utf8').slice(0, MAX_BYTES); } catch { return null; } };
interface Wired { words: string[]; modules: Set<string> }

/** Слова команд из hooks.*[].hooks[].command (JSON.parse, не текст). Слово без «/» файла не называет. */
function hookWords(files: string[]): string[] {
  const words: string[] = [];
  for (const abs of files) {
    const text = readCapped(abs); if (text === null) continue;
    let json: unknown; try { json = JSON.parse(text); } catch { continue; }
    const events = (json as { hooks?: unknown } | null)?.hooks;
    if (!events || typeof events !== 'object') continue;
    for (const groups of Object.values(events)) {
      if (!Array.isArray(groups)) continue;
      for (const g of groups) {
        const hooks = (g as { hooks?: unknown } | null)?.hooks;
        if (!Array.isArray(hooks)) continue;
        for (const h of hooks) {
          const cmd = (h as { command?: unknown } | null)?.command;
          if (typeof cmd !== 'string') continue;
          for (const w of cmd.split(/\s+/)) { const word = w.replaceAll('"', '').replaceAll("'", ''); if (word.includes('/')) words.push(word); }
        }
      }
    }
  }
  return words;
}

/** `import './x.ts';` вне комментария. Именованный и многострочный импорт не засчитываются: недосчёт, а не пересчёт. */
function sideEffectImports(text: string): string[] {
  const specs: string[] = []; let inBlock = false;
  for (const raw of text.split('\n')) {
    let line = raw.trim();
    if (inBlock) { const end = line.indexOf('*/'); if (end < 0) continue; inBlock = false; line = line.slice(end + 2).trim(); }
    const open = line.indexOf('/*');
    if (open >= 0 && line.indexOf('*/', open + 2) < 0) { inBlock = true; line = line.slice(0, open).trim(); }
    if (!line.startsWith('import ')) continue;
    let body = line.slice('import '.length).trim();
    if (body.endsWith(';')) body = body.slice(0, -1).trimEnd();
    const q = body[0];
    if ((q === "'" || q === '"') && body.length > 2 && body.indexOf(q, 1) === body.length - 1) specs.push(body.slice(1, -1));
  }
  return specs;
}

/** Предохранители репозитория: слова команд хуков и модули реестра харнесса, чей `<root>/bin/hook` стоит в команде. */
function wiredSafeguards(repo: string, env: NodeJS.ProcessEnv): Wired {
  const files = SETTINGS.map((f) => join(repo, f));
  if (env.HOME) files.push(join(env.HOME, '.claude', 'settings.json'));
  const words = hookWords(files);
  const modules = new Set<string>(); const seen = new Set<string>();
  const walkIndex = (rel: string, depth: number): void => {
    if (depth > 3 || seen.has(rel)) return;
    seen.add(rel);
    const text = readCapped(join(repo, rel)); if (text === null) return;
    for (const spec of sideEffectImports(text)) {
      if (!spec.startsWith('.')) continue;
      const target = posix.normalize(posix.join(posix.dirname(rel), spec));
      if (target === '..' || target.startsWith('../')) continue;
      if (posix.basename(target) === 'index.ts') walkIndex(target, depth + 1); else modules.add(target);
    }
  };
  for (const word of words) {
    const parts = word.split('/');
    if (parts.length < 2 || parts[parts.length - 1] !== 'hook' || parts[parts.length - 2] !== 'bin') continue;
    const lead = parts.slice(0, -2);
    // Где корень харнесса внутри репозитория, из команды не видно: пробуется каждый хвост пути перед bin/hook.
    for (let i = 0; i <= lead.length; i++) {
      const root = lead.slice(i);
      if (root.some((s) => s === '' || s === '..' || s.startsWith('$') || s.startsWith('~'))) continue;
      walkIndex(posix.normalize(posix.join(...root, 'src', 'gates', 'index.ts')), 0);
    }
  }
  return { words, modules };
}
const isWired = (w: Wired, path: string): boolean => w.modules.has(path) || w.words.some((word) => word === path || word.endsWith(`/${path}`));

const RANK: Record<TraceKind, number> = { none: 0, unknown: 0, rule: 1, guard: 2, assertion: 3, constraint: 4 };

async function classifyFile(f: Changed, env: NodeJS.ProcessEnv, wired: (repo: string) => Wired): Promise<FileVerdict> {
  const { repo, path, untracked } = f;
  if (RULE.test(path)) return { cand: 'rule' };
  if (isDoc(path)) return { cand: 'none' };
  if (isWired(wired(repo), path)) return { cand: 'guard' };
  if (isSqlFile(path)) return inMigrationDir(path) ? sqlFile(repo, path, untracked) : { cand: 'none' };
  const abs = join(repo, path);
  const ext = extname(path).toLowerCase();
  if (isMigrationTs(path)) {
    const ts = loadTs(abs, env); if (!ts) return { cand: 'unknown', missing: 'ts_parser_unavailable' };
    let lines = 0; try { lines = readFileSync(abs, 'utf8').split('\n').length; } catch { return { cand: 'unknown', missing: 'file_unreadable' }; }
    return migrationTs(ts, abs, path, addedLines(repo, path, untracked, lines));
  }
  if (TS_EXT.has(ext)) {
    const ts = loadTs(abs, env);
    if (!ts) return TESTISH.test(path) ? { cand: 'unknown', missing: 'ts_parser_unavailable' } : { cand: 'none' };
    let lines = 0; try { lines = readFileSync(abs, 'utf8').split('\n').length; } catch { return { cand: 'unknown', missing: 'file_unreadable' }; }
    return assertionTs(ts, abs, path, addedLines(repo, path, untracked, lines));
  }
  // Файл без парсера в харнессе: для теста это честное unknown, для прочего кода — отсутствие заявленного следа.
  if (TESTISH.test(path)) return { cand: 'unknown', missing: 'no_parser_for_file_kind' };
  return { cand: 'none' };
}

export interface Derived {
  friction_state: 'no_change' | 'derived_from_diff';
  scope: Scope; trace_kind: TraceKind; files_changed: number; roots_touched: number;
  safeguard_sufficient: boolean | null; missing_reason?: string;
}

/** Чистая классификация набора изменённых файлов (пути наружу не выходят). */
export async function classify(changed: Changed[], env: NodeJS.ProcessEnv, capped = false): Promise<Derived> {
  const missing = new Set<string>(); if (capped) missing.add('files_capped');
  if (!changed.length) return { friction_state: 'no_change', scope: 'none', trace_kind: 'none', files_changed: 0, roots_touched: 0, safeguard_sufficient: true, ...(missing.size ? { missing_reason: [...missing].join(',') } : {}) };
  const code = changed.filter((f) => !isDoc(f.path));
  const repos = new Set(code.map((f) => f.repo));
  const roots = new Set(code.map((f) => `${f.repo}/${segments(f.path)[0]}`));
  let scope: Scope = 'function';
  if (code.some((f) => isDomainPath(f.path)) || repos.size > 1) scope = 'domain';
  else if (code.length > 3 || roots.size > 1) scope = 'module';

  let trace: TraceKind = 'none'; let sawUnknown = false;
  // Предохранители читаются из репозитория самого файла, один раз на репозиторий: settings чужого корня guard не даёт.
  const wiredByRepo = new Map<string, Wired>();
  const wired = (repo: string): Wired => { let w = wiredByRepo.get(repo); if (!w) { w = wiredSafeguards(repo, env); wiredByRepo.set(repo, w); } return w; };
  for (const f of changed) {
    const v = await classifyFile(f, env, wired);
    if (v.cand === 'unknown') { sawUnknown = true; if (v.missing) missing.add(v.missing); continue; }
    if (RANK[v.cand] > RANK[trace]) trace = v.cand;
  }
  if (trace === 'none' && sawUnknown) trace = 'unknown';
  // A hook closes a process risk; a domain risk (data, schema, contract) closes only by a constraint or an assertion (22.09).
  const sufficient = trace === 'unknown' && scope === 'domain' ? null : scope !== 'domain' || ['constraint', 'assertion'].includes(trace);
  return { friction_state: 'derived_from_diff', scope, trace_kind: trace, files_changed: changed.length, roots_touched: roots.size, safeguard_sufficient: sufficient, ...(missing.size ? { missing_reason: [...missing].join(',') } : {}) };
}

// ── события ─────────────────────────────────────────────────────────────────────────────────────
function takeSnapshot(roots: string[]): { snap: Snapshot; untracked: Map<string, Set<string>>; capped: boolean } {
  const snap: Snapshot = {}; const untracked = new Map<string, Set<string>>(); let capped = false;
  for (const repo of roots) {
    const s = snapshotRepo(repo); if (!s) continue;
    snap[repo] = s.files; untracked.set(repo, s.untracked); capped ||= s.capped;
  }
  return { snap, untracked, capped };
}

function onStart(ctx: GateContext): Verdict {
  const p = ctx.payload as SubagentStartPayload;
  const st = openState(ctx);
  try {
    const roots = sessionRoots(st, p.session_id, p.cwd);
    if (!roots.length) return { kind: 'silent' };
    const { snap } = takeSnapshot(roots);
    st.tx(() => st.db.prepare('INSERT INTO agent_window(session_id, agent_id, agent_type, started_at, stopped_at, snapshot) VALUES(?,?,?,?,NULL,?) ON CONFLICT(session_id, agent_id) DO UPDATE SET agent_type = excluded.agent_type, started_at = excluded.started_at, stopped_at = NULL, snapshot = excluded.snapshot')
      .run(p.session_id, p.agent_id, p.agent_type || null, ctx.now(), JSON.stringify(snap)));
    st.tx(() => st.db.prepare('INSERT INTO agent_tracked(session_id, agent_id, started_at, missing) VALUES(?,?,?,NULL) ON CONFLICT(session_id, agent_id) DO UPDATE SET started_at = excluded.started_at, missing = NULL')
      .run(p.session_id, p.agent_id, ctx.now()));
    return { kind: 'silent' };
  } finally { st.close(); }
}

// ── authorship: what the agent's own calls wrote ──────────────────────────────────────────────────
// The window diff of a shared tree credited the agent with the root's edits and repeated one diff on every overlapping
// stop. Only the calls carry authorship: Edit/Write name their file, a Bash call is bracketed by snapshots of its own.
// The root is never tracked here: a root Bash returns before State is opened, so telemetry cannot slow or block it.

function noteMissing(st: State, session: string, agent: string, reason: string): void {
  const row = st.db.prepare('SELECT missing FROM agent_tracked WHERE session_id = ? AND agent_id = ?').get(session, agent) as { missing: string | null } | undefined;
  if (!row) return;
  const set = new Set((row.missing ?? '').split(',').filter(Boolean)); set.add(reason);
  st.db.prepare('UPDATE agent_tracked SET missing = ? WHERE session_id = ? AND agent_id = ?').run([...set].join(','), session, agent);
}

const tracked = (st: State, session: string, agent: string): boolean =>
  !!st.db.prepare('SELECT 1 FROM agent_tracked WHERE session_id = ? AND agent_id = ?').get(session, agent);

/** Files of the roots in `before` whose digest differs in `after`: what the tree gained during one Bash call. Whose it
 * was is settled at the stop against named writes of others (authoredChanges). */
function bashWrites(before: Snapshot, after: Snapshot): { repo: string; path: string; digest: string }[] {
  const out: { repo: string; path: string; digest: string }[] = [];
  for (const [repo, files] of Object.entries(after)) {
    if (!(repo in before)) continue; // a root first seen after pre: its old dirt is not this call's
    for (const [path, d] of Object.entries(files)) if (before[repo][path] !== d) out.push({ repo, path, digest: d });
  }
  return out;
}

function recordWrites(st: State, session: string, writer: string, rows: { repo: string; path: string; digest: string }[], at: number, since: number | null = null): void {
  const ins = st.db.prepare('INSERT OR IGNORE INTO tool_write(session_id, writer, repo, path, digest, at, since) VALUES(?,?,?,?,?,?,?)');
  for (const r of rows) ins.run(session, writer, r.repo, r.path, r.digest, at, since);
}

/** Closes an agent's Bash call against `snap`; capped snapshots name the gap instead of guessing. */
function closeCall(st: State, session: string, agent: string, key: string, snap: Snapshot, capped: boolean, now: number): void {
  const call = st.db.prepare('SELECT started_at, snapshot, capped FROM agent_call WHERE session_id = ? AND agent_id = ? AND call_key = ?').get(session, agent, key) as { started_at: number; snapshot: string; capped: number } | undefined;
  if (!call) return;
  let before: Snapshot; try { before = JSON.parse(call.snapshot) as Snapshot; } catch { before = {}; }
  if (capped || call.capped) noteMissing(st, session, agent, 'files_capped');
  recordWrites(st, session, agent, bashWrites(before, snap), now, call.started_at);
  st.db.prepare('DELETE FROM agent_call WHERE session_id = ? AND agent_id = ? AND call_key = ?').run(session, agent, key);
}

function onPreBash(ctx: GateContext): Verdict {
  const p = ctx.payload as PreToolUsePayload;
  if (!p.agent_id) return { kind: 'silent' };
  let st: State | null = null;
  try {
    st = openState(ctx);
    if (!tracked(st, p.session_id, p.agent_id)) return { kind: 'silent' };
    if (!p.tool_use_id) { const s = st; s.tx(() => noteMissing(s, p.session_id, p.agent_id!, 'call_without_id')); return { kind: 'silent' }; }
    const { snap, capped } = takeSnapshot(sessionRoots(st, p.session_id, p.cwd));
    const s = st;
    s.tx(() => s.db.prepare('INSERT OR REPLACE INTO agent_call(session_id, agent_id, call_key, started_at, snapshot, capped, background) VALUES(?,?,?,?,?,?,?)')
      .run(p.session_id, p.agent_id!, p.tool_use_id!, ctx.now(), JSON.stringify(snap), capped ? 1 : 0, p.tool_input?.run_in_background === true ? 1 : 0));
  } catch { untracked(st, p.session_id, p.agent_id); }
  finally { st?.close(); }
  return { kind: 'silent' };
}

/** An agent's Bash post closes its call (a background one only at the stop: it writes after its post). A named write is
 * recorded for any writer, the root included, while a tracked agent may run a Bash call beside it — but only a
 * PostToolUse: a failed Edit/Write wrote nothing, and the file's content is someone else's (race-auditor 29.09). */
function onPost(ctx: GateContext): Verdict {
  const p = ctx.payload as PostToolUsePayload;
  const agent = p.agent_id || '';
  if (p.tool_name === 'Bash' && !agent) return { kind: 'silent' };
  if (p.tool_name !== 'Bash' && !WRITE_TOOLS.has(p.tool_name)) return { kind: 'silent' };
  let st: State | null = null;
  try {
    st = openState(ctx);
    const s = st;
    if (p.tool_name === 'Bash') {
      if (!p.tool_use_id || !tracked(s, p.session_id, agent)) return { kind: 'silent' };
      const call = s.db.prepare('SELECT background FROM agent_call WHERE session_id = ? AND agent_id = ? AND call_key = ?').get(p.session_id, agent, p.tool_use_id) as { background: number } | undefined;
      if (!call) { s.tx(() => noteMissing(s, p.session_id, agent, 'call_untracked')); return { kind: 'silent' }; }
      if (call.background) return { kind: 'silent' };
      const { snap, capped } = takeSnapshot(sessionRoots(s, p.session_id, p.cwd));
      s.tx(() => closeCall(s, p.session_id, agent, p.tool_use_id!, snap, capped, ctx.now()));
      return { kind: 'silent' };
    }
    if (p.hook_event_name !== 'PostToolUse') return { kind: 'silent' };
    if (!s.db.prepare('SELECT 1 FROM agent_tracked WHERE session_id = ?').get(p.session_id)) return { kind: 'silent' };
    const file = p.tool_input?.file_path ?? p.tool_input?.notebook_path;
    if (typeof file !== 'string') return { kind: 'silent' };
    let real: string; try { real = realpathSync(file); } catch { return { kind: 'silent' }; }
    const repo = toplevel(dirname(real)); if (!repo) return { kind: 'silent' };
    const digest = windowDigest(real); if (digest === null) return { kind: 'silent' };
    const path = relative(repo, real).split('\\').join('/');
    s.tx(() => recordWrites(s, p.session_id, agent, [{ repo, path, digest }], ctx.now()));
  } catch { if (agent) untracked(st, p.session_id, agent); }
  finally { st?.close(); }
  return { kind: 'silent' };
}

/** A failure inside a call handler costs the window its completeness, never the call: the hook stays silent. */
function untracked(st: State | null, session: string, agent: string): void {
  try { if (st) st.tx(() => noteMissing(st, session, agent, 'call_untracked')); } catch { /* the store itself failed */ }
}

/** The authored side of a stop: closes background calls, names unclosed ones, returns the agent's files that are still
 * changed now. Rows of this agent and anything older than ROW_TTL_MS are removed. */
function authoredChanges(st: State, session: string, agent: string, startedAt: number, snap: Snapshot, untrackedFiles: Map<string, Set<string>>, capped: boolean, now: number): { changed: Changed[]; missing: string[] } {
  let missing: string[] = [];
  st.tx(() => {
    const calls = st.db.prepare('SELECT call_key, background FROM agent_call WHERE session_id = ? AND agent_id = ?').all(session, agent) as { call_key: string; background: number }[];
    for (const c of calls) {
      if (c.background) { noteMissing(st, session, agent, 'background_window'); closeCall(st, session, agent, c.call_key, snap, capped, now); }
      else { noteMissing(st, session, agent, 'call_unclosed'); st.db.prepare('DELETE FROM agent_call WHERE session_id = ? AND agent_id = ? AND call_key = ?').run(session, agent, c.call_key); }
    }
  });
  const rows = st.db.prepare(`SELECT DISTINCT w.repo, w.path FROM tool_write w WHERE w.session_id = ? AND w.writer = ? AND w.at >= ?
    AND (w.since IS NULL OR NOT EXISTS (SELECT 1 FROM tool_write o WHERE o.session_id = w.session_id AND o.writer <> w.writer AND o.since IS NULL
      AND o.repo = w.repo AND o.path = w.path AND o.digest = w.digest AND o.at >= w.since))`).all(session, agent, startedAt) as { repo: string; path: string }[];
  // Still changed now: in the stop snapshot, or — past the cap, where the snapshot is blind — still on disk.
  const exists = (r: { repo: string; path: string }): boolean => { try { return statSync(join(r.repo, r.path)).isFile(); } catch { return false; } };
  const changed: Changed[] = rows.filter((r) => snap[r.repo]?.[r.path] !== undefined || (capped && exists(r))).map((r) => ({ repo: r.repo, path: r.path, untracked: untrackedFiles.get(r.repo)?.has(r.path) ?? false }));
  const t = st.db.prepare('SELECT missing FROM agent_tracked WHERE session_id = ? AND agent_id = ?').get(session, agent) as { missing: string | null } | undefined;
  missing = (t?.missing ?? '').split(',').filter(Boolean);
  st.tx(() => {
    st.db.prepare('DELETE FROM tool_write WHERE session_id = ? AND writer = ?').run(session, agent);
    st.db.prepare('DELETE FROM agent_tracked WHERE session_id = ? AND agent_id = ?').run(session, agent);
    if (!st.db.prepare('SELECT 1 FROM agent_tracked WHERE session_id = ?').get(session)) st.db.prepare('DELETE FROM tool_write WHERE session_id = ?').run(session);
    st.db.prepare('DELETE FROM tool_write WHERE at < ?').run(now - ROW_TTL_MS);
    st.db.prepare('DELETE FROM agent_call WHERE started_at < ?').run(now - ROW_TTL_MS);
    st.db.prepare('DELETE FROM agent_tracked WHERE started_at < ?').run(now - ROW_TTL_MS);
  });
  return { changed, missing };
}

interface WindowRow { agent_type: string | null; started_at: number; stopped_at: number | null; snapshot: string }

async function onStop(ctx: GateContext): Promise<Verdict> {
  const p = ctx.payload as SubagentStopPayload;
  const now = ctx.now();
  const out = ctx.env.FRICTION_OUT || join(ctx.env.HOME ?? '', '.claude', 'exec-telemetry', 'personal-friction.jsonl');
  const base: Record<string, unknown> = {
    ts: new Date(now).toISOString(), adapter: ADAPTER, executor: 'local-agent', source_class: 'subagent-stop',
    session: p.session_id ?? null, agent_id: p.agent_id || null, agent_type: p.agent_type || null,
    outcome: 'completed', verification_state: 'unknown',
    narrative_friction_state: 'unavailable', narrative_missing_reason: 'structured_friction_signal_not_exposed',
  };
  const st = openState(ctx);
  try {
    const roots = sessionRoots(st, p.session_id, p.cwd);
    if (!roots.length) {
      appendJsonl(out, 'friction', { ...base, friction_state: 'unavailable', missing_reason: 'not_a_git_repo' });
      return { kind: 'silent' };
    }
    const row = p.agent_id ? st.db.prepare('SELECT agent_type, started_at, stopped_at, snapshot FROM agent_window WHERE session_id = ? AND agent_id = ?').get(p.session_id, p.agent_id) as WindowRow | undefined : undefined;
    // An agent with neither a start row nor a type is Claude Code's own (175 of 175 such ids on 19-21.09 never appear in
    // the parent transcript): it gets no level, and the shared window stays put so the root's edits are not cut by it.
    if (!row && !p.agent_type) {
      appendJsonl(out, 'friction', { ...base, friction_state: 'not_applicable', missing_reason: 'internal_agent_without_start', attribution: 'internal', files_changed: 0 });
      return { kind: 'silent' };
    }
    // A stop of an agent whose window already closed is a resume without a new start: nothing tracked its calls since, and
    // the tree diff would hand it the root's edits under its agent_id. No level; the shared window stays put.
    if (row && row.stopped_at !== null) {
      appendJsonl(out, 'friction', { ...base, friction_state: 'not_applicable', missing_reason: 'resumed_without_start', attribution: 'window', files_changed: 0 });
      return { kind: 'silent' };
    }
    const { snap, untracked, capped } = takeSnapshot(roots);
    let prev: Snapshot = {}; let attribution: Attribution = 'window'; let concurrent: number | null = null;
    let duration: number | null = null; let windowS: number | null = null;
    if (row && row.stopped_at === null) {
      try { prev = JSON.parse(row.snapshot) as Snapshot; } catch { prev = {}; }
      duration = windowS = Math.round((now - row.started_at) / 1000);
      const others = st.db.prepare('SELECT agent_id, snapshot FROM agent_window WHERE session_id = ? AND agent_id <> ? AND started_at <= ? AND (stopped_at IS NULL OR stopped_at >= ?)')
        .all(p.session_id, p.agent_id, now, row.started_at) as { agent_id: string; snapshot: string }[];
      concurrent = others.filter((o) => { try { return Object.keys(JSON.parse(o.snapshot) as Snapshot).some((r) => roots.includes(r)); } catch { return false; } }).length;
      attribution = concurrent > 0 ? 'agent_overlapping' : 'agent';
      st.tx(() => st.db.prepare('UPDATE agent_window SET stopped_at = ? WHERE session_id = ? AND agent_id = ?').run(now, p.session_id, p.agent_id));
    } else {
      let oldest: number | null = null;
      for (const repo of roots) {
        const w = st.db.prepare('SELECT snapshot, at FROM friction_window WHERE repo = ?').get(repo) as { snapshot: string; at: number } | undefined;
        if (!w) continue;
        try { prev[repo] = JSON.parse(w.snapshot) as Record<string, string>; } catch { /* пустое окно */ }
        oldest = oldest === null ? w.at : Math.min(oldest, w.at);
      }
      if (oldest !== null) windowS = Math.round((now - oldest) / 1000);
    }
    // Общее окно корня сдвигается на каждом стопе — следующий безадресный стоп считает только новое.
    st.tx(() => { for (const repo of roots) st.db.prepare('INSERT INTO friction_window(repo, snapshot, at) VALUES(?,?,?) ON CONFLICT(repo) DO UPDATE SET snapshot = excluded.snapshot, at = excluded.at').run(repo, JSON.stringify(snap[repo] ?? {}), now); });

    const authored = row && row.stopped_at === null && p.agent_id && tracked(st, p.session_id, p.agent_id)
      ? authoredChanges(st, p.session_id, p.agent_id, row.started_at, snap, untracked, capped, now) : null;
    let changed: Changed[] = [];
    if (authored) changed = authored.changed;
    else {
      for (const [repo, files] of Object.entries(snap)) {
        for (const [path, d] of Object.entries(files)) if (prev[repo]?.[path] !== d) changed.push({ repo, path, untracked: untracked.get(repo)?.has(path) ?? false });
      }
    }
    const derived = await classify(changed, ctx.env, capped);
    if (authored?.missing.length) {
      const all = new Set([...(derived.missing_reason ?? '').split(',').filter(Boolean), ...authored.missing]);
      derived.missing_reason = [...all].join(',');
    }
    appendJsonl(out, 'friction', { ...base, ...(authored ? { adapter: ADAPTER_AUTHORED } : {}), ...derived, attribution, concurrent_agents: concurrent, duration_s: duration, window_s: windowS });
    return { kind: 'silent' };
  } finally { st.close(); }
}

export function decide(ctx: GateContext): Verdict | Promise<Verdict> {
  if (ctx.event === 'pre-bash') return onPreBash(ctx);
  if (ctx.event === 'post') return onPost(ctx);
  return ctx.event === 'agent-start' ? onStart(ctx) : onStop(ctx);
}

register({ name: NAME, events: ['agent-start', 'agent-stop', 'pre-bash', 'post'], killSwitch: KILL, run: decide });
