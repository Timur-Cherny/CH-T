// Модель команды по СТАРОМУ токенизатору (сегменты + промежутки между ними) — под флагом
// CLAUDE_HARNESS_SHELL_PARSER=legacy на время прогона по транскриптам; штатный путь — model.ts из дерева.
// Здесь остались только разбор по сегментам (walk) и его помощники; типы стадии и разборы обёрток — в stage.ts,
// откуда они и реэкспортируются для гейтов. Что гейт вешает на стадии внутри kubectl exec, решает сам гейт через onExec.
import { basename } from 'node:path';
import { tokenizeLegacy, closeParen } from './legacy.ts';
import { effective, hasExpansion } from './argv.ts';
import type { Segment } from './argv.ts';
import { PSQL_LIKE, psqlSources, splitPsqlMeta } from './psql.ts';
import { ASSIGN, IGNORED_TAGS, MAX_LEVEL, MENTIONS, NOT_A_FILE, SHELLS, WRAPPER_NAMES, WRITERS, kubeParse, quoteArgv, sshCommand, stripPrefixes as stripWrappers } from './stage.ts';
import type { Enclosing, Inherit, Model, OnExec, Stage, Stdout } from './stage.ts';
import { buildModelAst } from './model.ts';

export { MAX_LEVEL, SHELLS, WRAPPER_NAMES, MENTIONS, ASSIGN, NOT_A_FILE, WRITERS, kubeParse, kflag, quoteArgv, sshCommand } from './stage.ts';
export type { Stdout, Enclosing, Stage, FnInfo, Model, Inherit, Kube, OnExec } from './stage.ts';

const KEYWORDS: ReadonlySet<string> = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '{', '}', '!']);
interface Redirected { args: string[]; dynamic: boolean[]; src: string[]; stdin: string | null; stdinDynamic: boolean; stdout: Stdout; stdoutTo: string | null; writes: string[] }

function redirects(argv: string[], dyn: ReadonlySet<number>, src: string[]): Redirected {
  const out: Redirected = { args: [], dynamic: [], src: [], stdin: null, stdinDynamic: false, stdout: 'tty', stdoutTo: null, writes: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const m = /^(\d?|&)(>>?|>\|)(&?)(.*)$/.exec(t);
    if (m) {
      const [, fd, , dup, attached] = m;
      const target = attached || (dup ? '' : argv[++i] ?? '');
      if (!dup && target && !NOT_A_FILE.test(target)) out.writes.push(target);
      if (fd === '' || fd === '1' || fd === '&') {
        if (dup) out.stdout = target === '2' ? 'stderr' : 'tty';
        else out.stdout = target === '/dev/null' ? 'null' : /^\/dev\/(stderr|tty)$/.test(target) ? 'stderr' : target === '/dev/stdout' ? 'tty' : 'file';
        if (out.stdout === 'file') out.stdoutTo = target;
      }
      continue;
    }
    if (t === '<') { out.stdin = argv[++i] ?? null; out.stdinDynamic = dyn.has(i); continue; }
    if (t.startsWith('<') && !t.startsWith('<<') && !t.startsWith('<(')) { out.stdin = t.slice(1); out.stdinDynamic = dyn.has(i); continue; }
    out.args.push(t);
    out.dynamic.push(dyn.has(i));
    out.src.push(src[i] ?? t);
  }
  return out;
}

/** Текст между сегментом и следующим: по нему видны `|`, `&`, `&&`/`||` и `()` объявления функции. */
function gaps(text: string, segs: Segment[]): Array<string | null> {
  return segs.map((s, i) => (i + 1 >= segs.length ? null : text.slice(s.at + s.raw.length, segs[i + 1].at)));
}

function pipeLink(gap: string | null): 'pipe' | 'amp' | 'none' {
  if (gap === null) return 'none';
  const g = gap.replace(/[\s()]/g, '');
  if (g.startsWith('||')) return 'none';
  if (g.startsWith('|')) return 'pipe';
  return g === '&' ? 'amp' : 'none';
}
function condLink(gap: string | null): 'and' | 'or' | 'none' {
  const g = (gap ?? '').replace(/[\s()]/g, '');
  return g.startsWith('&&') ? 'and' : g.startsWith('||') ? 'or' : 'none';
}

const DEF_NAME = /^[A-Za-z_][\w.:-]*$/;
const DEF_PARENS = /^\s*\(\s*\)\s*$/;
/** Ключевые слова составных команд: тело с ними — не плоская последовательность, порядок и число shift не доказать. */
const COMPOUND: ReadonlySet<string> = new Set(['if', 'then', 'else', 'elif', 'fi', 'while', 'until', 'for', 'do', 'done', 'case', 'esac', 'select', 'coproc']);

/** Тела $(…), `…`, <(…) и >(…) вне одинарных кавычек и комментария; prefix — начало слова до подстановки. */
function substitutions(raw: string): Array<{ body: string; prefix: string }> {
  const out: Array<{ body: string; prefix: string }> = [];
  let dq = false;
  let word = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '\\') { i++; continue; }
    if (!dq && c === "'") { const j = raw.indexOf("'", i + 1); i = j < 0 ? raw.length : j; continue; }
    if (c === '"') { dq = !dq; continue; }
    if (!dq && /\s/.test(c)) { word = i + 1; continue; }
    if (!dq && c === '#' && i === word) break;
    if ((c === '$' && raw[i + 1] === '(') || c === '`' || (!dq && (c === '<' || c === '>') && raw[i + 1] === '(')) {
      const close = c === '`' ? raw.indexOf('`', i + 1) : closeParen(raw, i + 1);
      const end = close < 0 ? raw.length : close;
      out.push({ body: raw.slice(c === '`' ? i + 1 : i + 2, end), prefix: raw.slice(word, i).replace(/["']/g, '') });
      i = end;
    }
  }
  return out;
}

function build<K>(text: string, level: number, enclosing: Enclosing<K> | null, kube: K | null, model: Model<K>, onExec: OnExec<K>, expandedByOuter = false, inherit: Inherit<K> | null = null): void {
  if (level > MAX_LEVEL) { model.tags.push('nested-depth'); model.deep.push(text); return; }
  const parse = tokenizeLegacy(text, 1, { expandedByOuter });
  walk(parse.segments, gaps(text, parse.segments), level, enclosing, kube, model, onExec, inherit);
  for (const t of parse.unknown) if (!IGNORED_TAGS.has(t) && !parse.segments.some((s) => s.unknown.includes(t))) model.tags.push(t);
}

function walk<K>(segs: Segment[], between: Array<string | null>, level: number, enclosing: Enclosing<K> | null, kube: K | null, model: Model<K>, onExec: OnExec<K>, inherit: Inherit<K> | null): void {
  let pipe: Stage<K>[] = [];
  let prev: Stage<K> | null = null;
  // Тело функции: `ИМЯ () {` (сегмент из одного слова, за ним `()` и `{`), `function ИМЯ {`, `function ИМЯ () {`.
  let braces = 0;
  const floors: number[] = [];
  const names: string[] = [];
  const declare = (name: string): void => {
    floors.push(braces); names.push(name);
    const info = model.functions.get(name);
    if (info) { info.defs++; if (info.level !== level) info.flat = false; } else model.functions.set(name, { defs: 1, level, flat: true });
  };
  const opaque = (): void => { for (const n of names) { const info = model.functions.get(n); if (info) info.flat = false; } };
  const isDef = (j: number): boolean => segs[j].argv.length === 1 && DEF_NAME.test(segs[j].argv[0]) && DEF_PARENS.test(between[j] ?? '') && segs[j + 1]?.argv[0] === '{';
  segs.forEach((seg, i) => {
    // Сегмент-имя в `ИМЯ () {` — объявление, не команда: стадии не даёт, иначе считался бы вызовом без аргументов.
    if (i + 1 < segs.length && isDef(i)) return;
    if (seg.argv[0] === 'function') declare(seg.argv[1] ?? '');
    else if (i > 0 && isDef(i - 1) && seg.argv[0] === '{') declare(segs[i - 1].argv[0]);
    for (const t of seg.argv) {
      if (t === '{') braces++;
      else if (t === '}') { braces--; while (floors.length && braces <= floors[floors.length - 1]) { floors.pop(); names.pop(); } }
    }
    const inFunction = floors.length > 0 && !(seg.argv.length === 1 && seg.argv[0] === '}');
    // Тело перестаёт быть плоским на составной команде и на скобке подоболочки между двумя стадиями тела.
    const gap = between[i - 1] ?? '';
    if (inFunction && (seg.argv.some((t) => COMPOUND.has(t)) || (prev !== null && prev.fn !== null && /[()]/.test(gap) && !DEF_PARENS.test(gap)))) opaque();
    const r = redirects(seg.argv, new Set(seg.dynamic), seg.src);
    if (!r.args.length && prev && pipeLink(between[i - 1] ?? null) === 'amp') { if (r.stdout !== 'tty') prev.stdout = r.stdout; return; }
    const pre = stripWrappers(r.args, KEYWORDS);
    let args = pre.args;
    let argDyn = r.dynamic.slice(pre.skipped);
    let argSrc = r.src.slice(pre.skipped);
    let eff = effective(args);
    let cmdAt = args.indexOf(eff.name);
    // Команда в переменной с литеральным значением из этой же команды (`PSQL=/opt/…/psql; $PSQL -c …`) видна
    // целиком: подставляем значение и судим обычный вызов. Значение из подстановки остаётся словом-подстановкой.
    const ref = cmdAt >= 0 && argDyn[cmdAt] ? /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(eff.name) : null;
    const values = ref ? model.assigns.get(ref[1]) : undefined;
    if (values?.length && !values.some((v) => hasExpansion(v, 'dq'))) {
      const words = values[values.length - 1].trim().split(/\s+/).filter(Boolean);
      if (words.length) {
        args = [...args.slice(0, cmdAt), ...words, ...args.slice(cmdAt + 1)];
        argDyn = [...argDyn.slice(0, cmdAt), ...words.map(() => false), ...argDyn.slice(cmdAt + 1)];
        argSrc = [...argSrc.slice(0, cmdAt), ...words, ...argSrc.slice(cmdAt + 1)];
        eff = effective(args);
        cmdAt = args.indexOf(eff.name);
      }
    }
    const name = eff.name === '' && args[0] === 'env' ? 'env' : basename(eff.name).replace(/^=/, '');
    const restAt = pre.skipped + (cmdAt < 0 ? args.length : cmdAt + 1);
    const first = inherit !== null && !pipe.length && (i === 0 || inherit.all) ? inherit : null;
    const fn = inFunction ? names[names.length - 1] ?? null : first?.fn ?? null;
    // Своего stdin у стадии нет — она читает унаследованный: here-doc обёртки становится её here-doc.
    const inheritsStdin = first !== null && r.stdin === null && !seg.heredocs.length;
    const st: Stage<K> = {
      argv: [...r.args.slice(0, pre.skipped), ...args], name, rest: eff.rest, raw: seg.raw,
      heredocs: inheritsStdin ? [...first.heredocs] : seg.heredocs,
      tags: [...seg.unknown.filter((t) => !IGNORED_TAGS.has(t)), ...(inheritsStdin ? first.tags : [])],
      stdin: r.stdin ?? first?.stdin ?? null, stdout: r.stdout, stdoutTo: r.stdoutTo, enclosing, kube, viaXargs: pre.viaXargs,
      dynamic: [...r.dynamic.slice(0, pre.skipped), ...argDyn], restAt, stdinDynamic: r.stdin !== null ? r.stdinDynamic : first?.stdinDynamic ?? false,
      inFunction: inFunction || fn !== null, writes: [...r.writes, ...(WRITERS[name]?.(eff.rest) ?? [])],
      stdinStage: pipe.length ? pipe[pipe.length - 1] : first?.stdinStage ?? null,
      src: [...r.src.slice(0, pre.skipped), ...argSrc], fn, level, link: condLink(between[i - 1] ?? null),
    };
    const assigns = name === 'export' || name === 'declare' ? st.rest : args.slice(0, cmdAt < 0 ? args.length : cmdAt);
    for (const a of assigns) { const m = ASSIGN.exec(a); if (m) model.assigns.set(m[1], [...(model.assigns.get(m[1]) ?? []), m[2]]); }
    pipe.push(st);
    prev = st;
    if (pipeLink(between[i]) !== 'pipe') { model.pipelines.push(pipe); pipe = []; }
    const restDynamic = (k: number): boolean => st.dynamic[restAt + k] === true;
    // Тело оболочки читает её stdin: here-doc, `<`, труба — до psql внутри `sh -c 'psql' <<SQL` они доходят.
    const bodyInherit: Inherit<K> = { stdin: st.stdin, stdinDynamic: st.stdinDynamic, stdinStage: st.stdinStage, heredocs: st.heredocs, tags: st.tags.filter((t) => t.startsWith('here-doc')), fn: null, all: true };
    const asBody = (text: string, dynamic: boolean): void => build(text, level + 1, null, kube, model, onExec, dynamic, bodyInherit);
    if (SHELLS.has(name)) {
      const k = st.rest.findIndex((t) => /^-[A-Za-z]*c[A-Za-z]*$/.test(t));
      if (k >= 0 && st.rest[k + 1] !== undefined) asBody(st.rest[k + 1], restDynamic(k + 1));
      else for (const body of st.heredocs) build(body, level + 1, null, kube, model, onExec, seg.unknown.includes('here-doc-expansion'));
    }
    if (name === 'eval') asBody(st.rest.join(' '), st.rest.some((_, k) => restDynamic(k)));
    // Обёртки со строкой-командой: чужая или удалённая оболочка разбирает её заново — уровень +1, stdin обёртки.
    if (name === 'ssh') { const c = sshCommand(st.rest); if (c) asBody(c.text, c.at.some((k) => restDynamic(k))); }
    if (name === 'su') {
      const k = st.rest.findIndex((t) => t === '-c' || t === '--command');
      const eq = st.rest.findIndex((t) => t.startsWith('--command='));
      if (k >= 0 && st.rest[k + 1] !== undefined) asBody(st.rest[k + 1], restDynamic(k + 1));
      else if (eq >= 0) asBody(st.rest[eq].slice('--command='.length), restDynamic(eq));
    }
    // watch склеивает аргументы в одну строку для sh -c; форма одной строки в кавычках без разбора не видна вовсе.
    if (r.args.slice(0, pre.skipped).includes('watch') && args.length === 1 && /\s/.test(args[0])) asBody(args[0], argDyn[0] === true);
    for (const s of substitutions(seg.raw)) build(s.body, level + 1, { stage: st, prefix: s.prefix }, kube, model, onExec);
    // Команда внутри обёртки получает argv готовыми словами: `$(…)` в нём раскрыла локальная оболочка, повторный
    // разбор текста запустил бы её второй раз «внутри». Stdin обёртки (here-doc, `<`, труба) — stdin команды: без
    // -i он до пода не дойдёт, но SQL в нём — намерение его выполнить, и судится так же.
    const enter = (argvInner: string[], from: number, ctx: K | null): void => {
      const inner: Segment = {
        argv: argvInner, raw: quoteArgv(argvInner), at: 0, depth: 1, opaque: [],
        heredocs: st.heredocs, unknown: seg.unknown.filter((t) => t.startsWith('here-doc')),
        dynamic: argvInner.flatMap((_, j) => (restDynamic(from + j) ? [j] : [])),
        src: st.src.slice(restAt + from, restAt + from + argvInner.length),
      };
      if (level + 1 > MAX_LEVEL) { model.tags.push('nested-depth'); model.deep.push(inner.raw); return; }
      walk([inner], [null], level + 1, null, ctx, model, onExec, { stdin: st.stdin, stdinDynamic: st.stdinDynamic, stdinStage: st.stdinStage, heredocs: [], tags: [], fn: st.fn, all: false });
    };
    const kp = name === 'kubectl' ? kubeParse(st.rest) : null;
    if (kp?.sub === 'exec' && kp.inner?.length) enter(kp.inner, st.rest.indexOf('--') + 1, onExec(kp, model));
    else if (!SHELLS.has(name) && !PSQL_LIKE.has(name) && !WRAPPER_NAMES.has(name) && (!MENTIONS.has(name) || name === 'find') && !/(^|\s)command\s+-[vV]\b/.test(seg.raw)) {
      // psql аргументом любой другой обёртки: docker exec, sudo -u postgres, ssh host (там слова ещё и склеиваются —
      // строка выше судится отдельно, здесь — задуманный argv). Оболочка с -c аргументом обёртки — docker exec pg sh -c '…',
      // find -exec sh -c '…' — разбирает тело сама; stdin обёртки доходит до неё.
      const j = name === 'find' ? -1 : st.rest.findIndex((t) => PSQL_LIKE.has(basename(t)));
      const s = st.rest.findIndex((t, k) => SHELLS.has(basename(t)) && /^-[A-Za-z]*c[A-Za-z]*$/.test(st.rest[k + 1] ?? ''));
      if (j >= 0) enter(st.rest.slice(j), j, kube);
      else if (s >= 0) enter(st.rest.slice(s), s, kube);
    }
    if (PSQL_LIKE.has(name) || WRAPPER_NAMES.has(name)) {
      const texts = [...psqlSources(st.rest).flatMap((s) => (s.kind === 'inline' ? [s.sql] : [])), ...st.heredocs];
      for (const t of texts) for (const sh of splitPsqlMeta(t).shells) build(sh, level + 1, null, null, model, onExec);
    }
  });
  if (pipe.length) model.pipelines.push(pipe);
}

export const useLegacyModel = (): boolean => process.env.CLAUDE_HARNESS_SHELL_PARSER === 'legacy';

export function buildModel<K>(command: string, onExec: OnExec<K>): Model<K> {
  if (!useLegacyModel()) return buildModelAst(command, onExec);
  const model: Model<K> = { pipelines: [], tags: [], assigns: new Map(), deep: [], unparsed: [], functions: new Map() };
  build(command, 0, null, null, model, onExec);
  return model;
}
