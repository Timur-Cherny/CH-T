// Стадия и модель команды — контракт для гейтов (pg-session, data-boundary, bash-writes) и общие разборы обёрток:
// kubectl (kubeParse), ssh (склейка слов), команды, которые пишут файлы (WRITERS), и слова, которые имя psql только
// называют (MENTIONS). Оба разборщика — модель из дерева (model.ts) и старый по сегментам (stages.ts) — строят
// одну и ту же Stage; отсюда ничего не парсится.
export type Stdout = 'tty' | 'stderr' | 'null' | 'file';
export interface Enclosing<K = unknown> { stage: Stage<K>; prefix: string }
export interface Stage<K = unknown> {
  argv: string[]; name: string; rest: string[]; raw: string; heredocs: string[]; tags: string[];
  stdin: string | null; stdout: Stdout; enclosing: Enclosing<K> | null; kube: K | null; viaXargs: boolean;
  /** Файл, куда стадия пишет stdout (`>`, `>>`), или null: по нему гейт записи судит литеральный текст команды. */
  stdoutTo: string | null;
  /** dynamic[i] — argv[i] собран подстановкой; rest начинается с argv[restAt]. */
  dynamic: boolean[]; restAt: number; stdinDynamic: boolean;
  /** Внутри тела функции: аргументы ($1, $@) и stdin приходят с места вызова. */
  inFunction: boolean;
  /** src[i] — исходный текст argv[i] с кавычками: `"$@"` раскрывается по словам вызова, голый `$@` ещё и делится по IFS. */
  src: string[];
  /** Имя функции, в теле которой стоит стадия (внутренней при вложенности); в теле $(…) — null, смотри enclosing. */
  fn: string | null;
  /** Уровень текста: 0 — сама команда, +1 за sh -c, eval, $(…), kubectl exec --. Функция видна вызову на своём уровне. */
  level: number;
  /** Связь с предыдущей стадией: за `&&`/`||` стадия выполняется под условием. */
  link: 'and' | 'or' | 'none';
  /** Кто пишет в stdin: предыдущая стадия трубы; у команды внутри kubectl exec -i — то, что питает сам kubectl. */
  stdinStage: Stage<K> | null;
  /** Файлы, которые стадия пишет: цели редиректов, tee, cp/mv/install/ln/rsync/scp, dd of=, curl -o, wget -O, sed -i, kubectl cp. */
  writes: string[];
}
/** Объявление функции: сколько раз объявлена, на каком уровне, плоское ли тело (без if/for/case/while и подоболочек). */
export interface FnInfo { defs: number; level: number; flat: boolean }
/** deep — тексты уровней глубже MAX_LEVEL: модель в них не спускалась, но что там лежит, гейту видно.
 *  unparsed — the text from each parse-error to the end of its level: the grammar did not read it, no stage came from it. */
export interface Model<K = unknown> { pipelines: Stage<K>[][]; tags: string[]; assigns: Map<string, string[]>; deep: string[]; unparsed: string[]; functions: Map<string, FnInfo> }

/** Что команда внутри обёртки (kubectl exec, docker exec, sudo …) или тела оболочки (sh -c, ssh, su -c, watch)
 *  получает снаружи: stdin с here-doc и тело функции, в котором стоит обёртка (argv уже раскрыла локальная оболочка —
 *  позиционные параметры те же). all — stdin достаётся каждой стадии тела, начинающей конвейер, не только первой:
 *  `sh -c 'echo start; psql' <<SQL` кормит psql, а не echo. */
export interface Inherit<K> { stdin: string | null; stdinDynamic: boolean; stdinStage: Stage<K> | null; heredocs: string[]; tags: string[]; fn: string | null; all: boolean }

export const MAX_LEVEL = 4;
export const IGNORED_TAGS: ReadonlySet<string> = new Set(['command-substitution', 'nested-shell-depth']);
export const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash']);
export const WRAPPER_NAMES: ReadonlySet<string> = new Set([
  'mcp-pg-prod.sh', 'mcp-pg-prod', 'mcp-pg-connector-prod.sh', 'mcp-pg-connector-prod', 'mcp-pg-django-prod.sh', 'mcp-pg-django-prod',
]);
/** Команды, которые имя psql только называют (ищут, печатают, ставят), а не запускают. */
export const MENTIONS: ReadonlySet<string> = new Set([
  'which', 'type', 'whereis', 'whatis', 'man', 'info', 'apropos', 'brew', 'port', 'apt', 'apt-get', 'dpkg', 'rpm', 'yum', 'dnf', 'pip', 'npm',
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'echo', 'printf', 'print', 'cat', 'bat', 'less', 'more', 'head', 'tail', 'find', 'fd', 'ls',
  'locate', 'mdfind', 'pgrep', 'pkill', 'killall', 'ps', 'file', 'stat', 'readlink', 'realpath', 'basename', 'dirname', 'test', '[', '[[',
  'alias', 'hash', 'compgen', 'git', 'rm', 'cp', 'mv', 'ln', 'chmod', 'chown', 'touch', 'mkdir', 'curl', 'wget', 'open', 'code', 'vim',
  'nano', 'jq', 'yq', 'sed', 'awk', 'tr', 'cut', 'sort', 'uniq', 'wc', 'diff', 'tee',
]);

export const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;
export const NOT_A_FILE = /^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/;

export const quoteArgv = (argv: string[]): string => argv.map((t) => `'${t.replace(/'/g, `'\\''`)}'`).join(' ');

const positionals = (rest: string[]): string[] => rest.filter((t) => !t.startsWith('-'));
function flagValues(rest: string[], short: string, long: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === short || t === long) { if (rest[i + 1] !== undefined) out.push(rest[++i]); continue; }
    if (t.startsWith(`${long}=`)) { out.push(t.slice(long.length + 1)); continue; }
    if (t.length > short.length && t.startsWith(short) && !t.startsWith('--')) out.push(t.slice(short.length));
  }
  return out;
}
const lastOf = (rest: string[]): string[] => { const p = positionals(rest); return p.length >= 2 ? [p[p.length - 1]] : []; };
const podPath = (p: string): boolean => p.includes(':') && !/^(\.{0,2}\/|~)/.test(p);
export const WRITERS: Readonly<Record<string, (rest: string[]) => string[]>> = {
  tee: positionals, cp: lastOf, mv: lastOf, install: lastOf, ln: lastOf, rsync: lastOf, scp: lastOf,
  dd: (rest) => rest.filter((t) => t.startsWith('of=')).map((t) => t.slice(3)),
  curl: (rest) => flagValues(rest, '-o', '--output'),
  wget: (rest) => flagValues(rest, '-O', '--output-document'),
  sed: (rest) => (rest.some((t) => /^-[A-Za-z]*i/.test(t) || t.startsWith('--in-place')) ? positionals(rest).filter((t) => t !== '').slice(1) : []),
  kubectl: (rest) => { const k = kubeParse(rest); const dst = k.sub === 'cp' ? k.positionals[2] : undefined; return dst && !podPath(dst) ? [dst] : []; },
};

const SSH_VALUE: ReadonlySet<string> = new Set(['-B', '-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w']);
/** `ssh [опции] host слова…` — слова склеиваются пробелом, и удалённая оболочка разбирает строку заново. */
export function sshCommand(rest: string[]): { text: string; at: number[] } | null {
  let i = 0;
  while (i < rest.length && rest[i].startsWith('-')) i += SSH_VALUE.has(rest[i]) ? 2 : 1;
  const words = rest.slice(i + 1);
  if (i >= rest.length || !words.length) return null;
  return { text: words.join(' '), at: words.map((_, k) => i + 1 + k) };
}

/** Ключевые слова оболочки, `function ИМЯ`, xargs и watch — не имя команды: имя стоит за ними. */
export function stripPrefixes(args: string[], keywords: ReadonlySet<string>): { args: string[]; skipped: number; viaXargs: boolean } {
  let i = 0;
  let viaXargs = false;
  while (i < args.length) {
    const t = args[i];
    if (keywords.has(t)) { i++; continue; }
    if (t === 'function') { i += 2; continue; }
    if (t === 'xargs' || t === 'watch') {
      viaXargs ||= t === 'xargs';
      i++;
      while (i < args.length && args[i].startsWith('-')) i += /^-[IinPLdEs]$/.test(args[i]) ? 2 : 1;
      continue;
    }
    break;
  }
  return { args: args.slice(i), skipped: Math.min(i, args.length), viaXargs };
}

export interface Kube { sub: string; positionals: string[]; flags: Map<string, string>; inner: string[] | null }
const KUBE_VALUE: ReadonlySet<string> = new Set(['-n', '--namespace', '--context', '--kubeconfig', '--cluster', '--user', '-s', '--server', '--token', '--as', '--as-group', '-c', '--container', '-l', '--selector', '-o', '--output', '-f', '--filename', '--from-literal', '--from-file', '--type', '--field-selector', '--template', '--sort-by']);

export function kubeParse(rest: string[]): Kube {
  const flags = new Map<string, string>();
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === '--') return { sub: positionals[0] ?? '', positionals, flags, inner: rest.slice(i + 1) };
    if (t.startsWith('--') && t.includes('=')) { flags.set(t.slice(0, t.indexOf('=')), t.slice(t.indexOf('=') + 1)); continue; }
    if (/^-o.+/.test(t)) { flags.set('-o', t.slice(2)); continue; }
    if (KUBE_VALUE.has(t)) { flags.set(t, rest[++i] ?? ''); continue; }
    if (t.startsWith('-')) { flags.set(t, ''); continue; }
    positionals.push(t);
  }
  return { sub: positionals[0] ?? '', positionals, flags, inner: null };
}
export const kflag = (k: Kube, ...names: string[]): string | null => { for (const n of names) if (k.flags.has(n)) return k.flags.get(n) ?? ''; return null; };

export type OnExec<K> = (k: Kube, model: Model<K>) => K;
