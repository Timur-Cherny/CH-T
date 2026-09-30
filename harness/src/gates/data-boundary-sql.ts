// data-boundary-sql — правила гейта data-boundary над узлами parseSql. Модуль гейт не регистрирует.
// Режим контура: prod — строки только из каталога и конфигурации, функции из известного списка; dev — строки
// можно, срез нельзя; remote — непокальный без маркера dev/prod: прод не исключён, строки дают unknown.
// Объём: LIMIT > 1000 или ALL — deny; выборка строк без LIMIT — unknown (объём не доказан).
// Regex здесь — только над строками метакоманд psql (строка, начатая `\`): у них нет SQL-грамматики.
import { parseSql, stmtKind, stmtNode, walk } from '../parsers/sql.ts';
import type { Node, RawStmt } from '../parsers/sql.ts';
import { worst } from './judgement.ts';
import type { Judgement } from './judgement.ts';
import { splitPsqlMeta } from '../parsers/psql.ts';
export type Mode = 'prod' | 'dev' | 'remote';
export const CLEAN: Judgement = { kind: 'clean' };
export const deny = (reason: string): Judgement => ({ kind: 'deny', reason });
export const unknown = (reason: string): Judgement => ({ kind: 'unknown', reason });
export const ROWS_LIMIT = 1000;

/** Relations whose rows describe the system (configuration), not its business data. The site lists them in
 *  dataBoundary.configTables; by default nothing is configuration and every prod row is a business row. */
export const NO_CONFIG: ReadonlySet<string> = new Set();
/** Представления каталога, отдающие значения колонок пользовательских таблиц. */
const VALUE_CATALOG: ReadonlySet<string> = new Set(['pg_stats', 'pg_stats_ext', 'pg_stats_ext_exprs']);
/** Сворачивают множество строк в число: колонки в аргументах на выход не попадают. */
const REDUCING: ReadonlySet<string> = new Set([
  'count', 'sum', 'avg', 'bool_and', 'bool_or', 'every', 'bit_and', 'bit_or', 'bit_xor', 'stddev', 'stddev_pop',
  'stddev_samp', 'variance', 'var_pop', 'var_samp', 'corr', 'covar_pop', 'covar_samp', 'percentile_cont',
  'regr_count', 'regr_avgx', 'regr_avgy', 'regr_slope', 'regr_intercept', 'regr_r2', 'regr_sxx', 'regr_syy', 'regr_sxy',
]);
/** Сворачивают, но возвращают настоящее значение строки: под GROUP BY это снова строки. */
const VALUE_SELECTING: ReadonlySet<string> = new Set(['min', 'max', 'mode', 'percentile_disc']);
/** Читают строки по имени отношения, тексту запроса или файлу сервера. */
const ROW_READERS: ReadonlySet<string> = new Set([
  'query_to_xml', 'query_to_xml_and_xmlschema', 'table_to_xml', 'table_to_xml_and_xmlschema', 'cursor_to_xml',
  'schema_to_xml', 'schema_to_xml_and_xmlschema', 'database_to_xml', 'database_to_xml_and_xmlschema',
  'dblink', 'dblink_exec', 'pg_read_file', 'pg_read_binary_file', 'lo_get', 'lo_export', 'loread',
]);
/** Функции, которые на проде не читают строк сами: всё прочее (кроме pg_*) — unknown. */
const SAFE_FUNCS: ReadonlySet<string> = new Set([
  'jsonb_build_object', 'json_build_object', 'jsonb_build_array', 'json_build_array', 'jsonb_agg', 'json_agg',
  'jsonb_object_agg', 'json_object_agg', 'array_agg', 'string_agg', 'to_jsonb', 'to_json', 'row_to_json',
  'jsonb_strip_nulls', 'jsonb_array_length', 'jsonb_typeof', 'jsonb_object_keys', 'jsonb_each', 'jsonb_array_elements',
  'current_setting', 'now', 'version', 'date_trunc', 'date_part', 'extract', 'to_char', 'to_timestamp', 'age',
  'lower', 'upper', 'length', 'char_length', 'concat', 'concat_ws', 'format', 'left', 'right', 'replace', 'split_part',
  'btrim', 'round', 'floor', 'ceil', 'abs', 'array_length', 'cardinality', 'generate_series', 'unnest',
  'to_regclass', 'obj_description', 'col_description', 'format_type', 'has_table_privilege', 'current_database',
]);
const SAFE_SRF: ReadonlySet<string> = new Set(['generate_series', 'unnest', 'jsonb_each', 'jsonb_array_elements', 'jsonb_object_keys']);

interface RangeVarNode { schemaname?: string; relname?: string }
type Proven = (rv: RangeVarNode) => boolean;
interface Scope { ctes: Map<string, Node>; visiting: Set<string> }
interface Keys { ordinals: Set<number>; shapes: Set<string>; any: boolean }
interface ExprInfo { column: boolean; via: string | null; valueAgg: boolean; keyUsed: boolean }

const rel = (rv: RangeVarNode): string => rv.relname ?? '';
export function isCatalog(rv: RangeVarNode): boolean {
  const s = rv.schemaname ?? '';
  if (VALUE_CATALOG.has(rel(rv))) return false;
  return s === 'pg_catalog' || s === 'information_schema' || (s === '' && rel(rv).startsWith('pg_'));
}
export function isConfig(rv: RangeVarNode, config: ReadonlySet<string>): boolean {
  const s = rv.schemaname ?? '';
  return (s === '' || s === 'public') && config.has(rel(rv));
}
const provenCatalog: Proven = isCatalog;
const provenProd = (config: ReadonlySet<string>): Proven => (rv) => isCatalog(rv) || isConfig(rv, config);
const emptyScope = (): Scope => ({ ctes: new Map(), visiting: new Set() });
const NO_KEYS: Keys = { ordinals: new Set(), shapes: new Set(), any: false };

function funcName(fc: Node): string {
  const parts = (fc.funcname as Array<{ String?: { sval?: string } }> | undefined) ?? [];
  return (parts.at(-1)?.String?.sval ?? '').toLowerCase();
}
const unwrapSelect = (n: unknown): Node | null => (n as { SelectStmt?: Node } | undefined)?.SelectStmt ?? null;
const shape = (n: unknown): string => JSON.stringify(n, (k, v) => (k === 'location' ? undefined : v));
const targetsOf = (sel: Node): Node[] => ((sel.targetList as Node[] | undefined) ?? []).map((t) => ((t.ResTarget as Node | undefined)?.val ?? {}) as Node);
const isSetOp = (sel: Node): boolean => String(sel.op ?? 'SETOP_NONE') !== 'SETOP_NONE';

function groupKeys(sel: Node): Keys {
  const ordinals = new Set<number>();
  const shapes = new Set<string>();
  const add = (item: unknown): void => {
    const o = (item ?? {}) as Node;
    const c = o.A_Const as { ival?: { ival?: number } } | undefined;
    if (c && typeof c.ival?.ival === 'number') { ordinals.add(c.ival.ival); return; }
    const gs = o.GroupingSet as { content?: unknown[] } | undefined;
    if (gs) { for (const x of gs.content ?? []) add(x); return; }
    shapes.add(shape(o));
  };
  const items = (sel.groupClause as unknown[] | undefined) ?? [];
  for (const it of items) add(it);
  return { ordinals, shapes, any: items.length > 0 };
}

function withCtes(sel: Node, outer: Scope): Scope {
  const ctes = (sel.withClause as { ctes?: Node[] } | undefined)?.ctes ?? [];
  if (!ctes.length) return outer;
  const map = new Map(outer.ctes);
  for (const c of ctes) {
    const cte = c.CommonTableExpr as { ctename?: string; ctequery?: Node } | undefined;
    if (cte?.ctename && cte.ctequery) map.set(cte.ctename, cte.ctequery);
  }
  return { ctes: map, visiting: outer.visiting };
}

/** Что выражение выводит: данные колонки, строки подзапроса, значение-агрегат, ключ группировки. */
function exprInfo(expr: unknown, keys: Keys, proven: Proven, scope: Scope): ExprInfo {
  const info: ExprInfo = { column: false, via: null, valueAgg: false, keyUsed: false };
  const visit = (n: unknown): void => {
    if (info.via || !n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const x of n) visit(x); return; }
    const o = n as Node;
    if (keys.shapes.size && ('ColumnRef' in o || 'FuncCall' in o || 'A_Expr' in o || 'TypeCast' in o) && keys.shapes.has(shape(o))) { info.keyUsed = true; return; }
    if ('ColumnRef' in o || 'A_Star' in o) { info.column = true; return; }
    if ('FuncCall' in o) {
      const fc = o.FuncCall as Node;
      const name = funcName(fc);
      if (!fc.over && (REDUCING.has(name) || VALUE_SELECTING.has(name))) { if (VALUE_SELECTING.has(name)) info.valueAgg = true; return; }
      visit(fc.args); visit(fc.agg_order);
      return;
    }
    if ('SubLink' in o) {
      const sl = o.SubLink as Node;
      visit(sl.testexpr);
      const sub = unwrapSelect(sl.subselect);
      const t = String(sl.subLinkType ?? '');
      if (sub && (t === 'EXPR_SUBLINK' || t === 'ARRAY_SUBLINK' || t === 'MULTIEXPR_SUBLINK')) info.via = rowSource(sub, proven, scope);
      return;
    }
    for (const v of Object.values(o)) visit(v);
  };
  visit(expr);
  return info;
}

function returningSource(node: Node, proven: Proven, scope: Scope): string | null {
  const list = (node.returningList as Node[] | undefined) ?? [];
  const rv = (node.relation ?? {}) as RangeVarNode;
  if (!list.length || proven(rv)) return null;
  return list.some((t) => exprInfo((t.ResTarget as Node | undefined)?.val, NO_KEYS, proven, scope).column) ? rel(rv) : null;
}

function itemSource(it: Node, proven: Proven, scope: Scope): string | null {
  if ('RangeVar' in it) {
    const rv = it.RangeVar as RangeVarNode;
    const name = rel(rv);
    if (!rv.schemaname && scope.ctes.has(name)) {
      if (scope.visiting.has(name)) return null;
      const body = scope.ctes.get(name) as Node;
      scope.visiting.add(name);
      try {
        const sel = unwrapSelect(body);
        if (sel) return rowSource(sel, proven, scope);
        const kind = Object.keys(body)[0] ?? '';
        return returningSource(((body as Record<string, Node>)[kind] ?? {}) as Node, proven, scope);
      } finally { scope.visiting.delete(name); }
    }
    return proven(rv) ? null : name;
  }
  if ('RangeSubselect' in it) {
    const sub = unwrapSelect((it.RangeSubselect as Node).subquery);
    return sub ? rowSource(sub, proven, scope) : 'подзапрос';
  }
  if ('JoinExpr' in it) {
    const j = it.JoinExpr as Node;
    return itemSource((j.larg ?? {}) as Node, proven, scope) ?? itemSource((j.rarg ?? {}) as Node, proven, scope);
  }
  if ('RangeFunction' in it) {
    const names: string[] = [];
    for (const n of walk(it)) {
      if ('SubLink' in n) { const sub = unwrapSelect((n.SubLink as Node).subselect); const r = sub ? rowSource(sub, proven, scope) : null; if (r) return r; }
      if ('FuncCall' in n) names.push(funcName(n.FuncCall as Node));
    }
    return names.every((f) => SAFE_SRF.has(f) || (f.startsWith('pg_') && !ROW_READERS.has(f))) ? null : `${names[0] ?? 'функция'}()`;
  }
  if ('RangeTableSample' in it) return itemSource(((it.RangeTableSample as Node).relation ?? {}) as Node, proven, scope);
  return 'источник FROM неизвестного вида';
}

const fromSource = (sel: Node, proven: Proven, scope: Scope): string | null => {
  for (const it of (sel.fromClause as Node[] | undefined) ?? []) { const r = itemSource(it, proven, scope); if (r) return r; }
  return null;
};

/** Имя недоказанного отношения, чьи данные доходят до выхода оператора, или null. */
export function rowSource(sel: Node, proven: Proven, outer: Scope): string | null {
  const scope = withCtes(sel, outer);
  if (isSetOp(sel)) return rowSource((sel.larg ?? {}) as Node, proven, scope) ?? rowSource((sel.rarg ?? {}) as Node, proven, scope);
  const keys = groupKeys(sel);
  let column = false;
  for (const [i, val] of targetsOf(sel).entries()) {
    if (keys.ordinals.has(i + 1)) continue;
    const info = exprInfo(val, keys, proven, scope);
    if (info.via) return info.via;
    if (info.column) column = true;
  }
  return column ? fromSource(sel, proven, scope) : null;
}

/** Выход — много строк недоказанного каталогом отношения (не агрегат без GROUP BY). */
function bulkSource(sel: Node, scope: Scope): string | null {
  const inner = withCtes(sel, scope);
  if (isSetOp(sel)) return bulkSource((sel.larg ?? {}) as Node, inner) ?? bulkSource((sel.rarg ?? {}) as Node, inner);
  const src = fromSource(sel, provenCatalog, inner);
  if (!src) return null;
  const keys = groupKeys(sel);
  return keys.any || targetsOf(sel).some((v) => exprInfo(v, keys, provenCatalog, inner).column) ? src : null;
}

function groupedLeak(sel: Node, scope: Scope, config: ReadonlySet<string>): string | null {
  const inner = withCtes(sel, scope);
  if (isSetOp(sel)) return groupedLeak((sel.larg ?? {}) as Node, inner, config) ?? groupedLeak((sel.rarg ?? {}) as Node, inner, config);
  const proven = provenProd(config);
  const keys = groupKeys(sel);
  if (!keys.any) return null;
  const src = fromSource(sel, proven, inner) ?? (() => { for (const it of (sel.fromClause as Node[] | undefined) ?? []) { if ('RangeVar' in it && !proven(it.RangeVar as RangeVarNode)) return rel(it.RangeVar as RangeVarNode); } return null; })();
  if (!src) return null;
  const leaks = targetsOf(sel).some((v, i) => { if (keys.ordinals.has(i + 1)) return true; const info = exprInfo(v, keys, proven, inner); return info.keyUsed || info.valueAgg; });
  return leaks ? src : null;
}

function limitOf(sel: Node): { kind: 'none' } | { kind: 'small' } | { kind: 'big'; label: string } {
  const c = (sel.limitCount as Node | undefined)?.A_Const as { isnull?: boolean; ival?: { ival?: number } } | undefined;
  if (!c) return { kind: 'none' };
  if (c.isnull) return { kind: 'big', label: 'ALL' };
  const n = c.ival?.ival ?? 0;
  return n > ROWS_LIMIT ? { kind: 'big', label: String(n) } : { kind: 'small' };
}

function judgeOutput(sel: Node, mode: Mode, config: ReadonlySet<string>): Judgement {
  const scope = emptyScope();
  if (mode !== 'dev') {
    const src = rowSource(sel, provenProd(config), scope);
    if (src) return mode === 'prod' ? deny(`прод-строки: оператор выдаёт строки «${src}» — это не каталог и не конфигурация`) : unknown(`строки «${src}» из непокального контура без маркера dev/prod — прод не исключён`);
    const g = mode === 'prod' ? groupedLeak(sel, scope, config) : null;
    if (g) return unknown(`GROUP BY по «${g}» выводит значения колонки — кардинальность ключа не доказана`);
  }
  const bulk = bulkSource(sel, scope);
  if (!bulk) return CLEAN;
  const lim = limitOf(sel);
  if (lim.kind === 'big') return deny(`выкачка: LIMIT ${lim.label} из «${bulk}» в непокальном контуре`);
  if (lim.kind === 'none') return unknown(`выборка из «${bulk}» без LIMIT в непокальном контуре — объём не доказан`);
  return CLEAN;
}

function judgeCopy(node: Node): Judgement {
  if (node.is_from) return CLEAN;
  const q = unwrapSelect(node.query);
  const rv = (node.relation ?? {}) as RangeVarNode;
  const src = q ? rowSource(q, provenCatalog, emptyScope()) ?? bulkSource(q, emptyScope()) : isCatalog(rv) ? null : rel(rv);
  return src ? deny(`выкачка: COPY … TO выгружает «${src}» из непокального контура`) : CLEAN;
}

function judgeReturning(node: Node, mode: Mode, config: ReadonlySet<string>): Judgement {
  if (mode === 'dev') return CLEAN;
  const src = returningSource(node, provenProd(config), emptyScope());
  if (!src) return CLEAN;
  return mode === 'prod' ? deny(`прод-строки: RETURNING выдаёт строки «${src}»`) : unknown(`RETURNING выдаёт строки «${src}» из непокального контура — прод не исключён`);
}

function functionVerdict(stmt: unknown): Judgement {
  let out = CLEAN;
  for (const n of walk(stmt)) {
    if (!('FuncCall' in n)) continue;
    const name = funcName(n.FuncCall as Node);
    if (ROW_READERS.has(name)) return deny(`прод-строки: функция ${name}() читает строки по имени или тексту запроса`);
    if (!SAFE_FUNCS.has(name) && !REDUCING.has(name) && !VALUE_SELECTING.has(name) && !name.startsWith('pg_')) out = worst(out, unknown(`функция ${name}() на проде вне известного списка — может читать строки`));
  }
  return out;
}

export function judgeStmts(stmts: RawStmt[], mode: Mode, config: ReadonlySet<string> = NO_CONFIG): Judgement {
  let out = CLEAN;
  const prepared = new Set<string>();
  const cursors = new Set<string>();
  const query = (q: unknown): Judgement => { const sel = unwrapSelect(q); if (sel) return judgeOutput(sel, mode, config); const k = Object.keys((q ?? {}) as Node)[0] ?? ''; return judgeReturning(((q as Record<string, Node>)?.[k] ?? {}) as Node, mode); };
  for (const s of stmts) {
    const kind = stmtKind(s);
    const node = stmtNode<Node>(s) ?? {};
    if (mode === 'prod') out = worst(out, functionVerdict(s.stmt));
    switch (kind) {
      case 'SelectStmt': out = worst(out, judgeOutput(node, mode, config)); break;
      case 'DeclareCursorStmt': cursors.add(String(node.portalname ?? '')); out = worst(out, query(node.query)); break;
      case 'PrepareStmt': prepared.add(String(node.name ?? '')); out = worst(out, query(node.query)); break;
      case 'CopyStmt': out = worst(out, judgeCopy(node)); break;
      case 'InsertStmt': case 'UpdateStmt': case 'DeleteStmt': case 'MergeStmt': out = worst(out, judgeReturning(node, mode, config)); break;
      case 'DoStmt': case 'CallStmt': out = worst(out, unknown(`${kind === 'DoStmt' ? 'DO-блок' : 'CALL'}: тело непрозрачно — строки и выгрузка на выходе не исключены`)); break;
      case 'ExecuteStmt': if (!prepared.has(String(node.name ?? ''))) out = worst(out, unknown(`EXECUTE ${String(node.name ?? '')}: PREPARE вне видимого пакета — тело непрозрачно`)); break;
      case 'FetchStmt': if (!cursors.has(String(node.portalname ?? ''))) out = worst(out, unknown('FETCH из курсора, объявленного вне пакета — запрос непрозрачен')); break;
      default: break;
    }
  }
  return out;
}

export async function judgeParsed(sql: string, mode: Mode, config: ReadonlySet<string> = NO_CONFIG): Promise<Judgement> {
  const p = await parseSql(sql);
  if (p.error) return unknown(`SQL не разобран (${p.error.split('\n')[0]}) — доказать нельзя`);
  return judgeStmts(p.stmts, mode, config);
}



export async function judgeSqlText(text: string, mode: Mode, config: ReadonlySet<string> = NO_CONFIG): Promise<Judgement> {
  const meta = splitPsqlMeta(text);
  let out = CLEAN;
  for (const o of meta.opaque) out = worst(out, unknown(`psql ${o}: тело SQL вне видимого текста`));
  for (const c of meta.copies) out = worst(out, await judgeParsed(`COPY ${c}`, mode, config));
  if (meta.sql.trim()) out = worst(out, await judgeParsed(meta.sql, mode, config));
  return out;
}
