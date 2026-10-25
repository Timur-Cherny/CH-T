// Лексер оболочки по POSIX.1-2017 §2.3 «Token Recognition»: правило 1 — конец ввода делимитирует токен; 2–3 —
// оператор читается самым длинным (`&&`, `||`, `;;`, `<<-`, `<<<`, `>|`, `<&`, `>&`, `<>`; bash: `|&`, `&>`, `&>>`,
// `;&`, `;;&`); 4 — кавычки §2.2 (`\`, `'…'`, `"…"`) читаются до конца; 5 — `$` и `` ` `` читаются до конца
// подстановки (§2.6: `$X`, `${…}`, `$(…)`, `$((…))`, `` `…` ``; bash: `$'…'`, `$"…"`, `<(…)`, `>(…)`, `$[…]`);
// 6 — символ оператора делимитирует слово; 7 — перевод строки — токен NEWLINE, после него читаются тела here-doc
// (§2.7.4); 8 — пробел делимитирует и отбрасывается; 9 — буква продолжает слово; 10 — `#` в начале токена —
// комментарий до перевода строки; 11 — иначе начинается слово. IO_NUMBER — цифры вплотную перед `<`/`>` (§2.7).
// Зарезервированные слова (§2.4) лексер не различает: слово несёт признак bare, а позицию знает парсер.
// Тело `$(…)` и `<(…)` разбирает парсер той же грамматикой на этом же лексере (hooks.sub); тело `` `…` `` —
// отдельным разбором снятого текста (hooks.script). Ничего не бросает: незакрытое — ошибка с позицией и текстом.
import { partsValue } from './ast.ts';
import type { HereDoc, Part, ParseError, Script, Word } from './ast.ts';
import { expansionAt, hasExpansion } from './argv.ts';

export type TokenKind = 'WORD' | 'OP' | 'NEWLINE' | 'IO_NUMBER' | 'EOF';
export interface Token { kind: TokenKind; at: number; end: number; text: string; word: Word | null; here: HereDoc | null }

export interface LexerHooks {
  /** Разбор списка команд с позиции from до закрывающей `)`; лексер после — за скобкой. */
  sub: (lexer: Lexer, from: number) => { body: Script; closed: boolean };
  /** Разбор отдельного текста (тело обратных кавычек). */
  script: (text: string) => Script;
}
export interface LexerOptions { expandedByOuter?: boolean }

const OPS = ['<<<', '<<-', ';;&', '&>>', '&&', '||', ';;', ';&', '<<', '>>', '<&', '>&', '<>', '>|', '|&', '&>', '(', ')', ';', '&', '|', '<', '>'];
const OP_START = new Set(';&|()<>');
const isBlank = (c: string): boolean => c === ' ' || c === '\t' || c === '\r';
const ASSIGN_HEAD = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;

export class Lexer {
  readonly s: string;
  readonly n: number;
  pos = 0;
  /** Глубина `$(…)`: внутри подстановки строка `EOF)` тоже закрывает here-doc, а скобка читается снова. */
  inSub = 0;
  readonly errors: ParseError[] = [];
  /** Первая ошибка грамматики останавливает разбор на всех уровнях: восстановления нет (§2.10 без него). */
  dead = false;
  private pending: HereDoc[] = [];
  private readonly expandedByOuter: boolean;
  private readonly hooks: LexerHooks;

  constructor(s: string, hooks: LexerHooks, opts: LexerOptions = {}) {
    this.s = s; this.n = s.length; this.hooks = hooks; this.expandedByOuter = opts.expandedByOuter === true;
  }

  private error(kind: string, at: number, text: string): void { this.errors.push({ kind, at, text }); }

  /** Следующий токен с текущей позиции. */
  next(): Token {
    const s = this.s;
    for (;;) {
      this.skipBlanks();
      if (this.pos >= this.n) { this.readHereDocs(); return { kind: 'EOF', at: this.n, end: this.n, text: '', word: null, here: null }; }
      const c = s[this.pos];
      if (c === '#') { const j = s.indexOf('\n', this.pos); this.pos = j < 0 ? this.n : j; continue; }
      if (c === '\n') { const at = this.pos++; this.readHereDocs(); return { kind: 'NEWLINE', at, end: at + 1, text: '\n', word: null, here: null }; }
      const num = /^\d+(?=[<>])/.exec(s.slice(this.pos, this.pos + 12));
      if (num) { const at = this.pos; this.pos += num[0].length; return { kind: 'IO_NUMBER', at, end: this.pos, text: num[0], word: null, here: null }; }
      if (OP_START.has(c) && !((c === '<' || c === '>') && s[this.pos + 1] === '(')) return this.operator();
      const at = this.pos;
      const word = this.scanWord(false);
      if (word === null) { this.error('parse-error', at, s.slice(at)); this.pos = this.n; continue; }
      return { kind: 'WORD', at, end: this.pos, text: word.text, word, here: null };
    }
  }

  private skipBlanks(): void {
    const s = this.s;
    while (this.pos < this.n) {
      const c = s[this.pos];
      if (isBlank(c)) { this.pos++; continue; }
      if (c === '\\' && s[this.pos + 1] === '\n') { this.pos += 2; continue; }
      if (c === '\\' && s[this.pos + 1] === '\r' && s[this.pos + 2] === '\n') { this.pos += 3; continue; }
      break;
    }
  }

  private operator(): Token {
    const s = this.s;
    const at = this.pos;
    const op = OPS.find((o) => s.startsWith(o, at)) ?? s[at];
    this.pos = at + op.length;
    if (op !== '<<' && op !== '<<-') return { kind: 'OP', at, end: this.pos, text: op, word: null, here: null };
    // §2.7.4: ограничитель — следующее слово после снятия кавычек; кавычки или экранирование = подстановок в теле нет.
    while (this.pos < this.n && isBlank(s[this.pos])) this.pos++;
    const dAt = this.pos;
    const d = this.pos < this.n && s[this.pos] !== '\n' && !OP_START.has(s[this.pos]) ? this.scanWord(false) : null;
    if (d === null) { this.error('here-doc', at, s.slice(dAt, this.eol(dAt))); return { kind: 'OP', at, end: this.pos, text: op, word: null, here: null }; }
    const quoted = !d.bare || d.parts.some((p) => p.t === 'sq' || p.t === 'dq' || p.t === 'ansi');
    const here: HereDoc = { at, end: this.pos, delim: partsValue(d.parts), quoted, strip: op === '<<-', body: '', terminated: false };
    this.pending.push(here);
    return { kind: 'OP', at, end: this.pos, text: op, word: null, here };
  }

  private eol(from: number): number { const j = this.s.indexOf('\n', from); return j < 0 ? this.n : j; }

  /** Тела ожидающих here-doc со строки после перевода строки (или с конца ввода — тогда тела нет и это ошибка). */
  private readHereDocs(): void {
    if (!this.pending.length) return;
    const s = this.s;
    for (const h of this.pending) {
      const lines: string[] = [];
      while (this.pos < this.n) {
        let eol = s.indexOf('\n', this.pos);
        const last = eol < 0;
        if (last) eol = this.n;
        const line = s.slice(this.pos, eol);
        const body = h.strip ? line.replace(/^\t+/, '') : line;
        if (body === h.delim) { h.terminated = true; this.pos = last ? this.n : eol + 1; break; }
        if (this.inSub > 0 && body.startsWith(`${h.delim})`)) { h.terminated = true; this.pos += line.length - body.length + h.delim.length; break; }
        lines.push(body);
        this.pos = last ? this.n : eol + 1;
      }
      h.body = lines.length ? lines.join('\n') + '\n' : '';
      if (!h.terminated) this.error('here-doc-unterminated', h.at, h.body);
      else if (!h.quoted && hasExpansion(h.body)) this.error('here-doc-expansion', h.at, h.body);
    }
    this.pending = [];
  }

  /** Words of `[[ … ]]` (bash 3.2.5.2): metacharacters end a word as anywhere else, so `]]` closes when glued to `;`,
   *  `&&` or `)`; `&&`, `||`, `(`, `)`, `<`, `>` are words of their own, a lone `;`, `&`, `|` is bash's syntax error. */
  scanCond(): { words: Word[]; closed: boolean } {
    const words: Word[] = [];
    for (;;) {
      this.skipBlanks();
      while (this.pos < this.n && this.s[this.pos] === '\n') { this.pos++; this.skipBlanks(); }
      if (this.pos >= this.n) return { words, closed: false };
      const c = this.s[this.pos];
      const prev = words[words.length - 1];
      const regex = prev !== undefined && prev.bare && prev.text === '=~';
      if (!regex && OP_START.has(c) && !((c === '<' || c === '>') && this.s[this.pos + 1] === '(')) {
        const op = (c === '&' || c === '|') && this.s[this.pos + 1] === c ? c + c : c;
        if (op === ';' || op === '&' || op === '|') return { words, closed: false };
        words.push({ at: this.pos, end: this.pos + op.length, text: op, parts: [{ t: 'lit', v: op }], bare: true, assign: false });
        this.pos += op.length;
        continue;
      }
      const w = this.scanWord(regex);
      if (w === null) return { words, closed: false };
      if (w.bare && w.text === ']]') return { words, closed: true };
      words.push(w);
    }
  }

  /** Конец арифметики `((…))`, начатой в from (за второй скобкой): позиция за `))` или -1, если это не арифметика. */
  arithmeticEnd(from: number): number {
    const s = this.s;
    let depth = 0;
    for (let i = from; i < s.length; i++) {
      const c = s[i];
      if (c === '\\') { i++; continue; }
      if (c === "'" || c === '"') { const j = s.indexOf(c, i + 1); if (j < 0) return -1; i = j; continue; }
      if (c === '(') depth++;
      else if (c === ')') { if (depth > 0) depth--; else return s[i + 1] === ')' ? i + 2 : -1; }
    }
    return -1;
  }

  /** Word from pos; regex — the operand of `=~` in `[[ … ]]`: `|` and `(` are word text, a group holds blanks and
   *  metacharacters, an unmatched `)` ends the word. null when the word is empty (pos stands on a delimiter). */
  scanWord(regex: boolean): Word | null {
    const s = this.s;
    const start = this.pos;
    const parts: Part[] = [];
    let lit = '';
    let escaped = false;
    let depth = 0;
    const flush = (): void => { if (lit) { parts.push({ t: 'lit', v: lit }); lit = ''; } };
    while (this.pos < this.n) {
      const c = s[this.pos];
      if (c === '\\') {
        if (s[this.pos + 1] === '\n') { this.pos += 2; continue; }
        if (s[this.pos + 1] === '\r' && s[this.pos + 2] === '\n') { this.pos += 3; continue; }
        if (this.pos + 1 < this.n) { lit += s[this.pos + 1]; escaped = true; this.pos += 2; continue; }
        lit += c; this.pos++; continue;
      }
      if (c === "'") {
        const j = s.indexOf("'", this.pos + 1);
        flush();
        if (j < 0) { this.error('unterminated-single-quote', this.pos, s.slice(this.pos + 1)); parts.push(this.sq(s.slice(this.pos + 1))); this.pos = this.n; break; }
        parts.push(this.sq(s.slice(this.pos + 1, j))); this.pos = j + 1; continue;
      }
      if (c === '"') { flush(); parts.push(this.scanDq()); continue; }
      if (c === '$') {
        if (s[this.pos + 1] === "'") { flush(); parts.push(this.scanAnsi()); continue; }
        if (s[this.pos + 1] === '"') { flush(); this.pos++; parts.push(this.scanDq()); continue; }
        const p = this.scanDollar('bare');
        if (p) { flush(); parts.push(p); continue; }
        lit += c; this.pos++; continue;
      }
      if (c === '`') { flush(); parts.push(this.scanBacktick()); continue; }
      if ((c === '<' || c === '>') && s[this.pos + 1] === '(') {
        flush();
        const at = this.pos; this.pos += 2;
        const r = this.hooks.sub(this, this.pos);
        const src = s.slice(at, this.pos);
        if (!r.closed) this.error('unterminated-substitution', at, src);
        parts.push({ t: 'proc', src, body: r.body, dir: c }); continue;
      }
      if (c === '(' && !parts.length && ASSIGN_HEAD.test(lit) && lit.endsWith('=')) {
        // bash 3.4: массив `NAME=(…)` — часть слова присваивания.
        const j = matchParen(s, this.pos);
        const text = s.slice(this.pos, j < 0 ? this.n : j + 1);
        if (j < 0) this.error('unterminated-array', this.pos, s.slice(this.pos));
        if (hasExpansion(text, 'bare')) { flush(); parts.push({ t: 'param', src: text }); } else lit += text;
        this.pos = j < 0 ? this.n : j + 1; continue;
      }
      if (regex && (c === '(' || c === '|' || (depth > 0 && (c === '\n' || isBlank(c) || OP_START.has(c))))) {
        if (c === '(') depth++; else if (c === ')') depth--;
        lit += c; this.pos++; continue;
      }
      if (c === '\n' || isBlank(c)) break;
      if (OP_START.has(c)) break;
      lit += c; this.pos++;
    }
    flush();
    if (this.pos === start) return null;
    const text = s.slice(start, this.pos);
    const bare = parts.length === 1 && parts[0].t === 'lit' && !escaped;
    const assign = parts[0]?.t === 'lit' && ASSIGN_HEAD.test(parts[0].v) && !escaped;
    return { at: start, end: this.pos, text, parts, bare, assign };
  }

  private sq(v: string): Part { return this.expandedByOuter && hasExpansion(v) ? { t: 'sq', v, dyn: true } : { t: 'sq', v }; }

  /** "…" (§2.2.3): `\` экранирует только `$`, `` ` ``, `"`, `\` и перевод строки; подстановки читаются как части. */
  private scanDq(): Part {
    const s = this.s;
    const at = this.pos++;
    const parts: Part[] = [];
    let lit = '';
    const flush = (): void => { if (lit) { parts.push({ t: 'lit', v: lit }); lit = ''; } };
    for (;;) {
      if (this.pos >= this.n) { this.error('unterminated-double-quote', at, s.slice(at + 1)); break; }
      const c = s[this.pos];
      if (c === '"') { this.pos++; break; }
      if (c === '\\') {
        const nx = s[this.pos + 1];
        if (nx === '\n') { this.pos += 2; continue; }
        if (nx === '$' || nx === '`' || nx === '"' || nx === '\\') { lit += nx; this.pos += 2; continue; }
        lit += c; this.pos++; continue;
      }
      if (c === '$') { const p = this.scanDollar('dq'); if (p) { flush(); parts.push(p); continue; } lit += c; this.pos++; continue; }
      if (c === '`') { flush(); parts.push(this.scanBacktick()); continue; }
      lit += c; this.pos++;
    }
    flush();
    return { t: 'dq', parts };
  }

  /** Подстановка с `$` в позиции pos: `$((…))`, `$(…)`, `${…}`, `$[…]`, `$X`, `$1`, `$@`; null — литеральный `$`. */
  private scanDollar(ctx: 'bare' | 'dq'): Part | null {
    const s = this.s;
    const at = this.pos;
    const nx = s[at + 1] ?? '';
    if (nx === '(') {
      if (s[at + 2] === '(') { const end = this.arithmeticEnd(at + 3); if (end >= 0) { this.pos = end; return { t: 'arith', src: s.slice(at, end) }; } }
      this.pos = at + 2;
      const r = this.hooks.sub(this, this.pos);
      const src = s.slice(at, this.pos);
      if (!r.closed) this.error('unterminated-substitution', at, src);
      return { t: 'cmd', src, body: r.body, bt: false };
    }
    if (nx === '{' || nx === '[') {
      const j = nx === '{' ? matchBrace(s, at + 1) : matchBracket(s, at + 1);
      if (j < 0) { this.error('unterminated-parameter', at, s.slice(at)); this.pos = this.n; return { t: 'param', src: s.slice(at) }; }
      this.pos = j + 1; return { t: 'param', src: s.slice(at, j + 1) };
    }
    if (!expansionAt(s, at, ctx)) return null;
    let j = at + 1;
    if (/[=~^+]/.test(nx)) j++;
    if (/[A-Za-z_]/.test(s[j] ?? '')) { j++; while (j < this.n && /[A-Za-z0-9_]/.test(s[j])) j++; }
    else j++;
    this.pos = j;
    return { t: 'param', src: s.slice(at, j) };
  }

  /** `…` (§2.6.3): внутри `\` экранирует `$`, `` ` `` и `\`; тело разбирается отдельно снятым текстом. */
  private scanBacktick(): Part {
    const s = this.s;
    const at = this.pos;
    let body = '';
    let i = at + 1;
    let closed = false;
    while (i < this.n) {
      const c = s[i];
      if (c === '\\' && (s[i + 1] === '$' || s[i + 1] === '`' || s[i + 1] === '\\')) { body += s[i + 1]; i += 2; continue; }
      if (c === '`') { closed = true; i++; break; }
      body += c; i++;
    }
    if (!closed) this.error('unterminated-backtick', at, body);
    this.pos = i;
    const script = this.hooks.script(body);
    for (const e of script.errors) this.error(e.kind, at, e.text);
    return { t: 'cmd', src: s.slice(at, i), body: script, bt: true };
  }

  /** $'…' (bash 3.1.2.4): экранирование ANSI-C раскодируется, `\'` не закрывает. */
  private scanAnsi(): Part {
    const s = this.s;
    const at = this.pos;
    let i = at + 2;
    let raw = '';
    let closed = false;
    while (i < this.n) {
      const c = s[i];
      if (c === '\\' && i + 1 < this.n) { raw += c + s[i + 1]; i += 2; continue; }
      if (c === "'") { closed = true; i++; break; }
      raw += c; i++;
    }
    if (!closed) this.error('unterminated-single-quote', at + 1, raw);
    this.pos = i;
    return { t: 'ansi', v: decodeAnsiC(raw) };
  }
}


const ANSI: Readonly<Record<string, string>> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };
export function decodeAnsiC(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== '\\' || i + 1 >= raw.length) { out += c; continue; }
    const nx = raw[i + 1];
    if (ANSI[nx] !== undefined) { out += ANSI[nx]; i++; continue; }
    const hex = /^x([0-9A-Fa-f]{1,2})/.exec(raw.slice(i + 1)) ?? /^u([0-9A-Fa-f]{1,4})/.exec(raw.slice(i + 1)) ?? /^U([0-9A-Fa-f]{1,8})/.exec(raw.slice(i + 1));
    if (hex) { out += String.fromCodePoint(Math.min(parseInt(hex[1], 16), 0x10ffff)); i += hex[0].length; continue; }
    const oct = /^[0-7]{1,3}/.exec(raw.slice(i + 1));
    if (oct) { out += String.fromCharCode(parseInt(oct[0], 8) & 0xff); i += oct[0].length; continue; }
    if (nx === 'c' && i + 2 < raw.length) { out += String.fromCharCode(raw.charCodeAt(i + 2) & 0x1f); i += 2; continue; }
    out += c;
  }
  return out;
}

/** Парная скобка для `(…)` массива и вложенных `$(` внутри `${…}`: кавычки и `\` пропускаются, тела here-doc — нет. */
export function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === "'") { const j = s.indexOf("'", i + 1); if (j < 0) return -1; i = j; continue; }
    if (c === '"') { const j = skipDq(s, i); if (j < 0) return -1; i = j; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}
function skipDq(s: string, open: number): number {
  for (let j = open + 1; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === '"') return j;
    if (s[j] === '$' && s[j + 1] === '(') { const e = matchParen(s, j + 1); if (e < 0) return -1; j = e; }
  }
  return -1;
}
/** Парная `}` для `${…}` (§2.6.2): вложенные `${`, кавычки и `$(…)` пропускаются. */
export function matchBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === "'" && depth > 0) { const j = s.indexOf("'", i + 1); if (j < 0) return -1; i = j; continue; }
    if (c === '"') { const j = skipDq(s, i); if (j < 0) return -1; i = j; continue; }
    if (c === '$' && s[i + 1] === '(') { const e = matchParen(s, i + 1); if (e < 0) return -1; i = e; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}
function matchBracket(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) return i; }
  }
  return -1;
}
