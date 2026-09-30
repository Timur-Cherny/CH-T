// INVARIANT R10: правка контура (harness/**, hooks/**, settings.json) не проходит без прогона его набора, а прогон,
// исполнивший ноль тестов, зелёным не считается. Молча ломалось: у контура нет ни CI, ни pre-commit, ни хука
// на набор — 70 тестов краснели в main незамеченными.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { sandbox, payload, HARNESS_ROOT } from '../_env.ts';
import { applies, run, suiteGeneration, parseNodeTestSummary, NAME } from '../../src/checks/contour-suite.ts';
import { sweep } from '../../src/sweep.ts';
import { State } from '../../src/state.ts';
import type { ChangedFile, CheckContext } from '../../src/checks/types.ts';

const sb = sandbox('harness-contour-suite-');
after(() => sb.cleanup());

const PASSING = "import { it } from 'node:test';\nit('passes', () => {});\n";
const FAILING = "import { it } from 'node:test';\nimport assert from 'node:assert/strict';\nit('breaks on purpose', () => { assert.equal(1, 2); });\n";

function contourRepo(name: string, files: Record<string, string>): string {
  const root = join(sb.dir, name);
  const all: Record<string, string> = { 'harness/bin/hook': '#!/bin/sh\n', 'harness/src/main.ts': 'export {};\n', ...files };
  for (const [rel, text] of Object.entries(all)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}
// Процесс набора, запущенный самим contour-suite, несёт CLAUDE_SKIP_CONTOUR_SUITE=1: кейсы, где проверка обязана
// сработать, снимают этот выключатель на время кейса, иначе канал вечно краснел бы на собственных тестах.
async function withoutProcessKill<T>(fn: () => T | Promise<T>): Promise<T> {
  const prev = process.env.CLAUDE_SKIP_CONTOUR_SUITE;
  delete process.env.CLAUDE_SKIP_CONTOUR_SUITE;
  try { return await fn(); } finally { if (prev !== undefined) process.env.CLAUDE_SKIP_CONTOUR_SUITE = prev; }
}
const file = (repo: string, path: string, status: ChangedFile['status'] = 'M'): ChangedFile => ({ repo, path, absPath: join(repo, path), digest: '0', status });
const ctx = (stateDir: string): CheckContext => ({ env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: sb.home }, stateDir, now: Date.now, deadlineMs: Infinity });

describe('contour-suite applies', () => {
  it('fires on harness/**, hooks/**, settings.json and .claude/check.sh of a contour repo', async () => {
    const repo = contourRepo('applies', {});
    await withoutProcessKill(() => {
      for (const p of ['harness/src/x.ts', 'harness/test/a.test.ts', 'hooks/a.sh', 'hooks/spec/a.test.sh', 'settings.json', '.claude/check.sh']) assert.equal(applies(file(repo, p)), true, p);
    });
  });
  it('fires on portable/** and bin/brain — the Codex adapter and its launcher belong to the contour', async () => {
    const repo = contourRepo('applies-portable', {});
    await withoutProcessKill(() => {
      for (const p of ['portable/codex.ts', 'portable/test_brain.py', 'bin/brain']) assert.equal(applies(file(repo, p)), true, p);
    });
    assert.equal(applies(file(repo, 'bin/other-tool')), false);
  });
  it('stays out of other paths, deleted files and repositories without the harness entry point', () => {
    const repo = contourRepo('applies-no', {});
    for (const p of ['README.md', 'skills/x/SKILL.md', 'harness-notes.md', 'memory/a.md']) assert.equal(applies(file(repo, p)), false, p);
    assert.equal(applies(file(repo, 'harness/src/x.ts', 'D')), false);
    const plain = join(sb.dir, 'plain');
    mkdirSync(join(plain, 'harness', 'src'), { recursive: true });
    assert.equal(applies(file(plain, 'harness/src/x.ts')), false, 'без harness/bin/hook репозиторий — не контур');
  });
  it('stays out inside a suite run it started — the runner process carries its own kill switch, so no job recursion', () => {
    const repo = contourRepo('nested', {});
    const prev = process.env.CLAUDE_SKIP_CONTOUR_SUITE;
    process.env.CLAUDE_SKIP_CONTOUR_SUITE = '1';
    try { assert.equal(applies(file(repo, 'harness/src/x.ts')), false); }
    finally { if (prev === undefined) delete process.env.CLAUDE_SKIP_CONTOUR_SUITE; else process.env.CLAUDE_SKIP_CONTOUR_SUITE = prev; }
  });
});

describe('contour-suite run', () => {
  it('passes a green suite and does not re-run the same generation', async () => {
    const repo = contourRepo('green', { 'harness/test/ok.test.ts': PASSING });
    const st = join(sb.dir, 'st-green');
    assert.deepEqual(await run(file(repo, 'harness/src/main.ts'), ctx(st)), { verdict: 'pass', generation: suiteGeneration(repo) });
    const [cf] = readdirSync(join(st, NAME)).filter((n) => n.endsWith('.json'));
    const before = readFileSync(join(st, NAME, cf), 'utf8');
    assert.deepEqual(await run(file(repo, 'harness/src/main.ts'), ctx(st)), { verdict: 'pass', generation: suiteGeneration(repo) });
    assert.equal(readFileSync(join(st, NAME, cf), 'utf8'), before, 'то же поколение прогнано повторно');
  });
  it('re-runs when the generation moves and names the failing test', async () => {
    const repo = contourRepo('red', { 'harness/test/ok.test.ts': PASSING });
    const st = join(sb.dir, 'st-red');
    const g1 = suiteGeneration(repo);
    assert.equal((await run(file(repo, 'harness/test/ok.test.ts'), ctx(st))).verdict, 'pass');
    writeFileSync(join(repo, 'harness/test/bad.test.ts'), FAILING);
    assert.notEqual(suiteGeneration(repo), g1);
    const r = await run(file(repo, 'harness/test/bad.test.ts'), ctx(st));
    assert.equal(r.verdict, 'fail');
    assert.match(r.message ?? '', /харнесс: красные 1 из 2: breaks on purpose/);
  });
  it('runs the portable node tests too — a red Codex adapter test fails the contour', async () => {
    const repo = contourRepo('portable-node', { 'harness/test/ok.test.ts': PASSING, 'portable/adapter.test.ts': FAILING });
    const r = await run(file(repo, 'portable/adapter.test.ts'), ctx(join(sb.dir, 'st-portable-node')));
    assert.equal(r.verdict, 'fail', 'Miss this and an adapter change ships with its own tests red');
    assert.match(r.message ?? '', /breaks on purpose/);
  });
  it('runs the portable python tests too — a red launcher test fails the contour', async () => {
    const failing = 'import unittest\n\nclass T(unittest.TestCase):\n    def test_breaks_on_purpose(self):\n        self.assertEqual(1, 2)\n';
    const repo = contourRepo('portable-py', { 'harness/test/ok.test.ts': PASSING, 'portable/test_launcher.py': failing });
    const r = await run(file(repo, 'portable/test_launcher.py'), ctx(join(sb.dir, 'st-portable-py')));
    assert.equal(r.verdict, 'fail');
    assert.match(r.message ?? '', /test_breaks_on_purpose/);
  });
  it('moves the suite generation when the adapter or the launcher changes', () => {
    const repo = contourRepo('gen-portable', { 'harness/test/ok.test.ts': PASSING, 'portable/codex.ts': 'export {};\n', 'bin/brain': '#!/usr/bin/env python3\n' });
    const g1 = suiteGeneration(repo);
    writeFileSync(join(repo, 'portable/codex.ts'), 'export const x = 1;\n');
    const g2 = suiteGeneration(repo);
    assert.notEqual(g2, g1, 'Miss this and a cached green verdict outlives an adapter change');
    writeFileSync(join(repo, 'bin/brain'), '#!/usr/bin/env python3\nprint(1)\n');
    assert.notEqual(suiteGeneration(repo), g2);
  });
  it('fails a run that executed zero tests — an empty suite is not green', async () => {
    const repo = contourRepo('empty', { 'harness/test/README.md': 'no tests\n' });
    const r = await run(file(repo, 'harness/src/main.ts'), ctx(join(sb.dir, 'st-empty')));
    assert.equal(r.verdict, 'fail');
    assert.match(r.message ?? '', /исполнил 0 тестов/);
  });
  // Решение 16.09: замороженные bash-спеки отключены — хуки портированы, а спеки держат macOS-семантику mktemp -t.
  it('does not run hooks/spec any more: a broken frozen spec no longer fails the contour', async () => {
    const repo = contourRepo('spec', { 'harness/test/ok.test.ts': PASSING, 'hooks/spec/broken.test.sh': 'exit 3\n', 'hooks/spec/fine.test.sh': 'exit 0\n' });
    const r = await run(file(repo, 'hooks/spec/broken.test.sh'), ctx(join(sb.dir, 'st-spec')));
    assert.equal(r.verdict, 'pass', JSON.stringify(r));
  });
});

describe('parseNodeTestSummary', () => {
  it('reads the counters and the failing names of the spec reporter', () => {
    const s = parseNodeTestSummary('✖ breaks (1.2ms)\nℹ tests 3\nℹ pass 2\nℹ fail 1\n✖ breaks (1.2ms)\n');
    assert.deepEqual(s, { tests: 3, fail: 1, failed: ['breaks'] });
  });
  it('yields NaN counters when the runner printed no summary — the caller must not read that as zero failures', () => {
    const s = parseNodeTestSummary('Could not find "harness/test/**/*.test.ts"\n');
    assert.ok(Number.isNaN(s.tests) && Number.isNaN(s.fail));
  });
});

describe('contour-suite channel', () => {
  it('a change under harness/** of a contour repo queues a contour-suite job on the sweep', async () => {
    const sb2 = sandbox('harness-contour-sweep-');
    try {
      const repo = contourRepo('channel', { 'harness/test/ok.test.ts': PASSING, 'README.md': 'x\n' });
      const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: sb2.home, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
      const git = (...args: string[]): void => { execFileSync('git', args, { cwd: repo, env: gitEnv }); };
      git('init', '-q'); git('add', '.'); git('commit', '-qm', 'base');
      writeFileSync(join(repo, 'harness/src/main.ts'), 'export const changed = 1;\n');
      const env = { HOME: sb2.home, CLAUDE_STATE_DIR: sb2.stateDir, HARNESS_ROOT, PATH: process.env.PATH ?? '/usr/bin:/bin' };
      const st = State.open(sb2.stateDir);
      const c = { event: 'post' as const, payload: payload('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'x' }, tool_use_id: 't1' }, repo) as never, env, root: HARNESS_ROOT, stateDir: sb2.stateDir, now: Date.now };
      const out = await withoutProcessKill(() => sweep(c, st, { spawnWorker: false, checkerFilter: (n) => n === NAME }));
      st.close();
      assert.equal(out.pending, 1, 'правка harness/** не поставила прогон набора контура');
    } finally { sb2.cleanup(); }
  });
});
