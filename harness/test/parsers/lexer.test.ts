// INVARIANT: лексер читает токены по POSIX.1-2017 §2.3 (правила 1–11) и кавычки по §2.2; каждое правило —
// своя группа тестов. Незакрытое — ошибка с позицией и текстом, не исключение и не тишина.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Lexer, decodeAnsiC, matchBrace, matchParen } from '../../src/parsers/lexer.ts';
import { parseShell } from '../../src/parsers/parser.ts';
import { partsValue } from '../../src/parsers/ast.ts';
import type { Part, Word } from '../../src/parsers/ast.ts';
import type { Token } from '../../src/parsers/lexer.ts';

const hooks = {
  sub: (lx: Lexer, from: number) => { const script = parseShell(lx.s.slice(from)); const close = lx.s.indexOf(')', from); lx.pos = close < 0 ? lx.n : close + 1; return { body: { ...script, at: from, end: lx.pos }, closed: close >= 0 }; },
  script: (text: string) => parseShell(text),
};
function tokens(s: string, opts: { expandedByOuter?: boolean } = {}): Token[] {
  const lx = new Lexer(s, hooks, opts);
  const out: Token[] = [];
  for (let i = 0; i < 200; i++) { const t = lx.next(); out.push(t); if (t.kind === 'EOF') break; }
  return out;
}
const kinds = (s: string): string[] => tokens(s).map((t) => (t.kind === 'WORD' ? `W:${t.text}` : t.kind === 'OP' ? `OP:${t.text}` : t.kind === 'IO_NUMBER' ? `IO:${t.text}` : t.kind)).filter((k) => k !== 'EOF');
const word = (s: string): Word => { const t = tokens(s)[0]; assert.equal(t.kind, 'WORD', s); return t.word as Word; };
const errorsOf = (s: string): string[] => { const lx = new Lexer(s, hooks); for (let i = 0; i < 200; i++) if (lx.next().kind === 'EOF') break; return lx.errors.map((e) => e.kind); };

describe('lexer §2.3 — token recognition', () => {
  it('rule 1: end of input delimits the current token', () => {
    assert.deepEqual(kinds('psql'), ['W:psql']);
    assert.deepEqual(kinds(''), []);
  });
  it('rules 2–3: operators are read longest-first — `&&` `||` `;;` `;&` `;;&` `<<-` `<<<` `>|` `<&` `>&` `<>` `|&` `&>` `&>>`', () => {
    for (const op of ['&&', '||', ';;', ';&', ';;&', '>>', '<&', '>&', '<>', '>|', '|&', '&>', '&>>', '(', ')', ';', '&', '|', '<', '>']) assert.deepEqual(kinds(`a ${op} b`), ['W:a', `OP:${op}`, 'W:b'], op);
    assert.deepEqual(kinds('a&&b||c'), ['W:a', 'OP:&&', 'W:b', 'OP:||', 'W:c']);
  });
  it('rule 4: quoting reads to its end — `\\`, single and double quotes keep their content', () => {
    assert.deepEqual(word(`'a b;c'`).parts, [{ t: 'sq', v: 'a b;c' }]);
    assert.deepEqual(word('"a b" ').parts, [{ t: 'dq', parts: [{ t: 'lit', v: 'a b' }] }]);
    assert.deepEqual(word('a\\ b').parts, [{ t: 'lit', v: 'a b' }]);
    assert.equal(word('"x\\$y\\"z"').parts.length, 1);
    assert.equal(partsValue(word('"x\\$y\\"z"').parts), 'x$y"z');
    assert.equal(partsValue(word('"a\\nb"').parts), 'a\\nb', 'в двойных кавычках `\\n` — две буквы, экранируются только $ ` " \\');
  });
  it('rule 5: `$` and backtick read to the end of the expansion — $X ${…} $(…) $((…)) `…` $[…]', () => {
    assert.deepEqual(word('$X').parts, [{ t: 'param', src: '$X' }]);
    assert.deepEqual(word('${X:-a}b').parts, [{ t: 'param', src: '${X:-a}' }, { t: 'lit', v: 'b' }]);
    assert.deepEqual(word('$((1+(2*3)))').parts.map((p) => p.t), ['arith']);
    assert.deepEqual(word('$(echo hi)').parts.map((p) => p.t), ['cmd']);
    assert.deepEqual(word('`date`').parts.map((p) => (p.t === 'cmd' ? p.bt : p.t)), [true]);
    assert.deepEqual(word('$[1+2]').parts, [{ t: 'param', src: '$[1+2]' }]);
    assert.deepEqual(word('a$1$@$#$?$$$!$-$0').parts.filter((p) => p.t === 'param').map((p) => (p as { src: string }).src), ['$1', '$@', '$#', '$?', '$$', '$!', '$-', '$0']);
    assert.deepEqual(word('$=X$~Y').parts.map((p) => (p.t === 'param' ? p.src : p.t)), ['$=X', '$~Y'], 'zsh-формы раскрытия');
  });
  it('rule 5: a literal dollar is not an expansion — `$.`, `$ `, `$"`-less trailing `$`, `\\$`', () => {
    assert.deepEqual(word('a$.b').parts, [{ t: 'lit', v: 'a$.b' }]);
    assert.deepEqual(word('a$').parts, [{ t: 'lit', v: 'a$' }]);
    assert.deepEqual(word('\\$X').parts, [{ t: 'lit', v: '$X' }]);
  });
  it('rule 6: an operator character delimits the word; `<(` and `>(` start a process substitution inside a word', () => {
    assert.deepEqual(kinds('a;b|c'), ['W:a', 'OP:;', 'W:b', 'OP:|', 'W:c']);
    assert.deepEqual(word('<(ls)').parts.map((p) => p.t), ['proc']);
    assert.deepEqual(kinds('psql -f <(cat q.sql)'), ['W:psql', 'W:-f', 'W:<(cat q.sql)']);
  });
  it('rule 7: newline is a token; rule 8: blanks (space, tab, CR) are discarded; `\\`-newline joins lines', () => {
    assert.deepEqual(kinds('a \t b\r\nc'), ['W:a', 'W:b', 'NEWLINE', 'W:c']);
    assert.deepEqual(kinds('a \\\n b'), ['W:a', 'W:b']);
    assert.equal(partsValue(word('ab\\\ncd').parts), 'abcd', 'продолжение внутри слова: текст слова хранит исходник, значение — без переноса');
    assert.deepEqual(kinds('a \\\r\n b'), ['W:a', 'W:b'], 'CRLF');
  });
  it('rule 9–11: a word continues through letters, digits, `=`, `{`, `}`, `[[`, `!` — no operator inside', () => {
    assert.deepEqual(kinds('echo {a,b} x=1 [[ ! ]]'), ['W:echo', 'W:{a,b}', 'W:x=1', 'W:[[', 'W:!', 'W:]]']);
  });
  it('rule 10: `#` at the start of a token opens a comment to the end of the line; inside a word it is a letter', () => {
    assert.deepEqual(kinds('a # b c\nd'), ['W:a', 'NEWLINE', 'W:d']);
    assert.deepEqual(kinds('a#b'), ['W:a#b']);
    assert.deepEqual(kinds('#only'), []);
  });
  it('IO_NUMBER (§2.7): digits immediately before `<` or `>`', () => {
    assert.deepEqual(kinds('cmd 2>&1 >/dev/null 3<f'), ['W:cmd', 'IO:2', 'OP:>&', 'W:1', 'OP:>', 'W:/dev/null', 'IO:3', 'OP:<', 'W:f']);
    assert.deepEqual(kinds('echo 2 >x'), ['W:echo', 'W:2', 'OP:>', 'W:x'], 'цифра через пробел — слово');
  });
});

describe('lexer §2.2 — quoting and word properties', () => {
  it('bare: only a single unquoted literal without escapes can be a reserved word', () => {
    assert.equal(word('if').bare, true);
    assert.equal(word('"if"').bare, false);
    assert.equal(word('\\if').bare, false);
    assert.equal(word('i$f').bare, false);
  });
  it('assign: NAME=…, NAME+=…, NAME[i]=…, NAME=(array) — quoted name is not an assignment', () => {
    for (const s of ['A=1', 'A+=1', 'A[2]=x', 'A=', 'A=(1 2)']) assert.equal(word(s).assign, true, s);
    for (const s of ['"A"=1', '1A=2', 'A', 'a-b=1']) assert.equal(word(s).assign, false, s);
    assert.equal(partsValue(word('A=(1 "2 3")').parts), 'A=(1 "2 3")', 'массив — часть слова присваивания');
    assert.deepEqual(word('A=($(ls))').parts.map((p) => p.t), ['lit', 'param'], 'массив с подстановкой — динамическая часть');
  });
  it("$'…' decodes ANSI-C escapes and keeps \\' inside; $\"…\" is a double-quoted string", () => {
    assert.deepEqual(word("$'a\\nb\\x41\\''").parts, [{ t: 'ansi', v: "a\nbA'" }]);
    assert.equal(decodeAnsiC('\\t\\101\\u0416\\e\\q'), '\tA\u0416\x1b\\q');
    assert.deepEqual(word('$"hi $X"').parts.map((p) => p.t), ['dq']);
  });
  it('expandedByOuter: a dollar inside single quotes of a body the outer shell already expanded is dynamic', () => {
    const t = tokens("psql -c '$SQL'", { expandedByOuter: true });
    assert.deepEqual(t[2].word?.parts, [{ t: 'sq', v: '$SQL', dyn: true }]);
    assert.deepEqual(tokens("psql -c '$SQL'")[2].word?.parts, [{ t: 'sq', v: '$SQL' }]);
  });
  it('unterminated forms are errors with position and text, never exceptions', () => {
    assert.deepEqual(errorsOf("echo 'open"), ['unterminated-single-quote']);
    assert.deepEqual(errorsOf('echo "open'), ['unterminated-double-quote']);
    assert.deepEqual(errorsOf('echo `date'), ['unterminated-backtick']);
    assert.deepEqual(errorsOf('echo ${x'), ['unterminated-parameter']);
    assert.deepEqual(errorsOf("echo $'x"), ['unterminated-single-quote']);
    assert.deepEqual(errorsOf('A=(1 2'), ['unterminated-array']);
  });
});

describe('lexer §2.7.4 — here-documents', () => {
  const heredocs = (s: string) => tokens(s).filter((t) => t.here).map((t) => ({ delim: t.here?.delim, quoted: t.here?.quoted, strip: t.here?.strip, body: t.here?.body, terminated: t.here?.terminated }));
  it('reads the body from the line after the newline to the delimiter; quoted delimiter = no expansion', () => {
    assert.deepEqual(heredocs('cat <<EOF\nа\nEOF\n'), [{ delim: 'EOF', quoted: false, strip: false, body: 'а\n', terminated: true }]);
    assert.deepEqual(heredocs("cat <<'EOF'\n$X\nEOF"), [{ delim: 'EOF', quoted: true, strip: false, body: '$X\n', terminated: true }]);
    assert.deepEqual(heredocs('cat <<"E O F"\nx\nE O F'), [{ delim: 'E O F', quoted: true, strip: false, body: 'x\n', terminated: true }]);
    assert.deepEqual(heredocs('cat <<\\EOF\nx\nEOF'), [{ delim: 'EOF', quoted: true, strip: false, body: 'x\n', terminated: true }], 'экранированный ограничитель = без подстановок');
  });
  it('<<- strips leading tabs of the body and of the delimiter; two here-docs are read in order', () => {
    assert.deepEqual(heredocs('cat <<-EOF\n\tone\n\tEOF').map((h) => h.body), ['one\n']);
    assert.deepEqual(heredocs("cmd <<'A' <<'B'\nfirst\nA\nsecond\nB").map((h) => [h.delim, h.body]), [['A', 'first\n'], ['B', 'second\n']]);
  });
  it('the body starts after the NEWLINE even when operators follow the redirect on the line', () => {
    const t = tokens('psql <<SQL | tail\nSELECT 1;\nSQL\necho x');
    assert.deepEqual(t.filter((x) => x.here).map((x) => x.here?.body), ['SELECT 1;\n']);
    assert.deepEqual(t.filter((x) => x.kind === 'WORD').map((x) => x.text), ['psql', 'tail', 'echo', 'x'], 'строки тела не становятся словами');
  });
  it('a missing delimiter or a missing terminator is an error, and an unquoted body with `$` is noted as expanded', () => {
    assert.deepEqual(errorsOf('cat <<'), ['here-doc']);
    assert.deepEqual(errorsOf('cat <<EOF\nno end'), ['here-doc-unterminated']);
    assert.deepEqual(errorsOf('cat <<EOF'), ['here-doc-unterminated']);
    assert.deepEqual(errorsOf('cat <<EOF\n$HOME\nEOF'), ['here-doc-expansion']);
    assert.deepEqual(errorsOf("cat <<'EOF'\n$HOME\nEOF"), []);
  });
  it('inside $(…) the delimiter may be written as `EOF)`: the parenthesis is read again as the closer', () => {
    const script = parseShell('echo "$(cat <<EOF\nx\nEOF)" && echo after');
    assert.deepEqual(script.errors, []);
    const cmd = script.body.items[0].pipelines[0].commands[0];
    assert.equal(cmd.kind, 'simple');
    const dq = cmd.kind === 'simple' ? cmd.words[1].parts[0] : null;
    const sub = dq && dq.t === 'dq' ? dq.parts[0] : null;
    assert.equal(sub?.t, 'cmd');
    const inner = sub && sub.t === 'cmd' ? sub.body.body.items[0].pipelines[0].commands[0] : null;
    assert.deepEqual(inner && inner.kind === 'simple' ? inner.redirects.map((r) => [r.here?.body, r.here?.terminated]) : null, [['x\n', true]]);
    assert.equal(script.body.items[0].pipelines.length, 2, 'команда за подстановкой разобрана');
  });
});

describe('lexer — bash conditional and arithmetic scanners', () => {
  it('scanCond splits `[[ … ]]` words at blanks and metacharacters; `&&`, `||`, `(`, `)`, `<`, `>` are words of their own', () => {
    const lx = new Lexer(' $a == b && ( $c -lt 2 ) ]] && echo', hooks);
    const r = lx.scanCond();
    assert.equal(r.closed, true);
    assert.deepEqual(r.words.map((w) => w.text), ['$a', '==', 'b', '&&', '(', '$c', '-lt', '2', ')']);
    assert.deepEqual(kinds(lx.s.slice(lx.pos)), ['OP:&&', 'W:echo']);
    assert.deepEqual(new Lexer(' (a == a) ]]', hooks).scanCond().words.map((w) => w.text), ['(', 'a', '==', 'a', ')']);
    assert.deepEqual(new Lexer(' a<b ]]', hooks).scanCond().words.map((w) => w.text), ['a', '<', 'b']);
  });
  it('scanCond closes on `]]` glued to `;`, `&&`, `)` and leaves the operator to the parser (REGRESSION 25.09: `if [[ … ]]; then` hid the rest)', () => {
    for (const [src, rest] of [[' x ]]; echo', ['OP:;', 'W:echo']], [' x ]]&& echo', ['OP:&&', 'W:echo']], [' x ]])', ['OP:)']]] as const) {
      const lx = new Lexer(src, hooks);
      const r = lx.scanCond();
      assert.equal(r.closed, true, src);
      assert.deepEqual(r.words.map((w) => w.text), ['x'], src);
      assert.deepEqual(kinds(lx.s.slice(lx.pos)), rest, src);
    }
    assert.equal(new Lexer(' a ; ]]', hooks).scanCond().closed, false, 'a lone `;` inside `[[ … ]]` is a bash syntax error');
  });
  it('scanCond reads the operand of `=~` as a regex: `|`, parentheses and blanks inside a group belong to the word', () => {
    const words = (src: string): string[] => new Lexer(src, hooks).scanCond().words.map((w) => w.text);
    assert.deepEqual(words(' ab =~ a|b ]]'), ['ab', '=~', 'a|b']);
    assert.deepEqual(words(' "a b" =~ (a b) ]]'), ['"a b"', '=~', '(a b)']);
    assert.deepEqual(words(' ab =~ ^(a|b)b$ ]];'), ['ab', '=~', '^(a|b)b$']);
    assert.deepEqual(words(' ( $x =~ a ) ]]'), ['(', '$x', '=~', 'a', ')'], 'an unmatched `)` ends the regex and closes the group');
  });
  it('arithmeticEnd finds `))` with balanced inner parentheses and refuses `$( (subshell) )`', () => {
    const lx = new Lexer('((1 + (2*3)))', hooks);
    assert.equal(lx.arithmeticEnd(2), lx.n);
    assert.equal(new Lexer('( (echo a) )', hooks).arithmeticEnd(2), -1);
    assert.deepEqual(word('$( (echo a) )').parts.map((p) => p.t), ['cmd'], 'подоболочка в подстановке — команда, не арифметика');
  });
  it('matchParen and matchBrace honour quotes, escapes and nesting', () => {
    assert.equal(matchParen("(a ')' b)", 0), 8);
    assert.equal(matchParen('(a "$(b)" c)', 0), 11);
    assert.equal(matchBrace('{x:-${y}}', 0), 8);
    assert.equal(matchBrace('{x', 0), -1);
  });
});

describe('lexer — cyrillic and emoji positions are character offsets, not bytes', () => {
  it('records `at`/`end` in string indices so the source can be sliced back', () => {
    const s = 'echo "привет 🌍" файл.txt';
    const t = tokens(s).filter((x) => x.kind === 'WORD');
    assert.deepEqual(t.map((x) => s.slice(x.at, x.end)), ['echo', '"привет 🌍"', 'файл.txt']);
    assert.equal(partsValue(t[1].word!.parts as Part[]), 'привет 🌍');
  });
});
