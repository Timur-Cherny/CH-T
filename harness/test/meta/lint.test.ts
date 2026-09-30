// INVARIANT К2/К3/К5: контур не зависит от bash-семантики и платформенных команд. Мета-тест держит форму:
// strip-only синтаксис TypeScript (enum/namespace/parameter properties не стрипаются Node 24 — упадут на боевом событии),
// запрещённые API вне объявленных точек, импорты с расширением .ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { HARNESS_ROOT } from '../_env.ts';

function walk(d: string): string[] { return readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []; }); }
const SRC = [...walk(join(HARNESS_ROOT, 'src')), ...walk(join(HARNESS_ROOT, 'scripts'))];
const rel = (p: string) => relative(HARNESS_ROOT, p);

const GIT_ENV = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
// What a diff can show under root: tracked files and untracked ones the repo does not ignore. An ignored Finder .DS_Store never reaches review.
// Outside a work tree (a fresh public export checked by `export.ts --test`) there is nothing to ignore: every file is listed.
function diffable(root: string): string[] {
  let inside = true;
  try { execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, stdio: 'ignore', env: GIT_ENV }); } catch { inside = false; }
  if (!inside) {
    const all = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); const st = lstatSync(p); return st.isDirectory() ? all(p) : st.isFile() ? [p] : []; });
    return all(root);
  }
  const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', env: GIT_ENV }).split('\0').filter(Boolean);
  return [...new Set(listed)].map((p) => join(root, p)).filter((p) => existsSync(p) && lstatSync(p).isFile());
}

// Единственные точки прямого запуска процессов: platform.spawnTool (allowlist), sweep.spawnWorker (detached),
// session/git-freshness (detached fetch — объявленное исключение).
const CHILD_PROCESS_ALLOW = new Set(['src/platform.ts', 'src/sweep.ts', 'src/session/git-freshness.ts']);
const FORBIDDEN: Array<[RegExp, string, Set<string>]> = [
  [/\bos\.freemem\b/, 'os.freemem — на macOS показывает свободные страницы, не доступную память', new Set()],
  [/\bvm_stat\b|\bsysctl\b|\bstat -f\b|\bdate -j\b/, 'платформенная команда вне platform.ts', new Set(['src/platform.ts'])],
  [/(^|[^A-Za-z])jq\s+['"-]|python3 -c|\bperl\b|\bshasum\b/, 'jq/python3 -c/perl/shasum — К5', new Set()],
  [/from 'node:child_process'|require\('child_process'\)/, 'child_process вне объявленных точек', CHILD_PROCESS_ALLOW],
  [/\bexecSync\(|\bexecFileSync\(|\bspawnSync\(/, 'execSync/execFileSync/spawnSync — только spawnTool', new Set(['src/platform.ts'])],
  [/^\s*enum\s+\w+|^\s*namespace\s+\w+|constructor\((public|private|protected|readonly)\s/m, 'синтаксис, который Node 24 не стрипает', new Set()],
  [/from '\.[^']*(?<!\.ts)'/, 'относительный импорт без расширения .ts', new Set()],
  [/import\.meta\.url\)*\s*===|===\s*(?:realpathSync\()?process\.argv\[1\]|file:\/\/\$\{process\.argv\[1\]\}/, 'сравнение import.meta.url с argv[1] по месту — только isMainModule: через симлинк ~/.claude/harness копия молча пропускает main()', new Set(['src/is-main.ts'])],
  [/\.CLAUDE_STATE_DIR|\[['"]CLAUDE_STATE_DIR['"]\]/, 'чтение CLAUDE_STATE_DIR вне state.resolveStateDir — второй резолвер разведёт состояние по каталогам', new Set(['src/state.ts'])],
];

describe('lint', () => {
  it('every src/scripts module survives stripTypeScriptTypes in strip mode — no enum, namespace or parameter properties', () => {
    for (const f of SRC) assert.doesNotThrow(() => stripTypeScriptTypes(readFileSync(f, 'utf8'), { mode: 'strip' }), rel(f));
  });
  for (const [re, why, allow] of FORBIDDEN) {
    it(`forbids ${why}`, () => {
      const hits = SRC.filter((f) => !allow.has(rel(f))).filter((f) => re.test(readFileSync(f, 'utf8').replace(/\/\/[^\n]*/g, ''))).map(rel);
      assert.deepEqual(hits, [], why);
    });
  }
  it('keeps every text file free of raw control bytes: git calls such a file binary and hides its diff from review', () => {
    const text = (p: string): boolean => !/\.(wasm|png|jpe?g|gz|tgz)$/.test(p) && !p.split('/').includes('node_modules');
    const files = diffable(HARNESS_ROOT).map(rel).filter(text);
    assert.ok(files.includes('test/meta/lint.test.ts'), 'the listing lacks this very file — the check would pass on nothing');
    const hits = files.filter((f) => /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(readFileSync(join(HARNESS_ROOT, f), 'latin1')));
    assert.deepEqual(hits, [], 'REGRESSION 25.09: a raw NUL in src/gates/data-boundary.ts made three commits of the gate diff as binary');
  });
  it('scans what a diff can show — tracked and untracked files under the root — and skips ignored ones such as a Finder .DS_Store', () => {
    const repo = mkdtempSync(join(tmpdir(), 'lint-diffable-'));
    try {
      const root = join(repo, 'harness');
      const put = (p: string, body: string): void => writeFileSync(join(repo, p), body);
      mkdirSync(root);
      put('.gitignore', '**/.DS_Store\n');
      put('outside.ts', '\0');
      put('harness/tracked.ts', 't');
      put('harness/gone.ts', 'g');
      execFileSync('git', ['init', '-q'], { cwd: repo, env: GIT_ENV, stdio: 'ignore' });
      execFileSync('git', ['add', '.'], { cwd: repo, env: GIT_ENV, stdio: 'ignore' });
      unlinkSync(join(root, 'gone.ts'));
      put('harness/untracked.ts', '\0');
      put('harness/.DS_Store', '\0');
      assert.deepEqual(diffable(root).map((p) => relative(root, p)).sort(), ['tracked.ts', 'untracked.ts'],
        'REGRESSION 26.09: the disk walk counted an ignored .DS_Store, turned the suite red on every checkout Finder had opened and blocked Stop there');
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
  it('lists every file of a tree outside git — a fresh public export has no repo, and the scan must not fail there', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'lint-nogit-'));
    try {
      let inside = true;
      try { execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, stdio: 'ignore', env: GIT_ENV }); } catch { inside = false; }
      if (inside) { t.skip('tmpdir лежит внутри git-дерева'); return; }
      mkdirSync(join(dir, 'src'));
      writeFileSync(join(dir, 'src', 'a.ts'), 'a');
      writeFileSync(join(dir, 'b.md'), 'b');
      assert.deepEqual(diffable(dir).map((p) => relative(dir, p)).sort(), ['b.md', 'src/a.ts'],
        'REGRESSION 29.09: git ls-files outside a repo threw, and `export.ts --test` stayed red on the one tree it exists to check');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('has no direct git invocation outside src/git.ts and the declared fetch exception', () => {
    const hits = SRC.filter((f) => !new Set(['src/git.ts', 'src/session/git-freshness.ts']).has(rel(f))).filter((f) => /spawnTool\(\s*'git'/.test(readFileSync(f, 'utf8'))).map(rel);
    assert.deepEqual(hits, []);
  });
});
