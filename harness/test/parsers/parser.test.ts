// INVARIANT: парсер строит дерево по §2.10.2 — каждый нетерминал и каждая конструкция bash из шапки parser.ts
// разбираются в свой узел; что вне грамматики — parse-error с позицией и остатком текста, дерево до ошибки
// сохраняется, исключений нет; печать дерева и повторный разбор дают то же дерево (свойство на корпусе и фаззе).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseShell } from '../../src/parsers/parser.ts';
import { print, shape, wordValue } from '../../src/parsers/ast.ts';
import type { Command, List, Script } from '../../src/parsers/ast.ts';

const parse = (s: string): Script => parseShell(s);
const cmds = (l: List): Command[] => l.items.flatMap((a) => a.pipelines.flatMap((p) => p.commands));
const first = (s: string): Command => { const c = cmds(parse(s).body)[0]; assert.ok(c, s); return c; };
const kinds = (s: string): string[] => cmds(parse(s).body).map((c) => c.kind);
const argv = (c: Command): string[] => (c.kind === 'simple' ? c.words.map(wordValue) : []);
const errors = (s: string): string[] => parse(s).errors.map((e) => e.kind);
const clean = (s: string): Script => { const p = parse(s); assert.deepEqual(p.errors, [], s); return p; };

describe('parser §2.10 — list, and_or, pipeline', () => {
  it('list: `;`, `&` (background) and newlines separate and_or items; empty lines and leading newlines are allowed', () => {
    const p = clean('\n\na; b &\n\nc\n');
    assert.deepEqual(p.body.items.map((a) => [argv(a.pipelines[0].commands[0])[0], a.bg]), [['a', false], ['b', true], ['c', false]]);
  });
  it('and_or: `&&`/`||` chain pipelines, a newline after the operator continues the line', () => {
    const p = clean('a && b ||\n c');
    assert.deepEqual(p.body.items[0].ops, ['&&', '||']);
    assert.equal(p.body.items[0].pipelines.length, 3);
  });
  it('pipeline: `|` and `|&`, leading `!` negates; a newline after `|` continues', () => {
    const p = clean('! a |\n b |& c');
    const pl = p.body.items[0].pipelines[0];
    assert.deepEqual([pl.negated, pl.commands.length, pl.stderr], [true, 3, [false, true]]);
  });
});

describe('parser §2.10 — simple_command and io_redirect', () => {
  it('assignment words, command word, arguments and redirects in any order; redirects carry fd and target', () => {
    const c = first('A=1 B="$x" cmd 2>&1 -v <in >>out');
    assert.equal(c.kind, 'simple');
    if (c.kind !== 'simple') return;
    assert.deepEqual(c.words.map((w) => [wordValue(w), w.assign]), [['A=1', true], ['B=$x', true], ['cmd', false], ['-v', false]]);
    assert.deepEqual(c.redirects.map((r) => [r.fd, r.op, r.target ? wordValue(r.target) : null]), [[2, '>&', '1'], [null, '<', 'in'], [null, '>>', 'out']]);
  });
  it('here-doc and here-string are redirects: body on the here-doc, the word on the here-string', () => {
    const c = first("cat <<'EOF' <<< str\nbody\nEOF");
    if (c.kind !== 'simple') return assert.fail();
    assert.deepEqual(c.redirects.map((r) => [r.op, r.here?.body ?? null, r.target ? wordValue(r.target) : null]), [['<<', 'body\n', null], ['<<<', null, 'str']]);
  });
  it('a redirect without a target and a lone `<<` are grammar errors, not silence', () => {
    assert.deepEqual(errors('cmd >'), ['parse-error']);
    assert.deepEqual(errors('cmd <<'), ['here-doc']);
  });
});

describe('parser §2.10 — compound commands', () => {
  it('brace group and subshell with trailing redirects; `{` is a group only in command position', () => {
    const g = first('{ a; b; } > out');
    assert.equal(g.kind, 'group');
    if (g.kind === 'group') { assert.equal(cmds(g.body).length, 2); assert.deepEqual(g.redirects.map((r) => r.op), ['>']); }
    const s = first('(a | b) 2>err');
    assert.equal(s.kind, 'subshell');
    assert.deepEqual(argv(first('echo {a,b} }')), ['echo', '{a,b}', '}'], 'фигурные скобки внутри слова и после команды — буквы');
  });
  it('if / elif / else / fi with lists as conditions', () => {
    const c = first('if a; then b; elif c\nthen d; else e; fi');
    assert.equal(c.kind, 'if');
    if (c.kind !== 'if') return;
    assert.deepEqual(c.clauses.map((k) => [argv(cmds(k.cond)[0])[0], argv(cmds(k.body)[0])[0]]), [['a', 'b'], ['c', 'd']]);
    assert.equal(argv(cmds(c.otherwise!)[0])[0], 'e');
  });
  it('while / until with `do … done`; `for` with and without `in`; `select`; `for (( … ))`', () => {
    assert.deepEqual(kinds('while read x; do echo $x; done < f'), ['while']);
    assert.deepEqual(kinds('until a; do b; done'), ['until']);
    const f = first('for f in a "b c" $(ls)\ndo\n  echo $f\ndone');
    assert.equal(f.kind, 'for');
    if (f.kind === 'for') assert.deepEqual(f.words?.map(wordValue), ['a', 'b c', '$(ls)']);
    const g = first('for f; do echo $f; done');
    if (g.kind === 'for') assert.equal(g.words, null); else assert.fail();
    assert.deepEqual(kinds('select x in a b; do echo $x; done'), ['select']);
    const fa = first('for ((i=0; i<3; i++)); do echo $i; done');
    assert.equal(fa.kind, 'for-arith');
    if (fa.kind === 'for-arith') assert.equal(fa.src, 'i=0; i<3; i++');
  });
  it('case: patterns with `|` and optional `(`, terminators `;;` `;&` `;;&`, last item without one; `)` in a pattern is not a subshell', () => {
    const c = first('case $x in\n (a|b) echo ab;;\n c) echo c;&\n d) echo d;;&\n *) echo other\nesac');
    assert.equal(c.kind, 'case');
    if (c.kind !== 'case') return;
    assert.deepEqual(c.items.map((it) => [it.patterns.map(wordValue), it.term]), [[['a', 'b'], ';;'], [['c'], ';&'], [['d'], ';;&'], [['*'], null]]);
    assert.deepEqual(errors('echo "$(case $x in a) echo A;; esac)"'), [], 'скобка шаблона внутри $(…) не закрывает подстановку');
  });
  it('`[[ … ]]` is a conditional command, `(( … ))` an arithmetic one; `$( (a) )` is a subshell inside a substitution', () => {
    const c = first('[[ -f $x && ( $y == "a b" ) ]] && echo ok');
    assert.equal(c.kind, 'cond');
    if (c.kind === 'cond') assert.deepEqual(c.words.map((w) => w.text), ['-f', '$x', '&&', '(', '$y', '==', '"a b"', ')']);
    const a = first('(( x = (1 + 2) * 3 ))');
    assert.equal(a.kind, 'arith');
    if (a.kind === 'arith') assert.equal(a.src, ' x = (1 + 2) * 3 ');
    assert.deepEqual(kinds('( (echo a) )'), ['subshell']);
    assert.deepEqual(kinds('echo $( (echo a) )'), ['simple']);
  });
  it('`[[ … ]]` glued to `;`, `&&`, `)` ends the conditional: every form bash 5 accepts parses clean (REGRESSION 25.09)', () => {
    assert.deepEqual(kinds('if [[ -f a.sql ]]; then echo y; fi; psql -c "SET statement_timeout = 0"'), ['if', 'simple']);
    assert.deepEqual(kinds('[[ -n $DB ]]&& psql -c "SET x = 1"'), ['cond', 'simple']);
    assert.deepEqual(kinds('( [[ x ]])&& echo in-subshell'), ['subshell', 'simple']);
    assert.deepEqual(kinds('[[ $x =~ ^(a|b)$ ]]; psql -c "SET x = 1"'), ['cond', 'simple']);
    for (const s of ['x=$([[ y ]]&&echo sub); echo $x', '[[ ab =~ a|b ]] && echo p', '[[ "a b" =~ (a b) ]]', '[[ (a == a) ]]', '[[ a<b ]]', 'while [[ $i -lt 3 ]]; do i=$((i+1)); done']) clean(s);
  });
  it('function: `f () {…}`, `function f {…}`, `function f () (…)`; the body must be a compound command', () => {
    for (const s of ['f () { a; }', 'function f { a; }', 'function f () ( a )', 'f()\n{\n a\n}']) {
      const c = first(s);
      assert.equal(c.kind, 'func', s);
      if (c.kind === 'func') assert.equal(c.name, 'f');
    }
    assert.deepEqual(errors('f () echo hi'), ['parse-error']);
  });
  it('zsh `=cmd` and `**` globs are plain words; `time` and `coproc` are words the model strips as prefixes', () => {
    assert.deepEqual(argv(first('=psql -c 1')), ['=psql', '-c', '1']);
    assert.deepEqual(argv(first('ls **/*.ts')), ['ls', '**/*.ts']);
    assert.deepEqual(argv(first('time psql -c 1')), ['time', 'psql', '-c', '1']);
  });
});

describe('parser — errors: position, remainder, no recovery, no exceptions', () => {
  it('a stray `)`, `fi` without `if`, `;;` outside case, a missing `then` — each is one parse-error with the remainder', () => {
    for (const [s, at] of [['echo a )', 7], ['fi', 0], ['a ;; b', 2], ['if a; b; fi', 9], ['a && ', 5]] as const) {
      const p = parse(s);
      assert.deepEqual(p.errors.map((e) => [e.kind, e.at, e.text]), [['parse-error', at, s.slice(at)]], s);
    }
  });
  it('keeps the tree parsed before the error', () => {
    const p = parse('psql -c "SET x" ; echo ) tail');
    assert.deepEqual(cmds(p.body).map((c) => argv(c)[0]), ['psql', 'echo']);
  });
  it('an unterminated substitution or quote is a lexer error, and the tree still holds the command', () => {
    assert.deepEqual(errors('echo $(date'), ['unterminated-substitution']);
    assert.deepEqual(argv(first("psql -c 'SET x")), ['psql', '-c', 'SET x']);
  });
  it('never throws on arbitrary input (seeded fuzz, 3000 strings over operators, quotes, keywords)', () => {
    let seed = 0x2545f491;
    const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 0xffffffff; };
    const atoms = [' ', '\n', ';', '&', '|', '(', ')', '{', '}', "'", '"', '\\', '$', '`', '<', '>', '#', '=', '-', 'a', 'X', '1', '/', 'if', 'then', 'fi', 'do', 'done', 'case', 'esac', 'in', '<<', 'EOF', '[[', ']]', '((', '))', '$(', '<(', '&&', '||', ';;', 'for', 'while', 'function', '!'];
    for (let n = 0; n < 3000; n++) {
      const len = Math.floor(rnd() * 24);
      let s = ''; for (let i = 0; i < len; i++) s += atoms[Math.floor(rnd() * atoms.length)];
      assert.doesNotThrow(() => parseShell(s), `seed-case ${n}: ${JSON.stringify(s)}`);
    }
  });
});

describe('parser — print/parse property', () => {
  const corpus = [
    'cd "$APP_ENGINE" && git commit -m "fix: a b" -F msg.txt; echo done',
    "psql <<SQL | tail -3\nSELECT 1;\nSQL",
    'run() { psql "$@"; }; run -c "SELECT 1"',
    `git commit -q -m "$(cat <<'EOF'\nfix: don't lose the (message\nEOF\n)" && npx jest --silent 2>&1 | tail -5`,
    'if [ -n "$2" ]; then shift; elif x; then y; else z; fi; psql "$@"',
    'for f in a b; do echo $f; done; for x; do :; done; for ((i=0;i<2;i++)); do echo; done',
    'case $x in (a|b) echo ab;; c) echo c;& *) echo other;;& esac',
    'a=(1 2 "$x") echo ${a[@]} $((1+2)) <(ls) >(cat) `date`',
    '[[ -f x && $y == z ]] && (( x += 1 )) || { echo no; exit 1; }',
    'psql -c "$X" > out 2>&1 &\nfunction q { psql -At "$@"; }\nq () ( psql )',
    "cmd <<'A' <<-B <<< here\nfirst\nA\n\tsecond\n\tB",
    'while read -r l; do echo "$l"; done < f | sort -u >| out',
    '! time psql -c 1 |& tee log',
    'select x in a b; do break; done',
    "echo $'a\\nb' $\"c\" 'd' \\$ \\\\",
  ];
  for (const s of corpus) {
    it(`parse(print(parse(x))) is the same tree: ${JSON.stringify(s.slice(0, 48))}`, () => {
      const one = clean(s);
      const printed = print(one);
      const two = parseShell(printed);
      assert.deepEqual(two.errors, [], printed);
      assert.deepEqual(shape(two.body), shape(one.body), printed);
    });
  }
  it('is linear on a 20 KB command with a here-doc: parses in well under a second', () => {
    const body = 'SELECT 1;\n'.repeat(2000);
    const s = `psql -d wms <<'SQL' && echo done\n${body}SQL`;
    const t0 = performance.now();
    const p = clean(s);
    const ms = performance.now() - t0;
    assert.ok(ms < 1000, `${ms.toFixed(1)} ms`);
    const c = cmds(p.body)[0];
    assert.equal(c.kind === 'simple' ? c.redirects[0].here?.body.length : -1, body.length);
  });
});
