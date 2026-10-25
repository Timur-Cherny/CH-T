// Дерево команды оболочки по POSIX.1-2017 §2.10 «Shell Grammar» без лишних узлов: Script (complete_commands),
// List (list/compound_list), AndOr (and_or), Pipeline (pipe_sequence с `!`), Simple (simple_command),
// Group/Subshell/If/While/Until/For/Case (compound_command), Func (function_definition), Redirect (io_redirect,
// io_here). Расширения bash: Select, Cond (`[[ … ]]`), Arith (`(( … ))`), ForArith (`for (( … ))`), `|&`, `;&`/`;;&`.
// Слово несёт исходный текст и части по §2.2 (кавычки) и §2.6 (границы подстановок, не их вычисление);
// тело `$(…)`, `` `…` ``, `<(…)`, `>(…)` — вложенный Script той же грамматики.
// print() печатает дерево обратно в текст; свойство «parse(print(parse(x))) даёт равное дерево» держит тест.
export interface Pos { at: number; end: number }

export type Part =
  | { t: 'lit'; v: string }                       // буквы вне кавычек, экранирование уже снято
  | { t: 'sq'; v: string; dyn?: true }            // '…' (§2.2.2); dyn — тело уже раскрыла внешняя оболочка (sh -c "…'$X'…")
  | { t: 'dq'; parts: Part[] }                    // "…" (§2.2.3) и $"…"
  | { t: 'ansi'; v: string }                      // $'…' (bash 3.1.2.4), значение раскодировано
  | { t: 'param'; src: string }                   // $X, ${…}, $1, $@, $[…], zsh $=X/$~X/$^X/$+X
  | { t: 'arith'; src: string }                   // $((…))
  | { t: 'cmd'; src: string; body: Script; bt: boolean }   // $(…) и `…`
  | { t: 'proc'; src: string; body: Script; dir: '<' | '>' }; // <(…) и >(…)

export interface Word extends Pos {
  text: string;      // исходный текст слова с кавычками
  parts: Part[];
  bare: boolean;     // одна литеральная часть без кавычек и экранирования: только такое слово бывает зарезервированным
  assign: boolean;   // NAME=… (§2.10.2 правило 7), в том числе NAME+=… и NAME=(…) bash
}

export interface HereDoc extends Pos {
  delim: string; quoted: boolean; strip: boolean;
  body: string; terminated: boolean;
}

export interface Redirect extends Pos {
  fd: number | null;          // IO_NUMBER или null; `&>`/`&>>` — fd null и op с амперсандом
  op: string;                 // < > >> >| <> <& >& << <<- <<< &> &>>
  target: Word | null;        // слово-цель; у here-doc — null
  here: HereDoc | null;
}

/** src — текст, в котором стоят позиции узлов: у тела `$(…)` тот же, что у внешней команды; у `` `…` `` — снятое тело. */
export interface Script extends Pos { body: List; errors: ParseError[]; src: string }
export interface ParseError { kind: string; at: number; text: string }

export interface List extends Pos { items: AndOr[] }
export interface AndOr extends Pos { pipelines: Pipeline[]; ops: Array<'&&' | '||'>; bg: boolean }
export interface Pipeline extends Pos { commands: Command[]; negated: boolean; stderr: boolean[] } // stderr[i] — `|&` перед commands[i+1]

export type Command = Simple | Group | Subshell | If | While | For | Case | Cond | Arith | ForArith | Func;

export interface Simple extends Pos { kind: 'simple'; words: Word[]; redirects: Redirect[] }
export interface Group extends Pos { kind: 'group'; body: List; redirects: Redirect[] }
export interface Subshell extends Pos { kind: 'subshell'; body: List; redirects: Redirect[] }
export interface If extends Pos { kind: 'if'; clauses: Array<{ cond: List; body: List }>; otherwise: List | null; redirects: Redirect[] }
export interface While extends Pos { kind: 'while' | 'until'; cond: List; body: List; redirects: Redirect[] }
export interface For extends Pos { kind: 'for' | 'select'; name: Word; words: Word[] | null; body: List; redirects: Redirect[] }
export interface ForArith extends Pos { kind: 'for-arith'; src: string; body: List; redirects: Redirect[] }
export interface Case extends Pos { kind: 'case'; word: Word; items: CaseItem[]; redirects: Redirect[] }
export interface CaseItem extends Pos { patterns: Word[]; body: List; term: ';;' | ';&' | ';;&' | null }
export interface Cond extends Pos { kind: 'cond'; words: Word[]; redirects: Redirect[] }
export interface Arith extends Pos { kind: 'arith'; src: string; redirects: Redirect[] }
export interface Func extends Pos { kind: 'func'; name: string; body: Command }

/** Значение слова как его получит команда: кавычки сняты, подстановки остаются своим текстом (`$X`, `$(…)`). */
export function wordValue(w: Word): string { return partsValue(w.parts); }
export function partsValue(parts: Part[]): string {
  let out = '';
  for (const p of parts) {
    switch (p.t) {
      case 'lit': case 'sq': case 'ansi': out += p.v; break;
      case 'dq': out += partsValue(p.parts); break;
      default: out += p.src;
    }
  }
  return out;
}
/** Слово собирает подстановка: его буквы в argv — не значение, которое получит команда. `$'…'` считается тоже:
 *  значение раскодировано, но гейт судит его как спрятанное — так `$'\\n'` прятал SET за комментарием (тест pg-session). */
export function partsDynamic(parts: Part[]): boolean {
  return parts.some((p) => p.t === 'param' || p.t === 'arith' || p.t === 'cmd' || p.t === 'proc' || p.t === 'ansi' || (p.t === 'sq' && p.dyn === true) || (p.t === 'dq' && partsDynamic(p.parts)));
}
/** Подстановки слова в порядке текста; prefix — значение частей слова до подстановки. */
export function substitutionsOf(w: Word): Array<{ part: Extract<Part, { t: 'cmd' | 'proc' }>; prefix: string }> {
  const out: Array<{ part: Extract<Part, { t: 'cmd' | 'proc' }>; prefix: string }> = [];
  const visit = (parts: Part[], prefix: string): string => {
    for (const p of parts) {
      if (p.t === 'cmd' || p.t === 'proc') { out.push({ part: p, prefix }); prefix += p.src; continue; }
      if (p.t === 'dq') { prefix = visit(p.parts, prefix); continue; }
      prefix += p.t === 'param' || p.t === 'arith' ? p.src : p.v;
    }
    return prefix;
  };
  visit(w.parts, '');
  return out;
}

const REDIRECT_OPS: ReadonlySet<string> = new Set(['<', '>', '>>', '>|', '<>', '<&', '>&', '<<', '<<-', '<<<', '&>', '&>>']);
export const isRedirectOp = (op: string): boolean => REDIRECT_OPS.has(op);

/** Печать дерева: слова — исходным текстом, тела here-doc — после строки команды, как читает их оболочка (§2.7.4). */
export function print(script: Script): string {
  const pending: HereDoc[] = [];
  const flush = (): string => { if (!pending.length) return ''; const out = pending.map((h) => `${h.body}${h.delim}\n`).join(''); pending.length = 0; return out; };
  const redirect = (r: Redirect): string => {
    if (r.here) { pending.push(r.here); const d = r.here.quoted ? `'${r.here.delim}'` : r.here.delim; return `${r.fd ?? ''}${r.here.strip ? '<<-' : '<<'}${d}`; }
    return `${r.fd ?? ''}${r.op}${r.target ? ` ${r.target.text}` : ''}`;
  };
  const redirects = (rs: Redirect[]): string => rs.map((r) => ` ${redirect(r)}`).join('');
  const list = (l: List): string => l.items.map((a) => andOr(a) + (a.bg ? ' &' : ';') + '\n' + flush()).join('');
  const andOr = (a: AndOr): string => a.pipelines.map((p, i) => (i ? ` ${a.ops[i - 1]} ` : '') + pipeline(p)).join('');
  const pipeline = (p: Pipeline): string => (p.negated ? '! ' : '') + p.commands.map((c, i) => (i ? (p.stderr[i - 1] ? ' |& ' : ' | ') : '') + command(c)).join('');
  const command = (c: Command): string => {
    switch (c.kind) {
      case 'simple': {
        const items = [...c.words.map((w) => ({ at: w.at, s: w.text })), ...c.redirects.map((r) => ({ at: r.at, s: redirect(r) }))].sort((x, y) => x.at - y.at);
        return items.map((x) => x.s).join(' ');
      }
      case 'group': return `{\n${list(c.body)}}` + redirects(c.redirects);
      case 'subshell': return `(\n${list(c.body)})` + redirects(c.redirects);
      case 'if': return c.clauses.map((k, i) => `${i ? 'elif' : 'if'}\n${list(k.cond)}then\n${list(k.body)}`).join('') + (c.otherwise ? `else\n${list(c.otherwise)}` : '') + 'fi' + redirects(c.redirects);
      case 'while': case 'until': return `${c.kind}\n${list(c.cond)}do\n${list(c.body)}done` + redirects(c.redirects);
      case 'for': case 'select': return `${c.kind} ${c.name.text}${c.words ? ` in ${c.words.map((w) => w.text).join(' ')}` : ''}\ndo\n${list(c.body)}done` + redirects(c.redirects);
      case 'for-arith': return `for ((${c.src}))\ndo\n${list(c.body)}done` + redirects(c.redirects);
      case 'case': return `case ${c.word.text} in\n` + c.items.map((it) => `(${it.patterns.map((w) => w.text).join(' | ')})\n${list(it.body)}${it.term ?? ''}\n`).join('') + 'esac' + redirects(c.redirects);
      case 'cond': return `[[ ${c.words.map((w) => w.text).join(' ')} ]]` + redirects(c.redirects);
      case 'arith': return `((${c.src}))` + redirects(c.redirects);
      case 'func': return `${c.name} ()\n${command(c.body)}`;
    }
  };
  return list(script.body) + flush();
}

/** Структура без позиций и без текста слов: по ней сравниваются деревья до и после печати. */
export function shape(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(shape);
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === 'at' || k === 'end' || k === 'src' || k === 'text') continue;
      out[k] = shape(v);
    }
    return out;
  }
  return node;
}
