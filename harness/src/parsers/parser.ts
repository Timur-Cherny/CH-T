// Парсер оболочки: рекурсивный спуск по POSIX.1-2017 §2.10.2 с одним токеном просмотра вперёд.
// complete_command → list → and_or → pipeline (`!` pipe_sequence) → command: simple_command | compound_command
// redirect_list | function_definition; compound_command: brace_group `{ }`, subshell `( )`, for_clause, case_clause,
// if_clause, while_clause, until_clause. Расширения bash (3.2): `[[ … ]]`, `(( … ))`, `for (( … ))`, select,
// `function имя`, `|&`, `;&`, `;;&`, `&>`. Зарезервированные слова (§2.4) действуют только в позиции команды и
// только у слова без кавычек; `in` — третьим словом for/case; `}` — в позиции команды.
// Что не в грамматике — parse-error с позицией и остатком текста, разбор останавливается; ничего не бросается.
import { Lexer, type LexerHooks, type Token } from './lexer.ts';
import { isRedirectOp } from './ast.ts';
import type { AndOr, Arith, Case, CaseItem, Command, Cond, For, ForArith, Func, Group, If, List, Pipeline, Redirect, Script, Simple, Subshell, While, Word } from './ast.ts';

export interface ParseOptions { expandedByOuter?: boolean }

const CLOSERS: ReadonlySet<string> = new Set(['then', 'else', 'elif', 'fi', 'do', 'done', 'esac', '}', 'in']);
const FUNC_NAME = /^[A-Za-z_][\w.:-]*$/;
const CASE_TERMS: ReadonlySet<string> = new Set([';;', ';&', ';;&']);

export function parseShell(text: string, opts: ParseOptions = {}): Script {
  const hooks: LexerHooks = {
    sub: (lexer, from) => {
      lexer.inSub++;
      const p = new Parser(lexer);
      const body = p.substitution();
      lexer.inSub--;
      return { body: { at: from, end: lexer.pos, body, errors: [], src: lexer.s }, closed: p.closed };
    },
    script: (body) => parseShell(body, opts),
  };
  const lexer = new Lexer(text, hooks, opts);
  const p = new Parser(lexer);
  const body = p.program();
  return { at: 0, end: text.length, body, errors: lexer.errors, src: text };
}

class Parser {
  private tok: Token;
  private readonly lx: Lexer;
  closed = false;
  constructor(lx: Lexer) { this.lx = lx; this.tok = lx.next(); }

  private get dead(): boolean { return this.lx.dead; }
  private advance(): void { this.tok = this.lx.next(); }
  private fail(): void {
    if (this.lx.dead) return;
    this.lx.dead = true;
    this.lx.errors.push({ kind: 'parse-error', at: this.tok.at, text: this.lx.s.slice(this.tok.at) });
  }
  private isOp(t: string): boolean { return this.tok.kind === 'OP' && this.tok.text === t; }
  private isWord(t: string): boolean { return this.tok.kind === 'WORD' && this.tok.word !== null && this.tok.word.bare && this.tok.text === t; }
  private atStop(stop: ReadonlySet<string>): boolean {
    for (const s of stop) if (s === ')' || s.startsWith(';') ? this.isOp(s) : this.isWord(s)) return true;
    return false;
  }
  private linebreak(): void { while (this.tok.kind === 'NEWLINE') this.advance(); }
  private expectWord(w: string): void { if (this.isWord(w)) this.advance(); else this.fail(); }

  program(): List {
    const list = this.compoundList(new Set());
    if (!this.dead && this.tok.kind !== 'EOF') this.fail();
    return list;
  }

  /** Тело `$(…)`/`<(…)`: список до закрывающей скобки; лексер остаётся за ней. */
  substitution(): List {
    const list = this.compoundList(new Set([')']));
    if (this.isOp(')')) this.closed = true;
    else if (this.tok.kind !== 'EOF' && !this.dead) this.fail();
    return list;
  }

  /** list / compound_list: and_or, разделённые `;`, `&`, переводом строки, до слова-терминатора из stop. */
  private compoundList(stop: ReadonlySet<string>): List {
    const at = this.tok.at;
    const items: AndOr[] = [];
    for (;;) {
      this.linebreak();
      if (this.dead || this.tok.kind === 'EOF' || this.atStop(stop)) break;
      const a = this.andOr();
      items.push(a);
      if (this.dead) break;
      if (this.isOp('&')) { a.bg = true; a.end = this.tok.end; this.advance(); continue; }
      if (this.isOp(';')) { this.advance(); continue; }
      if (this.tok.kind === 'NEWLINE' || this.tok.kind === 'EOF' || this.atStop(stop)) continue;
      this.fail();
      break;
    }
    return { at, end: items.length ? items[items.length - 1].end : at, items };
  }

  private andOr(): AndOr {
    const at = this.tok.at;
    const pipelines = [this.pipeline()];
    const ops: Array<'&&' | '||'> = [];
    while (!this.dead && (this.isOp('&&') || this.isOp('||'))) {
      ops.push(this.tok.text as '&&' | '||');
      this.advance();
      this.linebreak();
      pipelines.push(this.pipeline());
    }
    return { at, end: pipelines[pipelines.length - 1].end, pipelines, ops, bg: false };
  }

  private pipeline(): Pipeline {
    const at = this.tok.at;
    let negated = false;
    if (this.isWord('!')) { negated = true; this.advance(); }
    const commands = [this.command()];
    const stderr: boolean[] = [];
    while (!this.dead && (this.isOp('|') || this.isOp('|&'))) {
      stderr.push(this.tok.text === '|&');
      this.advance();
      this.linebreak();
      commands.push(this.command());
    }
    return { at, end: commands[commands.length - 1].end, commands, negated, stderr };
  }

  private command(): Command {
    const t = this.tok;
    if (t.kind === 'OP') {
      if (t.text === '(') {
        if (this.lx.s[t.at + 1] === '(') { const end = this.lx.arithmeticEnd(t.at + 2); if (end >= 0) return this.arith(t.at, end); }
        return this.subshell();
      }
      this.fail();
      return { kind: 'simple', at: t.at, end: t.at, words: [], redirects: [] };
    }
    if (t.kind === 'WORD' && t.word !== null && t.word.bare) {
      switch (t.text) {
        case '{': return this.group();
        case 'if': return this.ifClause();
        case 'while': case 'until': return this.whileClause(t.text);
        case 'for': case 'select': return this.forClause(t.text);
        case 'case': return this.caseClause();
        case '[[': return this.cond();
        case 'function': return this.funcKeyword();
      }
      if (CLOSERS.has(t.text)) { this.fail(); return { kind: 'simple', at: t.at, end: t.at, words: [], redirects: [] }; }
      if (FUNC_NAME.test(t.text) && this.parensFollow(t.end)) return this.funcPosix();
    }
    return this.simple();
  }

  /** `имя ()` — объявление функции (§2.9.5): за словом, через пробелы, стоят `(` и `)`. */
  private parensFollow(from: number): boolean {
    const s = this.lx.s;
    let i = from;
    while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
    if (s[i] !== '(') return false;
    i++;
    while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
    return s[i] === ')';
  }

  private simple(): Simple {
    const at = this.tok.at;
    const words: Word[] = [];
    const redirects: Redirect[] = [];
    let end = at;
    for (;;) {
      if (this.tok.kind === 'IO_NUMBER' || (this.tok.kind === 'OP' && isRedirectOp(this.tok.text))) {
        const r = this.redirect();
        if (r) { redirects.push(r); end = r.end; }
        if (this.dead) break;
        continue;
      }
      if (this.tok.kind === 'WORD' && this.tok.word !== null) { words.push(this.tok.word); end = this.tok.end; this.advance(); continue; }
      break;
    }
    if (!words.length && !redirects.length) this.fail();
    return { kind: 'simple', at, end, words, redirects };
  }

  private redirect(): Redirect | null {
    const at = this.tok.at;
    let fd: number | null = null;
    if (this.tok.kind === 'IO_NUMBER') { fd = Number(this.tok.text); this.advance(); }
    if (!(this.tok.kind === 'OP' && isRedirectOp(this.tok.text))) { this.fail(); return null; }
    const { text: op, here, end: opEnd } = this.tok;
    this.advance();
    if (op === '<<' || op === '<<-') return here ? { at, end: opEnd, fd, op, target: null, here } : null;
    if (this.tok.kind !== 'WORD' || this.tok.word === null) { this.fail(); return null; }
    const target = this.tok.word;
    this.advance();
    return { at, end: target.end, fd, op, target, here: null };
  }

  private redirects(): Redirect[] {
    const out: Redirect[] = [];
    while (!this.dead && (this.tok.kind === 'IO_NUMBER' || (this.tok.kind === 'OP' && isRedirectOp(this.tok.text)))) {
      const r = this.redirect();
      if (r) out.push(r);
    }
    return out;
  }

  private group(): Group {
    const at = this.tok.at;
    this.advance();
    const body = this.compoundList(new Set(['}']));
    this.expectWord('}');
    return { kind: 'group', at, end: this.tok.at, body, redirects: this.redirects() };
  }

  private subshell(): Subshell {
    const at = this.tok.at;
    this.advance();
    const body = this.compoundList(new Set([')']));
    if (this.isOp(')')) this.advance(); else this.fail();
    return { kind: 'subshell', at, end: this.tok.at, body, redirects: this.redirects() };
  }

  private arith(at: number, end: number): Arith {
    const src = this.lx.s.slice(at + 2, end - 2);
    this.lx.pos = end;
    this.advance();
    return { kind: 'arith', at, end, src, redirects: this.redirects() };
  }

  private ifClause(): If {
    const at = this.tok.at;
    this.advance();
    const clauses: Array<{ cond: List; body: List }> = [];
    let otherwise: List | null = null;
    for (;;) {
      const cond = this.compoundList(new Set(['then']));
      this.expectWord('then');
      const body = this.compoundList(new Set(['elif', 'else', 'fi']));
      clauses.push({ cond, body });
      if (this.dead) break;
      if (this.isWord('elif')) { this.advance(); continue; }
      if (this.isWord('else')) { this.advance(); otherwise = this.compoundList(new Set(['fi'])); }
      break;
    }
    this.expectWord('fi');
    return { kind: 'if', at, end: this.tok.at, clauses, otherwise, redirects: this.redirects() };
  }

  private whileClause(kind: 'while' | 'until'): While {
    const at = this.tok.at;
    this.advance();
    const cond = this.compoundList(new Set(['do']));
    this.expectWord('do');
    const body = this.compoundList(new Set(['done']));
    this.expectWord('done');
    return { kind, at, end: this.tok.at, cond, body, redirects: this.redirects() };
  }

  private forClause(kind: 'for' | 'select'): For | ForArith {
    const at = this.tok.at;
    this.advance();
    if (kind === 'for' && this.isOp('(') && this.lx.s[this.tok.at + 1] === '(') {
      const end = this.lx.arithmeticEnd(this.tok.at + 2);
      if (end >= 0) {
        const src = this.lx.s.slice(this.tok.at + 2, end - 2);
        this.lx.pos = end;
        this.advance();
        if (this.isOp(';')) this.advance();
        return { kind: 'for-arith', at, end: 0, src, ...this.doGroup() };
      }
    }
    if (this.tok.kind !== 'WORD' || this.tok.word === null) { this.fail(); return { kind, at, end: at, name: emptyWord(at), words: null, body: { at, end: at, items: [] }, redirects: [] }; }
    const name = this.tok.word;
    this.advance();
    this.linebreak();
    let words: Word[] | null = null;
    if (this.isWord('in')) {
      this.advance();
      words = [];
      while (this.tok.kind === 'WORD' && this.tok.word !== null) { words.push(this.tok.word); this.advance(); }
    }
    if (this.isOp(';')) this.advance();
    return { kind, at, end: 0, name, words, ...this.doGroup() };
  }

  /** do_group: `do` compound_list `done` плюс редиректы составной команды. */
  private doGroup(): { body: List; redirects: Redirect[]; end: number } {
    this.linebreak();
    this.expectWord('do');
    const body = this.compoundList(new Set(['done']));
    this.expectWord('done');
    return { body, redirects: this.redirects(), end: this.tok.at };
  }

  private caseClause(): Case {
    const at = this.tok.at;
    this.advance();
    const word = this.tok.kind === 'WORD' && this.tok.word !== null ? this.tok.word : null;
    if (!word) { this.fail(); return { kind: 'case', at, end: at, word: emptyWord(at), items: [], redirects: [] }; }
    this.advance();
    this.linebreak();
    this.expectWord('in');
    const items: CaseItem[] = [];
    for (;;) {
      this.linebreak();
      if (this.dead || this.isWord('esac') || this.tok.kind === 'EOF') break;
      const itemAt = this.tok.at;
      if (this.isOp('(')) this.advance();
      const patterns: Word[] = [];
      for (;;) {
        if (this.tok.kind !== 'WORD' || this.tok.word === null) { this.fail(); break; }
        patterns.push(this.tok.word);
        this.advance();
        if (this.isOp('|')) { this.advance(); continue; }
        break;
      }
      if (this.dead) break;
      if (this.isOp(')')) this.advance(); else { this.fail(); break; }
      const body = this.compoundList(CASE_TERMS_WITH_ESAC);
      let term: CaseItem['term'] = null;
      if (this.tok.kind === 'OP' && CASE_TERMS.has(this.tok.text)) { term = this.tok.text as CaseItem['term']; this.advance(); }
      items.push({ at: itemAt, end: this.tok.at, patterns, body, term });
      if (term === null) break;
    }
    this.expectWord('esac');
    return { kind: 'case', at, end: this.tok.at, word, items, redirects: this.redirects() };
  }

  private cond(): Cond {
    const at = this.tok.at;
    const r = this.lx.scanCond();
    if (!r.closed) this.fail();
    this.advance();
    return { kind: 'cond', at, end: this.tok.at, words: r.words, redirects: this.redirects() };
  }

  /** `function имя [()] тело` (bash 3.3). */
  private funcKeyword(): Func {
    const at = this.tok.at;
    this.advance();
    if (this.tok.kind !== 'WORD' || this.tok.word === null) { this.fail(); return { kind: 'func', at, end: at, name: '', body: { kind: 'simple', at, end: at, words: [], redirects: [] } }; }
    const name = this.tok.text;
    this.advance();
    if (this.isOp('(')) { this.advance(); if (this.isOp(')')) this.advance(); else this.fail(); }
    return this.funcBody(at, name);
  }

  /** `имя () тело` (§2.9.5). */
  private funcPosix(): Func {
    const at = this.tok.at;
    const name = this.tok.text;
    this.advance();
    this.advance();
    if (this.isOp(')')) this.advance(); else this.fail();
    return this.funcBody(at, name);
  }

  private funcBody(at: number, name: string): Func {
    this.linebreak();
    const body = this.command();
    if (body.kind === 'simple' && !this.dead) this.fail();
    return { kind: 'func', at, end: body.end, name, body };
  }
}

const CASE_TERMS_WITH_ESAC: ReadonlySet<string> = new Set([';;', ';&', ';;&', 'esac']);
const emptyWord = (at: number): Word => ({ at, end: at, text: '', parts: [], bare: false, assign: false });
