// Разбор git-вызова по argv токенизатора — не по тексту команды: глобальные опции до глагола
// (`-C <path>`, `-c k=v`, `--git-dir=…`) и эффективный cwd сегмента с учётом предшествующих `cd`.
// Так `cd X && git push` и `git -C X push` видны как push в каталоге X, а не в cwd сессии.
// Regex здесь один — форма `$VAR`/`${VAR}` для подстановки из окружения; переменная без значения
// делает cwd неизвестным (null), и гейт обязан ответить unknown, а не угадать каталог.
import { resolve, isAbsolute } from 'node:path';
import { commands, type ShellParse } from '../parsers/shell.ts';

export interface SegmentAt { name: string; argv: string[]; rest: string[]; raw: string; depth: number; cwd: string | null; heredocs: string[]; unknown: string[]; env: NodeJS.ProcessEnv }
export interface GitCall { verb: string; args: string[]; cwd: string | null }

export const GLOBAL_WITH_VALUE: ReadonlySet<string> = new Set(['-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--exec-path', '--list-cmds', '--attr-source']);

export function expandWord(word: string, env: NodeJS.ProcessEnv): string | null {
  if (word.includes('$(') || word.includes('`')) return null;
  let missing = false;
  let out = word;
  if (out === '~' || out.startsWith('~/')) { if (env.HOME === undefined) return null; out = env.HOME + out.slice(1); }
  else if (out.startsWith('~')) return null;
  out = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, a: string | undefined, b: string | undefined) => {
    const v = env[(a ?? b) as string];
    if (v === undefined) missing = true;
    return v ?? '';
  });
  return missing ? null : out;
}

function step(cur: string | null, word: string, env: NodeJS.ProcessEnv): string | null {
  const e = expandWord(word, env);
  if (e === null) return null;
  if (isAbsolute(e)) return e;
  return cur === null ? null : resolve(cur, e);
}

const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const APPEND = /^([A-Za-z_][A-Za-z0-9_]*)\+=(.*)$/s;
const DECLARERS = new Set(['export', 'local', 'declare', 'typeset', 'readonly']);
const bare = (a: string): boolean => ASSIGN.test(a) || APPEND.test(a);

/** Variables a script sets for its later segments: `W=/x` on its own and `export|local|declare W=/x`. A value from a
 *  substitution is unknown and removes the name, so an expansion of it stays unresolved; a prefix `W=x cmd "$W"` does
 *  not count — the shell expands "$W" before the assignment takes effect. */
function assignments(name: string, argv: string[], rest: string[]): string[] | null {
  if ((name === '' || APPEND.test(name)) && argv.length && argv.every(bare)) return argv;
  if (DECLARERS.has(name)) return rest.filter(bare);
  return null;
}

interface ShellState {
  cwd: string | null; env: NodeJS.ProcessEnv; dirs: (string | null)[] | null;
  /** Every directory the scope stood in after a move, and every value each variable took: a branch may stop anywhere. */
  stops: Set<string | null>; seen: Map<string, Set<string | undefined>>; stacked: boolean; wiped: boolean;
}

const MOVES = new Set(['cd', 'chdir', 'pushd', 'popd']);
const ISOLATED = new Set(['(', '|', '&', '$', 'c']);
const kindOf = (scope: string): string => scope[scope.lastIndexOf('/') + 1] ?? '';
const parentOf = (scope: string): string => scope.slice(0, scope.lastIndexOf('/'));
const blank = (cwd: string | null, env: NodeJS.ProcessEnv, dirs: (string | null)[] | null): ShellState =>
  ({ cwd, env, dirs, stops: new Set(), seen: new Map(), stacked: false, wiped: false });
const moveOf = (c: { name: string; rest: string[] }): { name: string; rest: string[] } | null =>
  MOVES.has(c.name) ? c : c.name === 'builtin' && MOVES.has(c.rest[0] ?? '') ? { name: c.rest[0], rest: c.rest.slice(1) } : null;

function put(st: ShellState, k: string, v: string | null): void {
  st.env = { ...st.env };
  if (v === null) delete st.env[k]; else st.env[k] = v;
  st.seen.set(k, (st.seen.get(k) ?? new Set()).add(v ?? undefined));
}

function assign(st: ShellState, word: string): void {
  const plus = APPEND.exec(word);
  const [, k, v] = (plus ?? ASSIGN.exec(word)) as RegExpExecArray;
  const e = expandWord(v, st.env);
  const old = st.env[k];
  put(st, k, e === null ? null : !plus ? e : old === undefined ? null : old + e);
}

/** The directory operand of cd or pushd: undefined when there is none, null for one taken from the directory stack. */
function operand(rest: string[]): { dir: string | null | undefined; opts: string[] } {
  const opts: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--') return { dir: rest[i + 1], opts };
    if (/^[-+]\d+$/.test(a)) return { dir: null, opts };
    if (a !== '-' && a.startsWith('-')) { opts.push(a); continue; }
    return { dir: a, opts };
  }
  return { dir: undefined, opts };
}

function move(st: ShellState, name: string, rest: string[]): void {
  const from = st.cwd;
  const { dir, opts } = operand(rest);
  st.stacked ||= name === 'pushd' || name === 'popd';
  if (name === 'pushd' && opts.includes('-n')) { st.dirs = null; return; }
  if (name === 'popd') {
    if (rest.length || st.dirs === null) { st.cwd = null; st.dirs = null; } else if (st.dirs.length) st.cwd = st.dirs.pop() ?? null; else return;
  } else if (dir === null || (name === 'pushd' && dir === undefined)) { st.cwd = null; st.dirs = null; } else {
    if (name === 'pushd') st.dirs?.push(from);
    st.cwd = dir === undefined ? (st.env.HOME ?? null) : dir === '-' ? (st.env.OLDPWD ?? null) : step(from, dir, st.env);
  }
  put(st, 'OLDPWD', from);
  put(st, 'PWD', st.cwd);
  st.stops.add(st.cwd);
}

type LoopEffects = Map<string, { moves: boolean; names: Set<string>; wiped: boolean }>;

/** Everything a loop body changes: from its second iteration on, the body starts in the state it leaves. */
function loopEffects(parse: ShellParse, list: ReturnType<typeof commands>): LoopEffects {
  const loops: LoopEffects = new Map();
  list.forEach((c, i) => {
    const seg = parse.segments[i];
    const scope = seg?.flow?.scope ?? '';
    const set = assignments(c.name, c.argv, c.rest);
    const wiped = c.name === 'eval' && !!seg?.dynamic.length;
    const moves = wiped || moveOf(c) !== null;
    if (!scope.includes('/l') || (!set && !moves)) return;
    for (let s = scope; s; s = parentOf(s)) {
      if (kindOf(s) !== 'l') continue;
      const fx = loops.get(s) ?? { moves: false, names: new Set<string>(), wiped: false };
      fx.moves ||= moves; fx.wiped ||= wiped;
      for (const a of set ?? []) fx.names.add(((APPEND.exec(a) ?? ASSIGN.exec(a)) as RegExpExecArray)[1]);
      loops.set(s, fx);
    }
  });
  return loops;
}

/** Segments with their effective cwd: `cd`/`pushd`/`popd` move it for later segments of the same shell, a branch
 *  hands back only what every path through it leaves. A null cwd means the caller does not know its directory; only an
 *  absolute `cd` or `git -C` then sets one. $PWD and $OLDPWD follow the tracked directory, not the hook process. */
export function segmentsWithCwd(parse: ShellParse, cwd: string | null, env: NodeJS.ProcessEnv): SegmentAt[] {
  const list = commands(parse);
  const loops = loopEffects(parse, list);
  const rootEnv: NodeJS.ProcessEnv = { ...env, PWD: cwd ?? undefined };
  delete rootEnv.OLDPWD;
  if (cwd === null) delete rootEnv.PWD;
  const states = new Map<string, ShellState>([['', blank(cwd, rootEnv, [])]]);
  const create = (scope: string): void => {
    const kind = kindOf(scope);
    const up = states.get(parentOf(scope)) as ShellState;
    if (kind === 'e') { states.set(scope, up); return; }
    if (kind === 'f') { states.set(scope, blank(null, {}, null)); return; }
    const st = blank(up.cwd, up.env, up.dirs && [...up.dirs]);
    const fx = kind === 'l' ? loops.get(scope) : undefined;
    const loopVar = kind === 'l' ? /:(\w+)$/.exec(scope)?.[1] : undefined;
    if (fx?.moves) { st.cwd = null; st.dirs = null; }
    if (fx?.wiped) st.env = {};
    for (const k of [...(fx?.names ?? []), ...(loopVar ? [loopVar] : [])]) put(st, k, null);
    states.set(scope, st);
  };
  const close = (scope: string): void => {
    const kind = kindOf(scope);
    if (ISOLATED.has(kind) || kind === 'e') return;
    const st = states.get(scope) as ShellState;
    const up = states.get(parentOf(scope)) as ShellState;
    if (st.wiped) { up.env = {}; up.wiped = true; }
    if ([...st.stops].some((v) => v !== up.cwd)) { up.cwd = null; up.dirs = null; up.stops.add(null); }
    else if (st.stacked && JSON.stringify(st.dirs) !== JSON.stringify(up.dirs)) up.dirs = null;
    up.stacked ||= st.stacked;
    for (const [k, vals] of st.seen) if ([...vals].some((v) => v !== up.env[k])) put(up, k, null);
  };
  const open: string[] = [''];
  const out: SegmentAt[] = [];
  list.forEach((c, i) => {
    const seg = parse.segments[i];
    const scope = seg?.flow?.scope ?? '';
    while (scope !== open[open.length - 1] && !scope.startsWith(`${open[open.length - 1]}/`)) close(open.pop() as string);
    for (let top = open[open.length - 1]; top !== scope;) {
      const next = scope.indexOf('/', top.length + 1);
      top = next < 0 ? scope : scope.slice(0, next);
      create(top);
      open.push(top);
    }
    const st = states.get(scope) as ShellState;
    out.push({ name: c.name, argv: c.argv, rest: c.rest, raw: seg?.raw ?? c.argv.join(' '), depth: c.depth, cwd: st.cwd, heredocs: seg?.heredocs ?? [], unknown: seg?.unknown ?? [], env: st.env });
    const set = assignments(c.name, c.argv, c.rest);
    if (set) { for (const a of set) assign(st, a); return; }
    if (c.name === 'eval' && seg?.dynamic.length) {
      Object.assign(st, { cwd: null, dirs: null, env: {}, wiped: true, stacked: true });
      st.stops.add(null);
      return;
    }
    const mv = moveOf(c);
    if (mv) move(st, mv.name, mv.rest);
  });
  return out;
}

/** Глагол git и его аргументы после глобальных опций; `-C <path>` сдвигает cwd вызова. */
export function parseGit(rest: string[], cwd: string | null, env: NodeJS.ProcessEnv): GitCall | null {
  let cur = cwd;
  let i = 0;
  while (i < rest.length) {
    const a = rest[i];
    if (!a.startsWith('-')) return { verb: a, args: rest.slice(i + 1), cwd: cur };
    if (a === '-C') { const p = rest[i + 1]; if (p === undefined) return null; cur = step(cur, p, env); i += 2; continue; }
    if (GLOBAL_WITH_VALUE.has(a)) { i += 2; continue; }
    i++; // -p, --no-pager, --bare, --foo=bar
  }
  return null;
}

export function isGit(name: string): boolean { return (name.split('/').pop() ?? name) === 'git'; }
