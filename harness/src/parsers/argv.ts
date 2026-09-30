// Общий слой обоих разборщиков: контракт ShellParse/Segment для гейтов, границы подстановок (§2.6 — где
// начинается раскрытие, не что оно даст) и имя команды за префиксами. Сюда ничего не парсится.
export interface Segment {
  argv: string[]; raw: string; depth: number; heredocs: string[]; unknown: string[];
  /** Смещение raw в разобранном тексте; у сегментов из тела `$(…)` — в тексте, где стоит подстановка. */
  at: number;
  /** Исходный текст каждого слова argv, с кавычками: `"$@"` и `$@` дают одно слово, но раскрываются по-разному. */
  src: string[];
  /** Неразобранные части этого сегмента (подмножество ShellParse.opaque, те же объекты). */
  opaque: OpaqueSpan[];
  /** Индексы argv, чьё значение собирает подстановка. */
  dynamic: number[];
  /** Where the segment runs, for tracking `cd` and variables: a path of scopes, each component starting with its
   *  kind. `(` subshell, `|` pipe element, `&` background job, `$` substitution, `c` sh -c — state never reaches the
   *  caller; `?` branch that may not run, `l` loop body that may run any number of times, `~` last pipe element and
   *  eval of expanded text, `f` function body — the caller keeps a value only if every path leaves the same one;
   *  `e` eval of literal text — the caller's own state. The legacy parser leaves it out. */
  flow?: Flow;
}
export interface Flow { scope: string }
/** Неразобранная часть: вид плюс ЕЁ текст. Вид один на всю команду, текст — у каждой части свой. */
export interface OpaqueSpan { kind: string; text: string }
export interface ShellParse { segments: Segment[]; unknown: string[]; opaque: OpaqueSpan[] }
/** expandedByOuter: текст — тело, которое внешняя оболочка уже раскрыла (sh -c "…$X…"), поэтому `$X` внутри
 *  одинарных кавычек тела — след внешней подстановки, а не литерал. */
export interface TokenizeOptions { expandedByOuter?: boolean }

export type ExpansionContext = 'bare' | 'dq' | 'heredoc';

/** Открывает ли символ в позиции i подстановку. `$'…'` раскрывается только вне кавычек; в here-doc и двойных
 *  кавычках это литерал. `$.`, `$ `, `$"` и `$` в конце — литералы. */
export function expansionAt(s: string, i: number, ctx: ExpansionContext): boolean {
  if (s[i] === '`') return true;
  if (s[i] !== '$') return false;
  const c = s[i + 1] ?? '';
  if (/^[A-Za-z_0-9{(\[@*#?$!-]$/.test(c)) return true;
  if (c === "'") return ctx === 'bare';
  return /^[=~^+]$/.test(c) && /^[A-Za-z_{]$/.test(s[i + 2] ?? '');
}

/** Есть ли в тексте подстановка; `\` экранирует следующий символ. */
export function hasExpansion(text: string, ctx: ExpansionContext = 'heredoc'): boolean {
  for (let k = 0; k < text.length; k++) {
    if (text[k] === '\\') { k++; continue; }
    if (expansionAt(text, k, ctx)) return true;
  }
  return false;
}

const PREFIX_SKIP = new Set(['command', 'exec', 'time', 'nohup', 'sudo', 'nice', 'ionice', 'stdbuf', 'timeout', 'gtimeout']);

/** Имя команды сегмента после префиксов `VAR=v`, `env -u X`, `command`, `sudo`, `time`, `timeout N`. */
export function effective(argv: string[]): { name: string; rest: string[] } {
  let i = 0;
  while (i < argv.length) {
    const t = argv[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i++; continue; }
    if (t === 'env') { i++; while (i < argv.length && (argv[i] === '-u' || argv[i] === '-i' || argv[i].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i]))) { i += argv[i] === '-u' ? 2 : 1; } continue; }
    if (PREFIX_SKIP.has(t)) { i++; if ((t === 'timeout' || t === 'gtimeout' || t === 'nice') && /^[-\d]/.test(argv[i] ?? '')) i++; continue; }
    break;
  }
  return { name: argv[i] ?? '', rest: argv.slice(i + 1) };
}
