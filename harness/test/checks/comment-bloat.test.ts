// Порт hooks/comment-bloat-check.sh: правило «комментарии по делу» держалось на памяти модели и не держалось.
// INVARIANT: оцениваются только ДОБАВЛЕННЫЕ строки; шапка файла (первые 15 строк) не считается блоком;
// комментарии определяются по AST TypeScript, а не по началу строки — regex-литерал `/\/\/ x/` комментарием не является.
// REGRESSION: история правки внутри хвостового `// …` после кода тоже ловится (текстовый хук её не видел).
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from '../_env.ts';
import { initRepo, changed, ctx, TS_PATH } from './_repo.ts';
import { checker } from '../../src/checks/comment-bloat.ts';
import { CHECKERS } from '../../src/checks/registry.ts';

const header = Array.from({ length: 16 }, (_, i) => `// header line ${i + 1}`).join('\n');
const BASE = `${header}\nexport function a(): number {\n  return 1;\n}\n`;
const comments = (n: number, word = 'note') => Array.from({ length: n }, (_, i) => `  // ${word} ${i + 1}`).join('\n');

describe('comment-bloat checker', () => {
  const sb = sandbox();
  after(() => sb.cleanup());

  it('registers as sync with the bash kill-switch name and skips prose/data files and deleted files', () => {
    assert.ok(CHECKERS.some((c) => c.name === 'comment-bloat'));
    assert.equal(checker.tier, 'sync');
    assert.equal(checker.killSwitch, 'CLAUDE_SKIP_COMMENT_CHECK');
    const f = { repo: '/r', path: 'a.ts', absPath: '/r/a.ts', digest: '0', status: 'M' } as const;
    for (const p of ['a.ts', 'a.tsx', 'a.js', 'a.mjs', 'a.cjs', 'a.jsx']) assert.equal(checker.applies({ ...f, path: p, absPath: `/r/${p}` }), true, p);
    for (const p of ['a.md', 'a.json', 'a.lock', 'a.snap', 'a.txt', 'a.sh', 'a.py']) assert.equal(checker.applies({ ...f, path: p, absPath: `/r/${p}` }), false, p);
    assert.equal(checker.applies({ ...f, status: 'D' }), false);
  });

  it('fails on an added contiguous comment block longer than 5 lines outside the header and names its line range', async () => {
    const repo = initRepo(sb, 'r-block');
    repo.write('a.ts', BASE); repo.commitAll();
    repo.write('a.ts', BASE.replace('  return 1;', `${comments(6)}\n  return 1;`));
    const r = await checker.run(changed(repo, 'a.ts'), ctx(sb));
    assert.equal(r.verdict, 'fail');
    assert.match(r.message ?? '', /строки 18-23: сплошной комментарий на 6 строк/);
  });

  it('reads a star-led continuation of an expression as code and still flags a real block comment below the header (INC-COMMENT-CHECK-STAR-LINES)', async () => {
    const repo = initRepo(sb, 'r-star');
    const base = BASE.replace('export function a(): number {', 'export function a(x: number): number {');
    repo.write('a.ts', base); repo.commitAll();
    const star = Array.from({ length: 7 }, (_, i) => `    * ${i + 2}`).join('\n');
    repo.write('a.ts', base.replace('  return 1;', `  return x\n${star};`));
    const code = await checker.run(changed(repo, 'a.ts'), ctx(sb));
    assert.equal(code.verdict, 'pass', code.message);
    const block = ['  /*', ...Array.from({ length: 6 }, (_, i) => `   * note ${i}`), '   */'].join('\n');
    repo.write('a.ts', base.replace('  return 1;', `${block}\n  return 1;`));
    assert.equal((await checker.run(changed(repo, 'a.ts'), ctx(sb))).verdict, 'fail');
  });

  it('passes a block of exactly 5 lines — the threshold is strict', async () => {
    const repo = initRepo(sb, 'r-five');
    repo.write('a.ts', BASE); repo.commitAll();
    repo.write('a.ts', BASE.replace('export function a()', `${comments(5)}\nexport function a()`));
    assert.equal((await checker.run(changed(repo, 'a.ts'), ctx(sb))).verdict, 'pass');
  });

  it('passes a long block that starts inside the header — the module contract is a legitimate genre', async () => {
    const repo = initRepo(sb, 'r-header');
    repo.write('a.ts', 'export const x = 1;\n'); repo.commitAll();
    repo.write('a.ts', `${Array.from({ length: 9 }, (_, i) => `// contract ${i}`).join('\n')}\nexport const x = 1;\n`);
    assert.equal((await checker.run(changed(repo, 'a.ts'), ctx(sb))).verdict, 'pass');
  });

  it('honours COMMENT_MAX_BLOCK and COMMENT_HEADER_LINES from the environment', async () => {
    const repo = initRepo(sb, 'r-env');
    repo.write('a.ts', BASE); repo.commitAll();
    repo.write('a.ts', BASE.replace('export function a()', `${comments(3)}\nexport function a()`));
    const strict = await checker.run(changed(repo, 'a.ts'), ctx(sb, { CLAUDE_HARNESS_TS: TS_PATH, COMMENT_MAX_BLOCK: '2' }));
    assert.equal(strict.verdict, 'fail');
    assert.match(strict.message ?? '', /порог 2/);
    const wideHeader = await checker.run(changed(repo, 'a.ts'), ctx(sb, { CLAUDE_HARNESS_TS: TS_PATH, COMMENT_MAX_BLOCK: '2', COMMENT_HEADER_LINES: '40' }));
    assert.equal(wideHeader.verdict, 'pass');
  });

  it('fails when added comments outnumber added code two to one on a change of at least 4 code lines', async () => {
    const repo = initRepo(sb, 'r-ratio');
    repo.write('a.ts', BASE); repo.commitAll();
    const body = ['  const a = 1;', comments(4, 'a'), '  const b = 2;', comments(4, 'b'), '  const c = 3;', '  return a + b + c;'].join('\n');
    repo.write('a.ts', BASE.replace('  return 1;', body));
    const r = await checker.run(changed(repo, 'a.ts'), ctx(sb));
    assert.equal(r.verdict, 'fail');
    assert.match(r.message ?? '', /в правке 8 строк комментариев на 4 строк кода/);
  });

  it('passes the same ratio on a tiny top-level change — fewer than 4 code lines is not a signal', async () => {
    const repo = initRepo(sb, 'r-tiny');
    repo.write('a.ts', BASE); repo.commitAll();
    repo.write('a.ts', BASE.replace('export function a()', [comments(4, 'a'), 'const z = 1;', comments(4, 'b'), 'export const w = z;', 'export function a()'].join('\n')));
    assert.equal((await checker.run(changed(repo, 'a.ts'), ctx(sb))).verdict, 'pass');
  });

  it('fails on a single comment inside a function body — the limit is zero, the name carries the meaning', async () => {
    const own = initRepo(sb, 'r-body-own-line');
    own.write('a.ts', BASE); own.commitAll();
    own.write('a.ts', BASE.replace('  return 1;', ['  // инвариант: ноль здесь невозможен, см. контракт', '  return 1;'].join('\n')));
    const v = await checker.run(changed(own, 'a.ts'), ctx(sb));
    assert.equal(v.verdict, 'fail', JSON.stringify(v));
    assert.match(v.message ?? '', /функция a \(строки 17-20\): комментарий внутри тела на строке 18/);
    const tail = initRepo(sb, 'r-body-trailing');
    tail.write('a.ts', BASE); tail.commitAll();
    tail.write('a.ts', BASE.replace('  return 1;', '  return 1; // единица'));
    assert.match((await checker.run(changed(tail, 'a.ts'), ctx(sb))).message ?? '', /функция a \(строки 17-19\): комментарий внутри тела на строке 18/);
    const inline = initRepo(sb, 'r-body-inline');
    inline.write('a.ts', BASE); inline.commitAll();
    inline.write('a.ts', `${BASE}export const b = (): number => { /* единица */ return 1; };\n`);
    assert.match((await checker.run(changed(inline, 'a.ts'), ctx(sb))).message ?? '', /функция b \(строки 20-20\): комментарий внутри тела на строке 20/);
    const edges = initRepo(sb, 'r-body-edges');
    edges.write('a.ts', BASE); edges.commitAll();
    edges.write('a.ts', `${BASE.replace('export function a(): number {', 'export function a(): number { // единица')}export const c = (): number => // единица\n  1;\n`);
    const e = (await checker.run(changed(edges, 'a.ts'), ctx(sb))).message ?? '';
    assert.match(e, /функция a \(строки 17-19\): комментарий внутри тела на строке 17/);
    assert.match(e, /функция c \(строки 20-21\): комментарий внутри тела на строке 20/);
  });

  it('passes comments above a function, above a class method and above a function nested in a body', async () => {
    const repo = initRepo(sb, 'r-above');
    repo.write('a.ts', BASE); repo.commitAll();
    repo.write('a.ts', BASE.replace('export function a(): number {\n  return 1;\n}', [
      '/** Единица — нейтральный множитель. */',
      'export function a(): number {',
      '  /** Удваивает. */',
      '  const twice = (x: number): number => x * 2;',
      '  return twice(1) / 2;',
      '}',
      '// Счётчик без состояния вне экземпляра.',
      'export class Counter {',
      '  /** Следующее значение. */',
      '  next(): number { return a(); }',
      '}',
    ].join('\n')));
    const v = await checker.run(changed(repo, 'a.ts'), ctx(sb));
    assert.equal(v.verdict, 'pass', v.message);
  });

  it('fails on comments inside describe and it callbacks — a test names its purpose in describe/it', async () => {
    const repo = initRepo(sb, 'r-callback');
    repo.write('a.ts', BASE); repo.commitAll();
    repo.write('a.ts', `${BASE}describe('x', () => {\n  // первый случай\n  it('a', () => a());\n  it('b', () => {\n    a(); // второй случай\n  });\n});\n`);
    const v = await checker.run(changed(repo, 'a.ts'), ctx(sb));
    assert.equal(v.verdict, 'fail', JSON.stringify(v));
    assert.match(v.message ?? '', /колбэк describe\('x'\) \(строки 20-26\): комментарий внутри тела на строке 21/);
    assert.match(v.message ?? '', /колбэк it\('b'\) \(строки 23-25\): комментарий внутри тела на строке 24/);
  });

  it('reports a comment of a nested function once, under the innermost function', async () => {
    const repo = initRepo(sb, 'r-nested');
    repo.write('a.ts', BASE); repo.commitAll();
    repo.write('a.ts', BASE.replace('  return 1;', ['  const inner = (): number => {', '    return 1; // единица', '  };', '  return inner();'].join('\n')));
    const v = await checker.run(changed(repo, 'a.ts'), ctx(sb));
    assert.equal(v.verdict, 'fail', JSON.stringify(v));
    assert.match(v.message ?? '', /функция inner \(строки 18-20\): комментарий внутри тела на строке 19/);
    assert.doesNotMatch(v.message ?? '', /функция a \(/);
  });

  it('does not count tool directives inside a body — @ts-expect-error and eslint-disable-next-line pass', async () => {
    const repo = initRepo(sb, 'r-directives');
    repo.write('a.ts', BASE); repo.commitAll();
    repo.write('a.ts', BASE.replace('  return 1;', ['  // @ts-expect-error: проверка рантайма', '  const n: number = \'1\';', '  // eslint-disable-next-line no-console', '  console.log(n);', '  return 1;'].join('\n')));
    const v = await checker.run(changed(repo, 'a.ts'), ctx(sb));
    assert.equal(v.verdict, 'pass', v.message);
  });

  it('judges only added lines: an old comment in a body survives an edit of the neighbouring line', async () => {
    const repo = initRepo(sb, 'r-body-old');
    const base = BASE.replace('  return 1;', '  // единица\n  return 1;');
    repo.write('a.ts', base); repo.commitAll();
    repo.write('a.ts', base.replace('return 1', 'return 2'));
    const v = await checker.run(changed(repo, 'a.ts'), ctx(sb));
    assert.equal(v.verdict, 'pass', v.message);
  });

  it('fails on a comment inside a parameter list, including one on its own line before the closing paren', async () => {
    const repo = initRepo(sb, 'r-params');
    repo.write('a.ts', BASE); repo.commitAll();
    repo.write('a.ts', BASE.replace('export function a(): number {', ['export function a(', '  count: number, // сколько строк', '  name: string,', '  // имя файла', '): number {'].join('\n')));
    const v = await checker.run(changed(repo, 'a.ts'), ctx(sb));
    assert.equal(v.verdict, 'fail', JSON.stringify(v));
    assert.match(v.message ?? '', /функция a: комментарий внутри списка параметров на строках 18, 20/);
  });

  it('fails on a SQL comment inside a query literal, and passes a CLI flag string that merely starts with --', async () => {
    const repo = initRepo(sb, 'r-sql');
    repo.write('a.ts', BASE); repo.commitAll();
    repo.write('a.ts', `${BASE}export const q = \`\n  SELECT id\n  -- только живые\n  FROM orders WHERE deleted_at IS NULL\`;\nexport const args = ['--json', '--top', '5'];\n`);
    const v = await checker.run(changed(repo, 'a.ts'), ctx(sb));
    assert.equal(v.verdict, 'fail', JSON.stringify(v)); assert.match(v.message ?? '', /комментарий внутри SQL/);
    assert.doesNotMatch(v.message ?? '', /--json/);
    const ok = initRepo(sb, 'r-sql-ok');
    ok.write('a.ts', BASE); ok.commitAll();
    ok.write('a.ts', `${BASE}export const q = 'SELECT id FROM orders WHERE deleted_at IS NULL';\nexport const args = ['--json'];\n`);
    assert.equal((await checker.run(changed(ok, 'a.ts'), ctx(sb))).verdict, 'pass');
  });

  it('fails on edit history inside added comments — a date, «раньше», a commit hash — with the line number', async () => {
    const repo = initRepo(sb, 'r-history');
    repo.write('a.ts', BASE); repo.commitAll();
    repo.write('a.ts', BASE.replace('  return 1;', '  // fixed 27.07.2026 after incident\n  // раньше возвращали ноль\n  return 1; // see commit deadbeef1'));
    const r = await checker.run(changed(repo, 'a.ts'), ctx(sb));
    assert.equal(r.verdict, 'fail');
    assert.match(r.message ?? '', /строка 18: «27\.07\.2026»/);
    assert.match(r.message ?? '', /строка 19: «раньше»/);
    assert.match(r.message ?? '', /строка 20: «commit deadbeef1»/);
  });

  it('ignores history words in string literals and in a regex literal that looks like a comment', async () => {
    const repo = initRepo(sb, 'r-literals');
    repo.write('a.ts', BASE); repo.commitAll();
    repo.write('a.ts', BASE.replace('  return 1;', "  const s = 'раньше было 27.07.2026';\n  const re = /\\/\\/ раньше/;\n  return s.length + re.source.length;"));
    const r = await checker.run(changed(repo, 'a.ts'), ctx(sb));
    assert.equal(r.verdict, 'pass', r.message);
  });

  it('ignores old comments with history words — only added lines are judged', async () => {
    const repo = initRepo(sb, 'r-old');
    const base = BASE.replace('  return 1;', '  // раньше было иначе, 01.01.2020\n  return 1;');
    repo.write('a.ts', base); repo.commitAll();
    repo.write('a.ts', base.replace('return 1', 'return 2'));
    assert.equal((await checker.run(changed(repo, 'a.ts'), ctx(sb))).verdict, 'pass');
  });

  it('treats an untracked file as all-added — a fresh file with a 6-line block after the header fails', async () => {
    const repo = initRepo(sb, 'r-new');
    repo.write('base.ts', 'export const x = 1;\n'); repo.commitAll();
    repo.write('fresh.ts', BASE.replace('  return 1;', `${comments(6)}\n  return 1;`));
    const r = await checker.run(changed(repo, 'fresh.ts', '?'), ctx(sb));
    assert.equal(r.verdict, 'fail');
  });

  it('answers unknown without typescript and unknown outside git — never a silent pass', async () => {
    const repo = initRepo(sb, 'r-unknown');
    repo.write('a.ts', BASE); repo.commitAll();
    repo.write('a.ts', BASE.replace('  return 1;', `${comments(6)}\n  return 1;`));
    const noTs = await checker.run(changed(repo, 'a.ts'), ctx(sb, {}));
    assert.equal(noTs.verdict, 'unknown');
    assert.match(noTs.missing_reason ?? '', /typescript/i);
    const dir = join(sb.dir, 'nogit'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'b.ts'), BASE);
    const noGit = await checker.run({ repo: dir, path: 'b.ts', absPath: join(dir, 'b.ts'), digest: '0', status: 'M' }, ctx(sb));
    assert.equal(noGit.verdict, 'unknown');
  });
});
