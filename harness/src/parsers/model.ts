// Модель команды из дерева (parser.ts): стадии из Simple, трубы из Pipeline, link из AndOr, функции из Func,
// плоскость тела — по узлам (if/while/for/case/подоболочка), dynamic — слово с частью-подстановкой, src — исходный
// текст слова, level +1 за $(…), тело sh -c / eval / ssh / su / watch и argv за kubectl exec --. Обёртки — логика
// модели, как и прежде; гейты получают тот же Stage. Здесь же ShellParse (tokenizeAst) для гейтов, которым нужны
// сегменты: команда — сегмент, слова-ключи и редиректы в argv не попадают, тела $(…) и sh -c идут следом за
// своим сегментом на глубину +1. Ошибка грамматики — тег parse-error на модели: гейт отвечает unknown, не silent.
import { basename } from 'node:path';
import { parseShell } from './parser.ts';
import { partsDynamic, substitutionsOf, wordValue } from './ast.ts';
import type { Command, List, ParseError, Part, Pipeline, Redirect, Script, Simple, Word } from './ast.ts';
import { effective, hasExpansion } from './argv.ts';
import type { Flow, OpaqueSpan, Segment, ShellParse, TokenizeOptions } from './argv.ts';
import { ASSIGN, IGNORED_TAGS, MAX_LEVEL, MENTIONS, NOT_A_FILE, SHELLS, WRAPPER_NAMES, WRITERS, kubeParse, quoteArgv, sshCommand, stripPrefixes } from './stage.ts';
import type { Enclosing, Inherit, Model, OnExec, Stage, Stdout } from './stage.ts';
import { PSQL_LIKE, psqlSources, splitPsqlMeta } from './psql.ts';

const NO_KEYWORDS: ReadonlySet<string> = new Set();
/** Составные команды, после которых тело функции не плоское: порядок и число shift не доказать. */
const COMPOUND: ReadonlySet<string> = new Set(['if', 'while', 'until', 'for', 'select', 'for-arith', 'case', 'subshell']);
type SubPart = Extract<Part, { t: 'cmd' | 'proc' }>;

interface Redirected { stdin: string | null; stdinDynamic: boolean; stdout: Stdout; stdoutTo: string | null; writes: string[]; heredocs: string[]; tags: string[] }

/** Редиректы стадии (§2.7) в порядке текста, последний побеждает; внешние (группы, if, цикла) идут первыми. */
function classify(rs: Redirect[]): Redirected {
  const out: Redirected = { stdin: null, stdinDynamic: false, stdout: 'tty', stdoutTo: null, writes: [], heredocs: [], tags: [] };
  const toStdout = (target: string): void => {
    out.stdout = target === '/dev/null' ? 'null' : /^\/dev\/(stderr|tty)$/.test(target) ? 'stderr' : target === '/dev/stdout' ? 'tty' : 'file';
    out.stdoutTo = out.stdout === 'file' ? target : null;
  };
  for (const r of rs) {
    if (r.here) {
      out.heredocs.push(r.here.body);
      if (!r.here.terminated) out.tags.push('here-doc-unterminated');
      else if (!r.here.quoted && hasExpansion(r.here.body)) out.tags.push('here-doc-expansion');
      continue;
    }
    const target = r.target ? wordValue(r.target) : '';
    const dyn = r.target ? partsDynamic(r.target.parts) : false;
    const onStdout = r.fd === null || r.fd === 1;
    switch (r.op) {
      case '<': out.stdin = target; out.stdinDynamic = dyn; break;
      case '<<<': out.heredocs.push(`${target}\n`); if (dyn) out.tags.push('here-doc-expansion'); break;
      case '<>': if (!NOT_A_FILE.test(target)) out.writes.push(target); break;
      case '>': case '>>': case '>|': case '&>': case '&>>':
        if (!NOT_A_FILE.test(target)) out.writes.push(target);
        if (onStdout || r.op.startsWith('&')) toStdout(target);
        break;
      case '>&':
        if (/^\d+$/.test(target) || target === '-') { if (onStdout) { out.stdout = target === '2' ? 'stderr' : 'tty'; out.stdoutTo = null; } }
        else { if (!NOT_A_FILE.test(target)) out.writes.push(target); toStdout(target); }
        break;
      default: break;
    }
  }
  return out;
}

interface Ctx<K> {
  text: string; level: number; enclosing: Enclosing<K> | null; kube: K | null; model: Model<K>; onExec: OnExec<K>;
  inherit: Inherit<K> | null; fns: string[]; count: number; errors: ParseError[]; outer: Redirect[];
}
/** Конвейер, куда встаёт стадия; last — стадия последняя в нём: конвейер публикуется до обхода её обёрток, как и прежде
 *  (тела `$(…)` и sh -c последней стадии идут за конвейером, у остальных стадий — перед ним). */
interface Slot<K> { pipe: Stage<K>[]; link: Stage<K>['link']; last: boolean; pushed: boolean }
interface Input { argv: string[]; dyn: boolean[]; src: string[]; raw: string; r: Redirected; subs: Array<{ part: SubPart; prefix: string }>; span: [number, number] | null }

export function buildModelAst<K>(command: string, onExec: OnExec<K>): Model<K> {
  const model: Model<K> = { pipelines: [], tags: [], assigns: new Map(), deep: [], unparsed: [], functions: new Map() };
  buildText(command, 0, null, null, model, onExec, false, null);
  return model;
}

function buildText<K>(text: string, level: number, enclosing: Enclosing<K> | null, kube: K | null, model: Model<K>, onExec: OnExec<K>, expandedByOuter: boolean, inherit: Inherit<K> | null): void {
  if (level > MAX_LEVEL) { model.tags.push('nested-depth'); model.deep.push(text); return; }
  const script = parseShell(text, { expandedByOuter });
  const ctx: Ctx<K> = { text, level, enclosing, kube, model, onExec, inherit, fns: [], count: 0, errors: [...script.errors], outer: [] };
  walkList(script.body, ctx);
  for (const e of ctx.errors) {
    if (!IGNORED_TAGS.has(e.kind)) model.tags.push(e.kind);
    if (e.kind === 'parse-error') model.unparsed.push(e.text);
  }
}

/** Ошибки лексера внутри отрезка стадии — её теги: незакрытая кавычка, here-doc без ограничителя, подстановка в теле. */
function takeErrors(ctx: Ctx<unknown>, at: number, end: number): string[] {
  const own = ctx.errors.filter((e) => e.at >= at && e.at < end && e.kind !== 'parse-error');
  if (own.length) ctx.errors = ctx.errors.filter((e) => !own.includes(e));
  return own.map((e) => e.kind).filter((k) => !IGNORED_TAGS.has(k));
}

function walkList<K>(list: List, ctx: Ctx<K>): void {
  for (const a of list.items) {
    a.pipelines.forEach((p, i) => {
      const link: Stage<K>['link'] = i === 0 ? 'none' : a.ops[i - 1] === '&&' ? 'and' : 'or';
      const slot: Slot<K> = { pipe: [], link, last: false, pushed: false };
      p.commands.forEach((c, j) => { slot.link = j === 0 ? link : 'none'; slot.last = j === p.commands.length - 1; walkCommand(c, ctx, slot); });
      if (slot.pipe.length && !slot.pushed) { slot.pushed = true; ctx.model.pipelines.push(slot.pipe); }
    });
  }
}

const opaqueFns = (ctx: Ctx<unknown>): void => { for (const n of ctx.fns) { const info = ctx.model.functions.get(n); if (info) info.flat = false; } };

function withOuter<K>(ctx: Ctx<K>, rs: Redirect[], fn: () => void): void {
  const saved = ctx.outer;
  ctx.outer = rs.length ? [...saved, ...rs] : saved;
  fn();
  ctx.outer = saved;
}

/** Подстановки в словах составной команды (`for f in $(ls)`, `case $(x) in`) — уровень +1 без охватывающей стадии. */
function wordSubs<K>(words: Word[], ctx: Ctx<K>): void {
  for (const w of words) for (const { part, prefix } of substitutionsOf(w)) buildSub(part, prefix, null, ctx);
}

function walkCommand<K>(c: Command, ctx: Ctx<K>, slot: Slot<K>): void {
  switch (c.kind) {
    case 'simple': stageFromSimple(c, ctx, slot); return;
    case 'group': withOuter(ctx, c.redirects, () => walkList(c.body, ctx)); return;
    case 'subshell': opaqueFns(ctx); withOuter(ctx, c.redirects, () => walkList(c.body, ctx)); return;
    case 'if': opaqueFns(ctx); withOuter(ctx, c.redirects, () => { for (const k of c.clauses) { walkList(k.cond, ctx); walkList(k.body, ctx); } if (c.otherwise) walkList(c.otherwise, ctx); }); return;
    case 'while': case 'until': opaqueFns(ctx); withOuter(ctx, c.redirects, () => { walkList(c.cond, ctx); walkList(c.body, ctx); }); return;
    case 'for': case 'select': opaqueFns(ctx); wordSubs(c.words ?? [], ctx); withOuter(ctx, c.redirects, () => walkList(c.body, ctx)); return;
    case 'for-arith': opaqueFns(ctx); withOuter(ctx, c.redirects, () => walkList(c.body, ctx)); return;
    case 'case': opaqueFns(ctx); wordSubs([c.word, ...c.items.flatMap((it) => it.patterns)], ctx); withOuter(ctx, c.redirects, () => { for (const it of c.items) walkList(it.body, ctx); }); return;
    case 'cond': wordSubs(c.words, ctx); return;
    case 'arith': return;
    case 'func': {
      const info = ctx.model.functions.get(c.name);
      const flat = isFlat(c.body);
      if (info) { info.defs++; if (info.level !== ctx.level || !flat) info.flat = false; } else ctx.model.functions.set(c.name, { defs: 1, level: ctx.level, flat });
      ctx.fns.push(c.name);
      walkCommand(c.body, ctx, { pipe: [], link: 'none', last: true, pushed: false });
      ctx.fns.pop();
      return;
    }
  }
}

/** Плоское тело: последовательность простых команд в группах без ветвлений, циклов и подоболочек. */
function isFlat(c: Command): boolean {
  if (COMPOUND.has(c.kind)) return false;
  if (c.kind === 'group') return c.body.items.every((a) => a.pipelines.every((p) => p.commands.every(isFlat)));
  if (c.kind === 'func') return isFlat(c.body);
  return true;
}

function stageFromSimple<K>(c: Simple, ctx: Ctx<K>, slot: Slot<K>): void {
  const argv: string[] = []; const dyn: boolean[] = []; const src: string[] = [];
  for (const w of c.words) { argv.push(wordValue(w)); dyn.push(partsDynamic(w.parts)); src.push(w.text); }
  const targets = c.redirects.flatMap((r) => (r.target ? [r.target] : []));
  const subs = [...c.words, ...targets].flatMap((w) => substitutionsOf(w));
  const r = classify([...ctx.outer, ...c.redirects]);
  makeStage({ argv, dyn, src, raw: ctx.text.slice(c.at, c.end).trim(), r, subs, span: [c.at, c.end] }, ctx, slot);
}

const isShellFlag = (t: string): boolean => /^-[A-Za-z]*c[A-Za-z]*$/.test(t);
interface Args { args: string[]; argDyn: boolean[]; argSrc: string[] }

/** Команда в переменной с литеральным значением из этой же команды (`PSQL=/opt/…/psql; $PSQL -c …`) видна
 *  целиком: значение подставляется, и судится обычный вызов. Значение из подстановки остаётся словом-подстановкой. */
function resolveLiteral(a: Args, model: Model<unknown>): Args {
  const eff = effective(a.args);
  const cmdAt = a.args.indexOf(eff.name);
  const ref = cmdAt >= 0 && a.argDyn[cmdAt] ? /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(eff.name) : null;
  const values = ref ? model.assigns.get(ref[1]) : undefined;
  if (!values?.length || values.some((v) => hasExpansion(v, 'dq'))) return a;
  const words = values[values.length - 1].trim().split(/\s+/).filter(Boolean);
  if (!words.length) return a;
  return {
    args: [...a.args.slice(0, cmdAt), ...words, ...a.args.slice(cmdAt + 1)],
    argDyn: [...a.argDyn.slice(0, cmdAt), ...words.map(() => false), ...a.argDyn.slice(cmdAt + 1)],
    argSrc: [...a.argSrc.slice(0, cmdAt), ...words, ...a.argSrc.slice(cmdAt + 1)],
  };
}

/** psql или оболочка с -c аргументом любой другой обёртки (docker exec, sudo -u postgres, find -exec, ssh host):
 *  задуманный argv команды внутри. Команды, которые имя psql только называют (MENTIONS), обёртками не считаются. */
function wrapped(name: string, st: Stage<unknown>, raw: string): { argv: string[]; from: number } | null {
  if (SHELLS.has(name) || PSQL_LIKE.has(name) || WRAPPER_NAMES.has(name) || (MENTIONS.has(name) && name !== 'find') || /(^|\s)command\s+-[vV]\b/.test(raw)) return null;
  const j = name === 'find' ? -1 : st.rest.findIndex((t) => PSQL_LIKE.has(basename(t)));
  const s = st.rest.findIndex((t, k) => SHELLS.has(basename(t)) && isShellFlag(st.rest[k + 1] ?? ''));
  const from = j >= 0 ? j : s;
  return from >= 0 ? { argv: st.rest.slice(from), from } : null;
}

function makeStage<K>(input: Input, ctx: Ctx<K>, slot: Slot<K>): void {
  const { model, onExec, level } = ctx;
  const pre = stripPrefixes(input.argv, NO_KEYWORDS);
  const { args, argDyn, argSrc } = resolveLiteral({ args: pre.args, argDyn: input.dyn.slice(pre.skipped), argSrc: input.src.slice(pre.skipped) }, model);
  const eff = effective(args);
  const cmdAt = args.indexOf(eff.name);
  const name = eff.name === '' && args[0] === 'env' ? 'env' : basename(eff.name).replace(/^=/, '');
  const restAt = pre.skipped + (cmdAt < 0 ? args.length : cmdAt + 1);
  const first = ctx.inherit !== null && !slot.pipe.length && (ctx.count === 0 || ctx.inherit.all) ? ctx.inherit : null;
  ctx.count++;
  const inFunction = ctx.fns.length > 0;
  const fn = inFunction ? ctx.fns[ctx.fns.length - 1] : first?.fn ?? null;
  const { r } = input;
  const inheritsStdin = first !== null && r.stdin === null && !r.heredocs.length;
  const own = input.span ? takeErrors(ctx, input.span[0], input.span[1]) : [];
  const st: Stage<K> = {
    argv: [...input.argv.slice(0, pre.skipped), ...args], name, rest: eff.rest, raw: input.raw,
    heredocs: inheritsStdin ? [...first.heredocs] : r.heredocs,
    tags: [...r.tags, ...own, ...(inheritsStdin ? first.tags : [])],
    stdin: r.stdin ?? first?.stdin ?? null, stdout: r.stdout, stdoutTo: r.stdoutTo, enclosing: ctx.enclosing, kube: ctx.kube, viaXargs: pre.viaXargs,
    dynamic: [...input.dyn.slice(0, pre.skipped), ...argDyn], restAt, stdinDynamic: r.stdin !== null ? r.stdinDynamic : first?.stdinDynamic ?? false,
    inFunction: inFunction || fn !== null, writes: [...r.writes, ...(WRITERS[name]?.(eff.rest) ?? [])],
    stdinStage: slot.pipe.length ? slot.pipe[slot.pipe.length - 1] : first?.stdinStage ?? null,
    src: [...input.src.slice(0, pre.skipped), ...argSrc], fn, level, link: slot.link,
  };
  const assigns = name === 'export' || name === 'declare' ? st.rest : args.slice(0, cmdAt < 0 ? args.length : cmdAt);
  for (const a of assigns) { const m = ASSIGN.exec(a); if (m) model.assigns.set(m[1], [...(model.assigns.get(m[1]) ?? []), m[2]]); }
  slot.pipe.push(st);
  if (slot.last && !slot.pushed) { slot.pushed = true; model.pipelines.push(slot.pipe); }
  const restDynamic = (k: number): boolean => st.dynamic[restAt + k] === true;
  const bodyInherit: Inherit<K> = { stdin: st.stdin, stdinDynamic: st.stdinDynamic, stdinStage: st.stdinStage, heredocs: st.heredocs, tags: st.tags.filter((t) => t.startsWith('here-doc')), fn: null, all: true };
  const asBody = (text: string, dynamic: boolean): void => buildText(text, level + 1, null, ctx.kube, model, onExec, dynamic, bodyInherit);
  if (SHELLS.has(name)) {
    const k = st.rest.findIndex(isShellFlag);
    if (k >= 0 && st.rest[k + 1] !== undefined) asBody(st.rest[k + 1], restDynamic(k + 1));
    else for (const body of st.heredocs) buildText(body, level + 1, null, ctx.kube, model, onExec, st.tags.includes('here-doc-expansion'), null);
  }
  if (name === 'eval') asBody(st.rest.join(' '), st.rest.some((_, k) => restDynamic(k)));
  if (name === 'ssh') { const c = sshCommand(st.rest); if (c) asBody(c.text, c.at.some((k) => restDynamic(k))); }
  if (name === 'su') {
    const k = st.rest.findIndex((t) => t === '-c' || t === '--command');
    const eq = st.rest.findIndex((t) => t.startsWith('--command='));
    if (k >= 0 && st.rest[k + 1] !== undefined) asBody(st.rest[k + 1], restDynamic(k + 1));
    else if (eq >= 0) asBody(st.rest[eq].slice('--command='.length), restDynamic(eq));
  }
  if (input.argv.slice(0, pre.skipped).includes('watch') && args.length === 1 && /\s/.test(args[0])) asBody(args[0], argDyn[0] === true);
  for (const { part, prefix } of input.subs) buildSub(part, prefix, st, ctx);
  const kp = name === 'kubectl' ? kubeParse(st.rest) : null;
  if (kp?.sub === 'exec' && kp.inner?.length) enterArgv(st, restAt, kp.inner, st.rest.indexOf('--') + 1, onExec(kp, model), ctx);
  else { const w = wrapped(name, st, input.raw); if (w) enterArgv(st, restAt, w.argv, w.from, ctx.kube, ctx); }
  if (PSQL_LIKE.has(name) || WRAPPER_NAMES.has(name)) {
    const texts = [...psqlSources(st.rest).flatMap((x) => (x.kind === 'inline' ? [x.sql] : [])), ...st.heredocs];
    for (const t of texts) for (const sh of splitPsqlMeta(t).shells) buildText(sh, level + 1, null, null, model, onExec, false, null);
  }
}

/** Команда внутри обёртки получает argv готовыми словами: `$(…)` в нём раскрыла локальная оболочка, повторный
 *  разбор текста запустил бы её второй раз «внутри». Stdin обёртки (here-doc, `<`, труба) — stdin команды: без -i
 *  он до пода не дойдёт, но SQL в нём — намерение его выполнить, и судится так же. */
function enterArgv<K>(st: Stage<K>, restAt: number, argvInner: string[], from: number, kube: K | null, ctx: Ctx<K>): void {
  const raw = quoteArgv(argvInner);
  if (ctx.level + 1 > MAX_LEVEL) { ctx.model.tags.push('nested-depth'); ctx.model.deep.push(raw); return; }
  const inner: Ctx<K> = { ...ctx, level: ctx.level + 1, enclosing: null, kube, fns: [], count: 0, errors: [], outer: [], inherit: { stdin: st.stdin, stdinDynamic: st.stdinDynamic, stdinStage: st.stdinStage, heredocs: [], tags: [], fn: st.fn, all: false } };
  const r: Redirected = { stdin: null, stdinDynamic: false, stdout: 'tty', stdoutTo: null, writes: [], heredocs: st.heredocs, tags: st.tags.filter((t) => t.startsWith('here-doc')) };
  const dyn = argvInner.map((_, j) => st.dynamic[restAt + from + j] === true);
  makeStage({ argv: argvInner, dyn, src: st.src.slice(restAt + from, restAt + from + argvInner.length), raw, r, subs: [], span: null }, inner, { pipe: [], link: 'none', last: true, pushed: false });
}

/** Тело подстановки: уже разобрано той же грамматикой — обходится на уровне +1 с охватывающей стадией. */
function buildSub<K>(part: SubPart, prefix: string, st: Stage<K> | null, ctx: Ctx<K>): void {
  const level = ctx.level + 1;
  const bodyText = part.t === 'cmd' && part.bt ? part.body.src : part.src.slice(2, -1);
  if (level > MAX_LEVEL) { ctx.model.tags.push('nested-depth'); ctx.model.deep.push(bodyText); return; }
  const inPlace = !(part.t === 'cmd' && part.bt);
  const child: Ctx<K> = { ...ctx, level, enclosing: st ? { stage: st, prefix } : null, inherit: null, fns: [], count: 0, outer: [], text: part.body.src, errors: inPlace ? ctx.errors : [...part.body.errors] };
  walkList(part.body.body, child);
  if (inPlace) ctx.errors = child.errors;
  else for (const e of child.errors) if (!IGNORED_TAGS.has(e.kind)) ctx.model.tags.push(e.kind);
}

// ---------------------------------------------------------------------------------------------------------------
// ShellParse для гейтов по сегментам (resource, commit-msg, git-argv, pre-push, sweep).

const MAX_DEPTH = 1;

export function tokenizeAst(cmd: string, depth = 0, opts: TokenizeOptions = {}, base: Flow = { scope: '' }): ShellParse {
  const script = parseShell(cmd, opts);
  const out: ShellParse = { segments: [], unknown: [], opaque: [] };
  const errors = [...script.errors];
  collect(script, depth, out, errors, opts, base);
  for (const e of errors) { const span = { kind: e.kind, text: e.text }; out.opaque.push(span); out.unknown.push(e.kind); }
  out.unknown = [...new Set(out.unknown)];
  return out;
}

const SETTLED: ReadonlySet<string> = new Set(['cd', 'chdir', 'pushd', 'true', ':', 'export', 'local', 'declare', 'typeset', 'readonly']);
const APPEND = /^[A-Za-z_][A-Za-z0-9_]*\+=/;

/** A step that succeeds whenever it runs, taking `cd` as succeeding: an `&&` after it runs on every path that runs it.
 *  A bare assignment returns the status of its last substitution, so one with a substitution may fail. */
function settles(p: Pipeline): boolean {
  const c = p.commands.length === 1 && !p.negated ? p.commands[0] : null;
  if (c?.kind !== 'simple' || !c.words.length) return false;
  const argv = c.words.map(wordValue);
  if (SETTLED.has(effective(argv).name)) return true;
  return argv.every((w) => ASSIGN.test(w) || APPEND.test(w)) && !c.words.some((w) => substitutionsOf(w).length);
}

/** Простые команды дерева в порядке текста, с телами подстановок следом за своим сегментом на глубину +1. */
function collect(script: Script, depth: number, out: ShellParse, errors: ParseError[], opts: TokenizeOptions, base: Flow): void {
  const simples: Array<{ c: Simple; flow: Flow }> = [];
  const visit = (c: Command, scope: string): void => {
    switch (c.kind) {
      case 'simple': simples.push({ c, flow: { scope } }); return;
      case 'group': visitList(c.body, scope); return;
      case 'subshell': visitList(c.body, `${scope}/(${c.at}`); return;
      case 'if': {
        let cond = scope;
        c.clauses.forEach((k, i) => {
          if (i) cond = `${cond}/?${k.cond.at}`;
          visitList(k.cond, cond);
          visitList(k.body, `${cond}/?${k.body.at}`);
        });
        if (c.otherwise) visitList(c.otherwise, `${cond}/?${c.otherwise.at}`);
        return;
      }
      case 'while': case 'until': visitList(c.cond, `${scope}/l${c.at}`); visitList(c.body, `${scope}/l${c.at}`); return;
      case 'for': case 'select': visitList(c.body, `${scope}/l${c.at}:${wordValue(c.name)}`); return;
      case 'for-arith': visitList(c.body, `${scope}/l${c.at}`); return;
      case 'case': for (const it of c.items) visitList(it.body, `${scope}/?${it.at}`); return;
      case 'func': visit(c.body, `${scope}/f${c.at}`); return;
      default: return;
    }
  };
  // Steps every path runs share the list's scope; an && chain after them is one branch, each step after an || its own.
  const visitList = (l: List, scope: string): void => {
    for (const a of l.items) {
      const at = a.bg ? `${scope}/&${a.at}` : scope;
      let lead = true;
      let or = false;
      a.pipelines.forEach((p, j) => {
        if (j) { lead &&= a.ops[j - 1] === '&&' && settles(a.pipelines[j - 1]); or ||= a.ops[j - 1] === '||'; }
        const where = lead ? at : or ? `${at}/?${p.at}` : `${at}/?${a.at}`;
        if (p.commands.length === 1) { visit(p.commands[0], where); return; }
        p.commands.forEach((c, k) => visit(c, `${where}/${k === p.commands.length - 1 ? '~' : '|'}${c.at}`));
      });
    }
  };
  visitList(script.body, base.scope);
  for (const { c, flow } of simples) segment(c, script, depth, out, errors, opts, flow);
}

function segment(c: Simple, script: Script, depth: number, out: ShellParse, errors: ParseError[], opts: TokenizeOptions, flow: Flow): void {
  const spans: OpaqueSpan[] = [];
  const kinds: string[] = [];
  const note = (kind: string, text: string): void => { const s = { kind, text }; spans.push(s); kinds.push(kind); out.opaque.push(s); out.unknown.push(kind); };
  const argv: string[] = []; const src: string[] = []; const dynamic: number[] = [];
  const subs: SubPart[] = [];
  for (const w of c.words) {
    if (partsDynamic(w.parts)) dynamic.push(argv.length);
    argv.push(wordValue(w)); src.push(w.text);
    for (const { part } of substitutionsOf(w)) { note('command-substitution', part.src); subs.push(part); }
  }
  const heredocs: string[] = [];
  for (const r of c.redirects) {
    if (r.here) {
      heredocs.push(r.here.body);
      if (!r.here.terminated) note('here-doc-unterminated', r.here.body);
      else if (!r.here.quoted && hasExpansion(r.here.body)) note('here-doc-expansion', r.here.body);
      continue;
    }
    if (!r.target) continue;
    if (r.op === '<<<') { heredocs.push(`${wordValue(r.target)}\n`); if (partsDynamic(r.target.parts)) note('here-doc-expansion', r.target.text); }
    for (const { part } of substitutionsOf(r.target)) { note('command-substitution', part.src); subs.push(part); }
  }
  for (const e of errors.splice(0).filter((e) => { const own = e.at >= c.at && e.at < c.end && e.kind !== 'parse-error'; if (own) note(e.kind, e.text); return !own; })) errors.push(e);
  if (!argv.length) { for (const h of heredocs) { const s = { kind: 'here-doc-orphan', text: h }; out.opaque.push(s); out.unknown.push(s.kind); } return; }
  const seg: Segment = { argv, raw: script.src.slice(c.at, c.end).trim(), at: c.at, depth, heredocs, unknown: kinds, opaque: spans, dynamic, src, flow };
  out.segments.push(seg);
  // Один уровень вложенности: sh -c "…" / bash -c "…" / eval … / скрипт, поданный оболочке here-doc'ом.
  const { name, rest } = effective(argv);
  const isShell = SHELLS.has(basename(name));
  const restAt = argv.length - rest.length;
  const inners: Array<{ text: string; outer: boolean; kind: string }> = [];
  // A shell with -c, -lc or -fc, itself or behind a wrapper: sudo -u, xargs, find -exec.
  const from = isShell ? 0 : rest.findIndex((t, k) => SHELLS.has(basename(t)) && isShellFlag(rest[k + 1] ?? '')) + 1;
  const flag = from > 0 || isShell ? rest.slice(from).findIndex(isShellFlag) : -1;
  const body = from + flag + 1;
  if (flag >= 0 && rest[body] !== undefined) inners.push({ text: rest[body], outer: dynamic.includes(restAt + body), kind: 'c' });
  if (name === 'eval') { const outer = dynamic.some((x) => x >= restAt); inners.push({ text: rest.join(' '), outer, kind: outer ? '~' : 'e' }); }
  if (isShell) for (const h of heredocs) inners.push({ text: h, outer: kinds.includes('here-doc-expansion'), kind: 'c' });
  if (inners.length && depth >= MAX_DEPTH) note('nested-shell-depth', inners.map((x) => x.text).join('\n'));
  else inners.forEach((inner, i) => {
    const sub = tokenizeAst(inner.text, depth + 1, { expandedByOuter: inner.outer }, { scope: `${flow.scope}/${inner.kind}${c.at}.${i}` });
    out.segments.push(...sub.segments); out.unknown.push(...sub.unknown); out.opaque.push(...sub.opaque);
  });
  subs.forEach((part, i) => collect(part.body, depth + 1, out, part.t === 'cmd' && part.bt ? [...part.body.errors] : errors, opts, { scope: `${flow.scope}/$${c.at}.${i}` }));
}
