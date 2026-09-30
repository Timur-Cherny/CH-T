// pg-session — порт hooks/pg-session-state-guard.sh на AST (класс К1: INC-PG-READONLY-BYPASS).
// Барьер и лимит к Postgres нельзя держать СОСТОЯНИЕМ СОЕДИНЕНИЯ: за пулером в transaction-режиме
// серверный бэкенд уходит в пул к чужим клиентам вместе с настройкой (прод 28.08 — 20 минут отказов
// записи), а startup-параметр options=-c пулер отбивает как FATAL 08P01. Правила — над узлами parseSql,
// не над текстом: SET в комментарии и строковом литерале узлом не является и не считается.
//
// Regex в модуле объявлен и ограничен строками БЕЗ SQL-грамматики:
//   · позиция ключевого слова в чужом документе (YAML/JSON/TS/shell), чтобы вырезать кандидата —
//     вердикт по кандидату выносит только AST, нераспарсенный кандидат вердикта не даёт;
//   · ключ options / PGOPTIONS в конфиге вида key: value и в conninfo key=value;
//   · имена файлов (расширение, каталоги спек).
import { readFileSync } from 'node:fs';
import { resolve, basename, extname } from 'node:path';
import { register } from './registry.ts';
import { hasExpansion } from '../parsers/shell.ts';
import { PSQL_LIKE, psqlSourceTokens, conninfoValue, splitPsqlMeta } from '../parsers/psql.ts';
import { buildModel, ASSIGN, SHELLS, kubeParse } from '../parsers/stages.ts';
import type { Model, Stage } from '../parsers/stages.ts';
import { CLEAN, worst } from './judgement.ts';
import type { Judgement } from './judgement.ts';
import { parseSql, stmtKind, stmtNode, walk } from '../parsers/sql.ts';
import type { Node, RawStmt } from '../parsers/sql.ts';
import type { GateContext, PreToolUsePayload, Verdict } from '../types.ts';

export const NAME = 'pg-session';
export const KILL = 'CLAUDE_SKIP_PG_SESSION_GUARD';

/** GUC, которые за пулером держат барьер или лимит состоянием сессии. */
export const GUCS: ReadonlySet<string> = new Set([
  'default_transaction_read_only', 'statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout',
]);

const deny = (reason: string): Judgement => ({ kind: 'deny', reason, hint: HINT });
const unknown = (reason: string): Judgement => ({ kind: 'unknown', reason });
/** SQL увели от гейта: переменная, аргумент функции, подстановка, файл той же команды. Запрет, не вопрос:
 *  вопрос отдаёт человеку решение, которое гейт обязан вынести сам (решение 12.09 и 16.09). */
const hidden = (reason: string): Judgement => ({ kind: 'deny', reason, hint: HIDDEN_HINT });

export const HINT = [
  'Чем держать вместо этого:',
  '  • только чтение   → права роли: GRANT SELECT без INSERT/UPDATE/DELETE (каталог прав, не протекает)',
  '  • разовая сессия  → BEGIN TRANSACTION READ ONLY + SET LOCAL (умирает на ROLLBACK)',
  '  • таймаут запроса → на стороне клиента (jsonData.queryTimeout у датасорса Grafana)',
  `Осознанное изменение прод-роли выполняет владелец базы. Kill-switch: ${KILL}=1`,
].join('\n');

export const HIDDEN_HINT = [
  'Гейт судит SQL по тексту команды — напиши его так, чтобы текст и был запросом:',
  "  • литералом в -c: psql -c \"SELECT … WHERE id = '<значение>'\" — значения вписать в текст",
  "  • here-doc с ограничителем в кавычках: psql <<'SQL' … SQL",
  '  • файлом: записать SQL отдельным шагом (Write) и psql -f /абсолютный/путь.sql',
  '  • функцией-обёрткой: run() { psql … "$@"; } и все вызовы run в этой же команде с литеральными аргументами —',
  '    гейт судит каждый вызов; тело плоское (без if/for/case/while, условного shift, set --, eval), "$@"/"$1" в кавычках',
  'Переменная, подстановка $(…), xargs, файл, который пишет эта же команда, и аргумент функции, которую так не раскрыть, уводят SQL от проверки.',
].join('\n');

// ───────────────────────────── правила над AST ─────────────────────────────

interface SetNode { kind?: string; name?: string; is_local?: boolean }

function judgeSet(set: SetNode): Judgement {
  if (!set.name || !GUCS.has(set.name)) return CLEAN;
  if (set.is_local) return CLEAN;
  if (set.kind === 'VAR_RESET' || set.kind === 'VAR_RESET_ALL' || set.kind === 'VAR_SET_DEFAULT') return CLEAN;
  return deny(`сессионный SET ${set.name} без LOCAL: настройка остаётся на серверном бэкенде и уезжает за пулер`);
}

function judgeCatalogSet(kind: string, node: Node): Judgement {
  const set = (node.setstmt ?? {}) as SetNode;
  if (set.kind === 'VAR_SET_VALUE' || set.kind === 'VAR_SET_CURRENT') {
    return deny(`ALTER ${kind === 'AlterRoleSetStmt' ? 'ROLE' : 'DATABASE'} … SET ${set.name ?? ''}: сессионный GUC в каталоге pg_db_role_setting, применяется на старте каждого соединения`);
  }
  return CLEAN; // RESET / RESET ALL / SET … TO DEFAULT снимают настройку
}

function literalString(arg: unknown): string | null {
  const c = (arg as { A_Const?: { sval?: { sval?: string } } })?.A_Const;
  return typeof c?.sval?.sval === 'string' ? c.sval.sval : null;
}
function literalBool(arg: unknown): boolean | null {
  const c = (arg as { A_Const?: { boolval?: { boolval?: boolean } } })?.A_Const;
  return typeof c?.boolval === 'object' && c.boolval !== null ? Boolean(c.boolval.boolval) : null;
}

/** set_config(guc, value, is_local) в любом месте дерева: is_local=true умирает с транзакцией, остальное — сессия. */
function judgeFuncCalls(root: unknown): Judgement {
  let out: Judgement = CLEAN;
  for (const n of walk(root)) {
    if (!('FuncCall' in n)) continue;
    const fc = n.FuncCall as { funcname?: Array<{ String?: { sval?: string } }>; args?: unknown[] };
    const fname = fc.funcname?.at(-1)?.String?.sval?.toLowerCase();
    if (fname !== 'set_config') continue;
    const args = fc.args ?? [];
    if (literalBool(args[2]) === true) continue;
    // Имя GUC Postgres сравнивает без учёта регистра; SET нормализует парсер, а литерал set_config — нет.
    const guc = literalString(args[0])?.toLowerCase() ?? null;
    if (guc === null) { out = worst(out, unknown('set_config с нелитеральным именем GUC — доказать безопасность нельзя')); continue; }
    if (!GUCS.has(guc)) continue;
    const how = literalBool(args[2]) === false ? 'is_local=false' : 'is_local не литерал';
    out = worst(out, deny(`set_config('${guc}', …, ${how}): сессионный GUC через функцию`));
  }
  return out;
}

export function judgeStmts(stmts: RawStmt[]): Judgement {
  let out: Judgement = CLEAN;
  const prepared = new Set<string>();
  for (const s of stmts) {
    const kind = stmtKind(s);
    const node = stmtNode<Node>(s) ?? {};
    switch (kind) {
      case 'VariableSetStmt': out = worst(out, judgeSet(node as SetNode)); break;
      case 'AlterRoleSetStmt': case 'AlterDatabaseSetStmt': out = worst(out, judgeCatalogSet(kind, node)); break;
      case 'DoStmt': out = worst(out, deny('DO-блок: тело непрозрачно для парсера (внутри может быть EXECUTE с SET)')); break;
      case 'CallStmt': out = worst(out, deny('CALL: тело процедуры непрозрачно для парсера (внутри может быть SET без LOCAL)')); break;
      case 'PrepareStmt': prepared.add(String(node.name ?? '')); break;
      case 'ExecuteStmt':
        // PREPARE из того же пакета уже проверен на set_config; чужой — тело непрозрачно.
        if (!prepared.has(String(node.name ?? ''))) out = worst(out, deny(`EXECUTE ${String(node.name ?? '')}: тело подготовленного запроса непрозрачно (PREPARE вне видимого пакета)`));
        break;
      default: break;
    }
    out = worst(out, judgeFuncCalls(s.stmt));
  }
  return out;
}

export async function judgeSql(sql: string): Promise<Judgement> {
  const p = await parseSql(sql);
  if (p.error) return unknown(`SQL не разобран (${p.error.split('\n')[0]}) — доказать безопасность нельзя`);
  return judgeStmts(p.stmts);
}

// ───────────────────────────── строка подключения ─────────────────────────────

const URL_SCHEMES = ['postgresql://', 'postgres://'];

function stripQuotes(v: string): string { return v.replace(/^["']+|["']+$/g, '').trim(); }
const startsWithDashC = (v: string): boolean => /^-c(\s|=|$)/.test(stripQuotes(v));

/** Один токен: URL postgres://, conninfo с options=, PGOPTIONS=… */
export function judgeConnToken(t: string): Judgement {
  if (t.startsWith('PGOPTIONS=')) {
    return startsWithDashC(t.slice('PGOPTIONS='.length)) ? deny('PGOPTIONS=-c: startup-параметр соединения, пулер отбивает как FATAL 08P01') : CLEAN;
  }
  const at = URL_SCHEMES.map((s) => t.indexOf(s)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
  if (at !== undefined) {
    let url: URL;
    try { url = new URL(stripQuotes(t.slice(at))); } catch { return unknown('строка подключения postgres:// не разобрана как URL'); }
    if (url.searchParams.getAll('options').some(startsWithDashC)) return deny('options=-c в строке подключения: startup-параметр, пулер отбивает как FATAL 08P01');
    return CLEAN;
  }
  if (t.includes('options=')) {
    const v = conninfoValue(t, 'options');
    if (v !== null && startsWithDashC(v)) return deny("options='-c …' в conninfo: startup-параметр, пулер отбивает как FATAL 08P01");
  }
  return CLEAN;
}

// ───────────────────────────── pre-bash: откуда берётся SQL ─────────────────────────────
// Модель стадий общая с data-boundary: трубы, kubectl exec --, sh -c, тела $(…), функции, файлы, которые пишет
// команда. Гейт судит то, что получит psql; если текст собран подстановкой — это не SQL, а скрытый SQL.

const PG_TOOLS = new Set(['psql', 'pgcli', 'pg_dump', 'pg_dumpall', 'pg_restore', 'pgbench']);
const PG_WORD = /(^|[^A-Za-z0-9_])(psql|pgcli|pg_dump|pg_dumpall|pg_restore|pgbench)([^A-Za-z0-9_]|$)/;
/** libpq и psql читают их неявно: через них приходят настройки сессии без единого упоминания в argv psql. */
const SESSION_ENV = new Set(['PGOPTIONS', 'PSQLRC', 'PGSERVICE', 'PGSERVICEFILE']);
const POSITIONAL = /^\$\{?([@*]|[0-9]+)\}?$/;
const EXPANSION = /\$\{[^}]*\}?|[$<>]\([^)]*\)?|`[^`]*`?|\$'[^']*'?|\$[=~^+]?[A-Za-z_][A-Za-z0-9_]*|\$[0-9@*#?$!-]|\$\[[^\]]*\]?/g;

type St = Stage<null>;

const base = (t: string): string => t.split('/').pop() ?? t;
function isPgToken(t: string): boolean {
  return PG_TOOLS.has(base(t)) || t.startsWith('PGPASSWORD=') || t.startsWith('PGOPTIONS=') || URL_SCHEMES.some((s) => t.includes(s));
}

function describeUnknown(tags: string[]): string {
  const m: Record<string, string> = {
    'here-doc': 'ограничитель here-doc не разобран — тело недоступно',
    'here-doc-unterminated': 'here-doc без ограничителя — тело неизвестно целиком',
    'here-doc-orphan': 'тело here-doc без команды',
    'here-string': 'тело SQL приходит через here-string <<< — недоступно',
    'unterminated-single-quote': 'незакрытая одинарная кавычка',
    'unterminated-double-quote': 'незакрытая двойная кавычка',
  };
  return tags.map((t) => m[t] ?? t).join('; ');
}

/** Сами подстановки из текста — чтобы причина называла, что именно спрятало SQL. */
function expansions(text: string): string {
  const found = [...new Set(text.match(EXPANSION) ?? [])].map((e) => (e.length > 40 ? `${e.slice(0, 39)}…` : e));
  return found.length ? found.slice(0, 3).join(', ') : 'подстановка';
}

/** psql подставляет :'x' литералом и :"x" идентификатором — для суда это строка и имя, не операторы.
 *  Голое :x вставляет текст как есть и остаётся нераспознанным. В -c psql переменные не подставляет. */
const psqlVars = (text: string): string => text.replace(/(?<!:):'[A-Za-z_][A-Za-z0-9_]*'/g, "'v'").replace(/(?<!:):"[A-Za-z_][A-Za-z0-9_]*"/g, '"v"');

/** Текст для psql: метакоманды отдельно (`\i`, `\gexec` — тело вне текста), SQL — через AST. */
async function judgeScript(text: string, vars: boolean): Promise<Judgement> {
  const meta = splitPsqlMeta(text);
  let out: Judgement = CLEAN;
  for (const o of meta.opaque) out = worst(out, unknown(`psql ${o}: тело SQL вне видимого текста`));
  if (meta.sql.trim()) out = worst(out, await judgeSql(vars ? psqlVars(meta.sql) : meta.sql));
  return out;
}

/** Читают файл, не меняя его: упоминание ими пути не ставит содержимое под сомнение. */
const READERS: ReadonlySet<string> = new Set([
  'cat', 'bat', 'less', 'more', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'diff', 'cmp', 'ls', 'stat', 'file',
  'md5', 'md5sum', 'sha1sum', 'sha256sum', 'echo', 'printf', 'test', '[', '[[', 'realpath', 'readlink', 'basename', 'dirname',
  'jq', 'yq', 'sort', 'uniq', 'cut', 'awk', 'sed', 'tr', 'column', 'nl', 'xxd', 'od', 'hexdump', 'base64',
]);
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Обёртка, чьё тело модель разобрала в стадии (sh -c, оболочка с here-doc, eval, kubectl exec --): путь в её argv —
 *  это путь внутренней команды, и судится там; сама обёртка файл не пишет. */
function modeled(s: St): boolean {
  if (SHELLS.has(s.name)) return s.heredocs.length > 0 || s.rest.some((t) => /^-[A-Za-z]*c[A-Za-z]*$/.test(t));
  if (s.name === 'eval') return true;
  return s.name === 'kubectl' && kubeParse(s.rest).sub === 'exec';
}

async function judgeFile(path: string, isDynamic: boolean, self: St, stages: St[], cwd: string, transparent: ReadonlySet<St>): Promise<Judgement> {
  if (isDynamic) return hidden(`путь к SQL-файлу собирается подстановкой (${expansions(path)}) — файл не прочитать, SQL не проверить`);
  const target = resolve(cwd, path);
  if (stages.some((s) => s.writes.some((w) => resolve(cwd, w) === target))) {
    return hidden(`SQL-файл ${basename(path)} пишет эта же команда — гейт прочитал бы с диска старое содержимое`);
  }
  // Писатель, которого модель не знает (python -c, скрипт): путь в его аргументах — содержимое на запуске не доказать.
  const mention = new RegExp(`(^|[^A-Za-z0-9_.-])(${escapeRe(path)}|${escapeRe(target)})($|[^A-Za-z0-9_.-])`);
  const other = stages.find((s) => s !== self && !transparent.has(s) && !modeled(s) && !READERS.has(s.name) && !PG_TOOLS.has(s.name) && s.argv.some((t) => mention.test(t)));
  if (other) return unknown(`SQL-файл ${basename(path)} упоминает ${other.name} в этой же команде — содержимое на момент запуска не доказать`);
  let text: string;
  try { text = readFileSync(target, 'utf8'); } catch { return unknown(`файл SQL не прочитан: ${basename(path)}`); }
  return judgeScript(text, true);
}

function printfText(rest: string[]): string | null {
  const [fmt, ...args] = rest;
  if (fmt === undefined) return null;
  if (!args.length) return fmt.replace(/\\n/g, '\n');
  return /^(%s(\\n)?)+$/.test(fmt) ? args.join('\n') : null;
}

/** stdin psql из трубы: литерал cat-here-doc, echo и printf судится, собранный подстановкой — скрытый SQL. */
async function judgeStdin(src: St): Promise<Judgement> {
  const dyn = (k: number): boolean => src.dynamic[src.restAt + k] === true;
  if (src.name === 'cat' && src.heredocs.length && src.rest.every((t) => t === '-' || t.startsWith('-'))) {
    if (src.tags.includes('here-doc-expansion')) return hidden(`SQL на stdin psql приходит из here-doc с подстановкой (${expansions(src.heredocs.join(''))})`);
    let out: Judgement = CLEAN;
    for (const body of src.heredocs) out = worst(out, await judgeScript(body, true));
    return out;
  }
  if (src.name === 'echo' || src.name === 'printf') {
    const built = src.rest.filter((_, k) => dyn(k));
    if (built.length) return hidden(`SQL на stdin psql собирает ${src.name} с подстановкой (${expansions(built.join(' '))})`);
    const text = src.name === 'echo' ? src.rest.filter((t, k) => !(k === 0 && /^-[neE]+$/.test(t))).join(' ') : printfText(src.rest);
    if (text !== null) return judgeScript(text, false);
  }
  return unknown('SQL приходит на stdin из другой команды — тело недоступно');
}

/** Слово в позиции команды собрано подстановкой, и за ним стоит pg: `P="psql -Atc"; $P "…"`. */
function hiddenCall(st: St, model: Model<null>): string | null {
  const at = st.restAt - 1;
  if (!st.name || at < 0 || !st.dynamic[at]) return null;
  const word = st.argv[at];
  const name = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)/.exec(word)?.[1];
  const values = name ? model.assigns.get(name) ?? [] : [];
  const pg = PG_WORD.test(word) || values.some((v) => PG_WORD.test(v)) || (name !== undefined && /psql|pgcli|pg_dump|pg_restore/i.test(name));
  return pg ? word : null;
}

function sessionEnv(st: St): Judgement {
  let out: Judgement = CLEAN;
  st.argv.forEach((t, k) => {
    const m = ASSIGN.exec(t);
    if (m && SESSION_ENV.has(m[1]) && st.dynamic[k]) out = worst(out, unknown(`${m[1]} собирается подстановкой (${expansions(m[2])}) — настройки сессии соединения не доказать`));
  });
  return out;
}

/** Стадии, чьё упоминание пути не ставит содержимое файла под сомнение: места вызова раскрытой функции. */
const NONE: ReadonlySet<St> = new Set();

async function judgePsql(st: St, stages: St[], model: Model<null>, cwd: string, transparent: ReadonlySet<St> = NONE): Promise<Judgement> {
  let out: Judgement = CLEAN;
  const dyn = (k: number): boolean => st.dynamic[st.restAt + k] === true;
  if (st.viaXargs) out = worst(out, hidden('аргументы psql приходят через xargs со stdin — SQL и файлы в команде не видны'));
  const positional = st.rest.filter((t, k) => dyn(k) && POSITIONAL.test(t));
  if (positional.length && st.inFunction) out = worst(out, hidden(`psql в теле функции получает аргументы с места вызова (${positional.join(', ')})`));
  // Одно слово `"$1"` — тоже argv psql целиком: `sh -c 'psql "$1"' _ "-c SET …"` склеивает флаг и SQL в нём.
  else if (positional.length) out = worst(out, hidden(`аргументы psql приходят подстановкой позиционных параметров (${positional.join(', ')})`));

  for (const t of st.tags) {
    if (t === 'here-doc-expansion') out = worst(out, hidden(`тело here-doc к psql собирается подстановкой (${expansions(st.heredocs.join(''))}) — ограничитель без кавычек, итоговый SQL неизвестен`));
    else out = worst(out, unknown(describeUnknown([t])));
  }
  for (const body of st.heredocs) out = worst(out, await judgeScript(body, true));

  const sources = psqlSourceTokens(st.rest);
  for (const src of sources) {
    if (src.kind === 'inline') {
      if (dyn(src.at)) out = worst(out, hidden(`SQL для psql собирается подстановкой (${expansions(st.rest[src.at])}) — гейт видит не тот текст, что уйдёт в базу`));
      out = worst(out, await judgeScript(src.sql, false));
    } else if (src.kind === 'file') {
      out = worst(out, await judgeFile(src.path, dyn(src.at), st, stages, cwd, transparent));
    } else if (!st.heredocs.length) {
      out = worst(out, st.stdinStage ? await judgeStdin(st.stdinStage) : unknown('psql -f - читает stdin — тело недоступно'));
    }
  }
  if (st.stdin !== null) out = worst(out, await judgeFile(st.stdin, st.stdinDynamic, st, stages, cwd, transparent));
  if (!sources.length && st.stdin === null && !st.heredocs.length) {
    if (st.stdinStage) out = worst(out, await judgeStdin(st.stdinStage));
    else if (st.inFunction) out = worst(out, hidden('psql в теле функции читает SQL со stdin места вызова — гейт не видит, что туда придёт'));
  }
  // Подключение из подстановки этой же команды: DB=$(…); psql -d "$DB".
  st.rest.forEach((t, k) => {
    if (!dyn(k)) return;
    for (const m of t.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)) {
      if ((model.assigns.get(m[1]) ?? []).some((v) => hasExpansion(v, 'dq'))) out = worst(out, unknown(`подстановка в ${m[1]} доходит до вызова psql — значение неизвестно`));
    }
  });
  return out;
}

// ───────────────────────────── функция-обёртка: раскрытие по месту вызова ─────────────────────────────
// `run() { psql … "$@"; }; run -f a.sql -c ROLLBACK` — текст команды целиком определяет argv psql, когда тело
// плоское (без if/for/case/while и подоболочек), позиционные параметры стоят целым словом в кавычках, shift
// безусловен и с литеральным числом, а каждый вызов в той же оболочке передаёт литералы. Тогда каждый вызов
// судится как обычный psql. Что этого не доказывает — "$*", ${@:2}, $10, set --, eval, вызов с подстановкой
// или из другой оболочки, функция без вызова — оставляет SQL скрытым: запрет с прежней подсказкой и причиной.

interface PosRef { k: number; ref: '@' | number; quoted: boolean }
interface Resolved { calls: St[]; sites: ReadonlySet<St> }
const QUOTED_POS = /^"\$(?:([@1-9])|\{(@|[1-9][0-9]*)\})"$/;
const BARE_POS = /^\$(?:([@1-9])|\{(@|[1-9][0-9]*)\})$/;
/** Любая иная ссылка на позиционные параметры — $*, $#, $0, $10, ${@:2}, склейка "-c$1" — точно не раскрывается. */
const POS_LIKE = /\$\{?[@*#!0-9]/;
/** Стадии тела, за которыми позиционные параметры могут измениться незаметно для модели. */
const BODY_OPAQUE: ReadonlySet<string> = new Set(['eval', 'source', '.', 'builtin']);
/** Значение без кавычек делится по IFS и раскрывается как маска: точное слово — только такое. */
const PLAIN_WORD = /^[^\s*?[\]]+$/;

const fnOf = (st: St): string | null => st.fn ?? (st.enclosing ? fnOf(st.enclosing.stage) : null);
const scopeLevel = (st: St): number => (st.enclosing ? scopeLevel(st.enclosing.stage) : st.level);
const ownStdin = (st: St): boolean => st.stdin !== null || st.heredocs.length > 0 || st.stdinStage !== null;

/** Позиционные параметры целым словом в argv psql; null — форма, которую нельзя раскрыть точно. */
function positionalPlan(st: St): PosRef[] | null {
  const plan: PosRef[] = [];
  for (let k = 0; k < st.argv.length; k++) {
    if (!st.dynamic[k]) continue;
    const s = st.src[k] ?? st.argv[k];
    const q = QUOTED_POS.exec(s);
    const m = q ?? BARE_POS.exec(s);
    if (m) {
      if (k < st.restAt) return null; // слово команды или присвоение перед ней — не аргумент psql
      const ref = m[1] ?? m[2];
      plan.push({ k, ref: ref === '@' ? '@' : Number(ref), quoted: q !== null });
    } else if (POS_LIKE.test(s)) return null;
  }
  return plan;
}

/** Сдвиги позиционных параметров в плоском теле до стадии psql; строка — почему их число не доказать. */
function shiftsBefore(name: string, stages: St[], model: Model<null>, anchor: St): number | string {
  let offset = 0;
  for (const s of stages) {
    if (s === anchor) break;
    if (s.fn !== name) continue;
    if (BODY_OPAQUE.has(s.name) || (s.argv.includes('shift') && s.name !== 'shift')) return `${s.name} в теле ${name} может менять позиционные параметры незаметно для гейта`;
    // set -e / set -euo pipefail трогают только флаги; set -- … и set слово … переназначают $1…$n.
    if (s.name === 'set' && s.rest.some((t, k) => t === '--' || (!/^[-+]/.test(t) && !/^[-+][A-Za-z]*o$/.test(s.rest[k - 1] ?? '')))) return `set в теле ${name} переназначает позиционные параметры`;
    if (s.name !== 'shift') continue;
    if (s.link !== 'none') return `shift в теле ${name} под условием (${s.link === 'and' ? '&&' : '||'}) — число сдвигов не доказать`;
    if (model.pipelines.some((p) => p.length > 1 && p.includes(s))) return `shift в теле ${name} стоит в трубе — выполняется в подоболочке`;
    if (s.rest.some((_, k) => s.dynamic[s.restAt + k])) return `shift в теле ${name} с подстановкой`;
    const n = s.rest.length === 0 ? 1 : s.rest.length === 1 && /^[0-9]+$/.test(s.rest[0]) ? Number(s.rest[0]) : NaN;
    if (!Number.isInteger(n)) return `shift в теле ${name} с нечисловым аргументом`;
    offset += n;
  }
  return offset;
}

/** Все вызовы функции в этой команде — литеральные, из той же оболочки; строка — какой вызов этому не отвечает. */
function callSites(name: string, level: number, stages: St[]): St[] | string {
  const found = stages.filter((s) => s.name === name);
  if (!found.length) return `функция ${name} с psql объявлена, но в этой команде не вызывается — с какими аргументами она запустится, неизвестно`;
  for (const s of found) {
    if (fnOf(s) !== null) return `вызов ${name} из тела функции — аргументы того вызова не литералы`;
    if (scopeLevel(s) !== level) return `вызов ${name} из другой оболочки (sh -c, eval, kubectl exec) — там функция не видна или другая`;
    if (s.viaXargs) return `вызов ${name} через xargs — аргументы приходят со stdin`;
    const dyn = s.rest.filter((_, k) => s.dynamic[s.restAt + k]);
    if (dyn.length) return `вызов ${name} с подстановкой в аргументах (${expansions(dyn.join(' '))})`;
  }
  return found;
}

/** Стадия psql, как она запустится на этом вызове: позиционные параметры — словами вызова, stdin — его stdin. */
function expand(st: St, plan: PosRef[], site: St, offset: number, name: string): St | string {
  const args = site.rest;
  const argv: string[] = [];
  const dynamic: boolean[] = [];
  const src: string[] = [];
  for (let k = 0; k < st.argv.length; k++) {
    const p = plan.find((x) => x.k === k);
    if (!p) { argv.push(st.argv[k]); dynamic.push(st.dynamic[k]); src.push(st.src[k] ?? st.argv[k]); continue; }
    const values = p.ref === '@' ? args.slice(offset) : [args[offset + p.ref - 1]];
    if (values.some((v) => v === undefined)) return `$${p.ref} в теле ${name} за пределами аргументов вызова (${args.length}${offset ? `, shift ${offset}` : ''})`;
    if (!p.quoted && values.some((v) => !PLAIN_WORD.test(v as string))) return `${st.src[k]} без кавычек в теле ${name}: аргумент вызова делится по пробелу или раскрывается как маска`;
    for (const v of values as string[]) { argv.push(v); dynamic.push(false); src.push(v); }
  }
  const own = ownStdin(st);
  return {
    ...st, argv, rest: argv.slice(st.restAt), dynamic, src, inFunction: false, fn: null, viaXargs: false,
    stdin: own ? st.stdin : site.stdin, stdinDynamic: own ? st.stdinDynamic : site.stdinDynamic,
    stdinStage: own ? st.stdinStage : site.stdinStage, heredocs: own ? st.heredocs : site.heredocs,
    tags: own ? st.tags : [...st.tags, ...site.tags.filter((t) => t.startsWith('here-doc'))],
  };
}

/** null — psql от места вызова не зависит; строка — зависит, но раскрыть точно нельзя (почему). */
function resolveCalls(st: St, model: Model<null>, stages: St[]): Resolved | string | null {
  const name = fnOf(st);
  if (name === null) return null;
  const plan = positionalPlan(st);
  const needsStdin = !ownStdin(st) && psqlSourceTokens(st.rest).length === 0;
  if (plan !== null && plan.length === 0 && !needsStdin) return null;
  if (plan === null) return 'позиционные параметры в argv psql не целым словом в кавычках ($*, ${@:2}, $10, $0, склейка) — по вызову точно не раскрыть';
  const info = model.functions.get(name);
  if (!info) return `функция ${name} объявлена вне этой команды`;
  if (info.defs > 1) return `функция ${name} объявлена дважды — какое тело запустится, не доказать`;
  if (!info.flat) return `тело ${name} не плоское (if/for/case/while или подоболочка) — порядок shift и psql не доказать`;
  if (model.assigns.has('IFS')) return 'IFS переназначается в этой команде — раскрытие $@ не доказать';
  let anchor = st;
  while (anchor.fn === null && anchor.enclosing) anchor = anchor.enclosing.stage;
  const offset = shiftsBefore(name, stages, model, anchor);
  if (typeof offset === 'string') return offset;
  const sites = callSites(name, info.level, stages);
  if (typeof sites === 'string') return sites;
  const calls: St[] = [];
  for (const site of sites) {
    const c = expand(st, plan, site, offset, name);
    if (typeof c === 'string') return c;
    calls.push(c);
  }
  return { calls, sites: new Set(sites) };
}

export async function judgeCommand(command: string, cwd: string): Promise<Judgement> {
  const model = buildModel<null>(command, () => null);
  const stages = model.pipelines.flat();
  const deep = model.deep.filter((t) => PG_WORD.test(t));
  const relevant = deep.length > 0 || stages.some((st) => PG_TOOLS.has(st.name) || st.argv.some(isPgToken) || hiddenCall(st, model) !== null);
  if (!relevant) return CLEAN;
  let out: Judgement = CLEAN;
  // Соединение и PGOPTIONS — в любой стадии, в том числе за `kubectl exec pod -- psql`.
  for (const st of stages) for (const t of st.argv) out = worst(out, judgeConnToken(t));
  if (deep.length) out = worst(out, unknown('вызов pg в оболочке глубже трёх уровней вложенности — не разобран'));
  for (const t of model.tags) if (t !== 'nested-depth') out = worst(out, unknown(describeUnknown([t])));
  for (const st of stages) {
    const word = hiddenCall(st, model);
    if (word !== null) out = worst(out, hidden(`вызов pg собран подстановкой (${expansions(word)}) — гейт не видит, что и с какими аргументами запустится`));
    out = worst(out, sessionEnv(st));
    if (!PSQL_LIKE.has(st.name)) continue;
    const calls = resolveCalls(st, model, stages);
    if (calls !== null && typeof calls !== 'string') {
      for (const c of calls.calls) out = worst(out, await judgePsql(c, stages, model, cwd, calls.sites));
      continue;
    }
    out = worst(out, await judgePsql(st, stages, model, cwd));
    if (calls !== null) out = worst(out, hidden(calls));
  }
  return out;
}

// ───────────────────────────── pre-write: SQL внутри записываемого файла ─────────────────────────────

const DOC_EXT = new Set(['.md', '.mdx', '.markdown', '.txt', '.rst']);
/** Текст, описывающий конструкцию, и спеки самого гейта (обязаны содержать нарушение) — не исполнение. */
export function exemptPath(path: string): boolean {
  if (DOC_EXT.has(extname(path).toLowerCase())) return true;
  if (path.includes('/hooks/spec/')) return true;
  return /\.(test|spec)\.(ts|js|mjs|cjs|sh)$/.test(basename(path));
}

const SQL_EXT = new Set(['.sql', '.psql', '.pgsql']);
const STMT_KEYWORD = /\b(with|select|insert|update|delete|merge|create|alter|drop|grant|revoke|set|reset|do|execute|prepare|begin|start|commit|call|truncate|comment)\b/gi;
const OPTIONS_KEY = /(?:^|[^A-Za-z0-9_])["']?(?:pg)?options["']?\s*[:=]\s*["']?\s*-c(?=[\s=]|$)/i;
const TRAILING_JUNK = new Set(["'", '"', '`', ';', ',', ')', ']', '}', '\\']);
const MAX_STRIPS = 8;

async function parseCandidate(text: string): Promise<RawStmt[] | null> {
  let cand = text.trimEnd();
  for (let n = 0; n <= MAX_STRIPS && cand.length; n++) {
    const p = await parseSql(cand);
    if (!p.error && p.stmts.length) return p.stmts;
    if (!TRAILING_JUNK.has(cand[cand.length - 1])) return null;
    cand = cand.slice(0, -1).trimEnd();
  }
  return null;
}

/** DO с dollar-quoted телом может занимать несколько строк: вырезаем по парному тегу. */
function dollarBlock(text: string, from: number): string | null {
  const m = /^do\s*(\$[A-Za-z_]*\$)/i.exec(text.slice(from));
  if (!m) return null;
  const tag = m[1];
  const open = from + m[0].length;
  const close = text.indexOf(tag, open);
  if (close < 0) return null;
  return text.slice(from, close + tag.length);
}

function balancedCall(text: string, open: number): string | null {
  let depth = 0;
  for (let k = open; k < text.length; k++) {
    if (text[k] === '(') depth++;
    else if (text[k] === ')') { depth--; if (depth === 0) return text.slice(open, k + 1); }
  }
  return null;
}

export interface ContentScan { judgement: Judgement; parsed: number }

/** Кандидаты SQL в документе без SQL-грамматики; вердикт — только по распарсенным. */
export async function scanFragments(text: string): Promise<ContentScan> {
  let out: Judgement = CLEAN;
  let parsed = 0;
  const lines = text.split('\n');
  let offset = 0;
  for (const line of lines) {
    if (OPTIONS_KEY.test(line)) out = worst(out, deny('startup-параметр options=-c в строке подключения / манифесте'));
    for (const tok of line.split(/[\s"'`]+/)) if (tok && (tok.startsWith('PGOPTIONS=') || URL_SCHEMES.some((s) => tok.includes(s)))) out = worst(out, judgeConnToken(tok));
    let consumedTo = -1;
    STMT_KEYWORD.lastIndex = 0;
    for (let m = STMT_KEYWORD.exec(line); m; m = STMT_KEYWORD.exec(line)) {
      if (m.index < consumedTo) continue;
      let stmts: RawStmt[] | null = null;
      if (m[1].toLowerCase() === 'do') {
        const block = dollarBlock(text, offset + m.index);
        if (block) stmts = await parseCandidate(block);
      }
      if (!stmts) stmts = await parseCandidate(line.slice(m.index));
      if (!stmts) continue;
      parsed++;
      out = worst(out, judgeStmts(stmts));
      consumedTo = line.length;
    }
    if (consumedTo < 0) {
      // set_config вне распознанного оператора (PERFORM в plpgsql, вызов в JS-строке без SELECT)
      const re = /\bset_config\s*\(/gi;
      for (let m = re.exec(line); m; m = re.exec(line)) {
        const call = balancedCall(line, m.index + m[0].length - 1);
        if (!call) continue;
        const stmts = await parseCandidate(`SELECT set_config${call}`);
        if (stmts) { parsed++; out = worst(out, judgeStmts(stmts)); }
      }
    }
    offset += line.length + 1;
  }
  return { judgement: out, parsed };
}

export async function judgeContent(text: string, path: string): Promise<Judgement> {
  if (SQL_EXT.has(extname(path).toLowerCase())) {
    const whole = await parseSql(text);
    if (!whole.error) return worst(judgeStmts(whole.stmts), (await scanFragments(text)).judgement);
    const scan = await scanFragments(text);
    if (scan.judgement.kind === 'deny') return scan.judgement;
    if (scan.parsed === 0) return unknown(`SQL-файл не разобран (${whole.error.split('\n')[0]}) — доказать безопасность нельзя`);
    return scan.judgement;
  }
  return (await scanFragments(text)).judgement;
}

// ───────────────────────────── гейт ─────────────────────────────

const SILENT: Verdict = { kind: 'silent' };
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function writeTarget(p: PreToolUsePayload): { path: string; text: string } {
  const ti = p.tool_input ?? {};
  switch (p.tool_name) {
    case 'Write': return { path: str(ti.file_path), text: str(ti.content) };
    case 'Edit': return { path: str(ti.file_path), text: str(ti.new_string) };
    case 'NotebookEdit': return { path: str(ti.notebook_path), text: str(ti.new_source) };
    default: return { path: '', text: '' };
  }
}

function toVerdict(j: Judgement): Verdict {
  if (j.kind === 'clean') return SILENT;
  if (j.kind === 'unknown') return { kind: 'unknown', reason: j.reason, gate: NAME };
  return { kind: 'deny', reason: `${j.reason}.\n${j.hint ?? HINT}`, gate: NAME };
}

export async function decide(ctx: GateContext): Promise<Verdict> {
  const p = ctx.payload as PreToolUsePayload;
  if (p.hook_event_name !== 'PreToolUse') return SILENT;
  if (ctx.event === 'pre-bash') {
    if (p.tool_name !== 'Bash') return SILENT;
    const cmd = str(p.tool_input?.command);
    if (!cmd) return SILENT;
    return toVerdict(await judgeCommand(cmd, p.cwd));
  }
  if (ctx.event === 'pre-write') {
    const { path, text } = writeTarget(p);
    if (!path || !text || exemptPath(path)) return SILENT;
    return toVerdict(await judgeContent(text, path));
  }
  return SILENT;
}

register({ name: NAME, events: ['pre-bash', 'pre-write'], killSwitch: KILL, run: decide });
