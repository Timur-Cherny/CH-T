// INVARIANT: a contour-suite verdict belongs to the tree generation it ran on, not to the digest of one file. A pass for
// the current generation settles every applicable file of that tree, a new generation unsettles all of them, and
// runs waiting on the lock take the verdict of the CURRENT generation instead of re-running the suite.
// REGRESSION 24.09: the red-first test file kept its 3-of-1439 red after the fix while the suite was 1440/1440, and
// twelve harness edits queued twelve serialized suite runs whose waiters hit the 10-minute timeout.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { sandbox, payload, HARNESS_ROOT } from '../_env.ts';
import { run, suiteGeneration, NAME } from '../../src/checks/contour-suite.ts';
import { sweep } from '../../src/sweep.ts';
import { runJob } from '../../src/jobs/worker.ts';
import { State } from '../../src/state.ts';
import type { ChangedFile, CheckContext } from '../../src/checks/types.ts';

const sb = sandbox('harness-contour-gen-');
after(() => sb.cleanup());

function contourRepo(name: string, files: Record<string, string>): string {
  const root = join(sb.dir, name);
  const all: Record<string, string> = { 'harness/bin/hook': '#!/bin/sh\n', 'harness/src/main.ts': 'export {};\n', ...files };
  for (const [rel, text] of Object.entries(all)) { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); }
  return root;
}
async function withoutProcessKill<T>(fn: () => T | Promise<T>): Promise<T> {
  const prev = process.env.CLAUDE_SKIP_CONTOUR_SUITE;
  delete process.env.CLAUDE_SKIP_CONTOUR_SUITE;
  try { return await fn(); } finally { if (prev !== undefined) process.env.CLAUDE_SKIP_CONTOUR_SUITE = prev; }
}

describe('contour-suite verdict per tree generation', () => {
  it('turns the verdict of an unchanged red-first test file green once the code under test is fixed', async () => {
    const dir = contourRepo('tdd', { 'README.md': 'x\n', 'harness/test/.keep': '' });
    const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: sb.home, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, env: gitEnv, encoding: 'utf8' });
    git('init', '-q'); git('add', '.'); git('commit', '-qm', 'base');
    const repo = git('rev-parse', '--show-toplevel').trim();
    writeFileSync(join(repo, 'harness/src/lib.ts'), 'export const two = 1;\n');
    writeFileSync(join(repo, 'harness/test/lib.test.ts'), "import { it } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { two } from '../src/lib.ts';\nit('two is two', () => { assert.equal(two, 2); });\n");
    const env = { HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, HARNESS_ROOT, PATH: process.env.PATH ?? '/usr/bin:/bin' };
    let n = 0;
    const sweepAndRun = async (): Promise<void> => {
      const st = State.open(sb.stateDir);
      try {
        const c = { event: 'post' as const, payload: payload('PostToolUse', { session_id: 's-tdd', tool_name: 'Bash', tool_input: { command: 'x' }, tool_use_id: `t${++n}` }, repo) as never, env, root: HARNESS_ROOT, stateDir: sb.stateDir, now: Date.now };
        await sweep(c, st, { spawnWorker: false, checkerFilter: (name) => name === NAME });
        const jobs = st.db.prepare("SELECT job_id FROM jobs WHERE repo = ? AND status = 'claimed'").all(repo) as Array<{ job_id: string }>;
        for (const j of jobs) await runJob(st, j.job_id, env, HARNESS_ROOT);
      } finally { st.close(); }
    };
    const verdictOf = (path: string): string | undefined => {
      const st = State.open(sb.stateDir);
      try { return (st.db.prepare('SELECT verdict FROM verified WHERE repo = ? AND path = ? AND checker = ?').get(repo, path, NAME) as { verdict: string } | undefined)?.verdict; }
      finally { st.close(); }
    };
    await withoutProcessKill(sweepAndRun);
    assert.equal(verdictOf('harness/test/lib.test.ts'), 'fail', 'the red-first run did not record the red');
    writeFileSync(join(repo, 'harness/src/lib.ts'), 'export const two = 2;\n');
    await withoutProcessKill(sweepAndRun);
    assert.equal(verdictOf('harness/src/lib.ts'), 'pass');
    assert.equal(verdictOf('harness/test/lib.test.ts'), 'pass', 'the unchanged test file kept the red of a tree that no longer exists');
  });

  it('runs the suite once for three runs queued at three tree states behind a held lock, and caches what it ran', async () => {
    const counter = join(sb.dir, 'executions.log');
    const repo = contourRepo('pile', { 'harness/test/count.test.ts': "import { it } from 'node:test';\nimport { appendFileSync } from 'node:fs';\nappendFileSync(process.env.SUITE_COUNTER ?? '/dev/null', 'run\\n');\nit('passes', () => {});\n" });
    const stateDir = join(sb.dir, 'st-pile');
    const ctx: CheckContext = { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: sb.home, SUITE_COUNTER: counter }, stateDir, now: Date.now, deadlineMs: Infinity };
    const file: ChangedFile = { repo, path: 'harness/src/a.ts', absPath: join(repo, 'harness/src/a.ts'), digest: '0', status: 'M' };
    const cache = join(stateDir, NAME, `${createHash('sha256').update(repo).digest('hex').slice(0, 16)}.json`);
    mkdirSync(`${cache}.lock`, { recursive: true });
    const runs = [];
    for (const v of ['v1', 'v2', 'v3']) { writeFileSync(join(repo, 'harness/src/a.ts'), `export const v = '${v}';\n`); runs.push(run(file, ctx)); }
    const last = suiteGeneration(repo);
    rmdirSync(`${cache}.lock`);
    const results = await Promise.all(runs);
    const executions = existsSync(counter) ? readFileSync(counter, 'utf8').split('\n').filter(Boolean).length : 0;
    assert.equal(executions, 1, `the suite ran ${executions} times for one final tree`);
    for (const r of results) assert.equal(r.verdict, 'pass', JSON.stringify(r));
    assert.equal((JSON.parse(readFileSync(cache, 'utf8')) as { gen: string }).gen, last, 'the cache is labeled with a generation that did not run');
  });
});

describe('contour-suite verdict edges found by race-auditor 24.09', () => {
  const LIB_TEST = "import { it } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { two } from '../src/lib.ts';\nimport { expected } from '../src/expect.ts';\nit('two', () => { assert.equal(two, expected); });\n";
  const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: sb.home, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  let seq = 0;
  const committed = (files: Record<string, string>): { repo: string; git: (...a: string[]) => string; stateDir: string } => {
    const dir = contourRepo(`edge${++seq}`, { 'README.md': 'x\n', ...files });
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, env: gitEnv, encoding: 'utf8' });
    git('init', '-q'); git('add', '.'); git('commit', '-qm', 'base');
    return { repo: git('rev-parse', '--show-toplevel').trim(), git, stateDir: join(sb.dir, `st-edge${seq}`) };
  };
  let n = 0;
  const ctxOf = (repo: string, stateDir: string) => ({ event: 'post' as const, payload: payload('PostToolUse', { session_id: 's-edge', tool_name: 'Edit', tool_input: {}, tool_use_id: `c${++n}` }, repo) as never, env: { HOME: sb.home, CLAUDE_STATE_DIR: stateDir, HARNESS_ROOT, PATH: process.env.PATH ?? '/usr/bin:/bin' }, root: HARNESS_ROOT, stateDir, now: Date.now });
  const claim = async (repo: string, stateDir: string): Promise<string[]> => {
    const st = State.open(stateDir);
    try { await sweep(ctxOf(repo, stateDir), st, { spawnWorker: false, checkerFilter: (name) => name === NAME }); return (st.db.prepare("SELECT job_id FROM jobs WHERE repo = ? AND status = 'claimed'").all(repo) as Array<{ job_id: string }>).map((r) => r.job_id); }
    finally { st.close(); }
  };
  const work = async (stateDir: string, ids: string[]): Promise<void> => { const st = State.open(stateDir); try { for (const id of ids) await runJob(st, id, ctxOf('', stateDir).env, HARNESS_ROOT); } finally { st.close(); } };
  const verdictOf = (repo: string, stateDir: string, path: string): string | undefined => {
    const st = State.open(stateDir);
    try { return (st.db.prepare('SELECT verdict FROM verified WHERE repo = ? AND path = ? AND checker = ?').get(repo, path, NAME) as { verdict: string } | undefined)?.verdict; }
    finally { st.close(); }
  };

  it('runs again a red tree that comes back byte for byte after a green one', async () => {
    const { repo, git, stateDir } = committed({ 'harness/src/lib.ts': 'export const two = 2;\n', 'harness/src/expect.ts': 'export const expected = 2;\n', 'harness/test/lib.test.ts': LIB_TEST });
    await withoutProcessKill(async () => {
      writeFileSync(join(repo, 'harness/src/lib.ts'), 'export const two = 1;\n');
      await work(stateDir, await claim(repo, stateDir));
      assert.equal(verdictOf(repo, stateDir, 'harness/src/lib.ts'), 'fail');
      writeFileSync(join(repo, 'harness/src/expect.ts'), 'export const expected = 1;\n');
      await work(stateDir, await claim(repo, stateDir));
      assert.equal(verdictOf(repo, stateDir, 'harness/src/lib.ts'), 'pass');
      git('checkout', '--', 'harness/src/expect.ts');
      await work(stateDir, await claim(repo, stateDir));
      assert.equal(verdictOf(repo, stateDir, 'harness/src/lib.ts'), 'fail', 'the red tree came back and nothing ran it');
    });
  });

  it('runs a generation that a later one consumed before its worker started, once the tree returns to it', async () => {
    const { repo, git, stateDir } = committed({ 'harness/src/lib.ts': 'export const two = 2;\n', 'harness/src/expect.ts': 'export const expected = 2;\n', 'harness/test/lib.test.ts': LIB_TEST });
    await withoutProcessKill(async () => {
      writeFileSync(join(repo, 'harness/src/lib.ts'), 'export const two = 1;\n');
      const first = await claim(repo, stateDir);
      writeFileSync(join(repo, 'harness/src/expect.ts'), 'export const expected = 1;\n');
      const second = await claim(repo, stateDir);
      await work(stateDir, [...new Set([...first, ...second])]);
      git('checkout', '--', 'harness/src/expect.ts');
      const third = await claim(repo, stateDir);
      assert.ok(third.length > 0, 'the red tree is back and no job was queued for it');
      await work(stateDir, third);
      assert.equal(verdictOf(repo, stateDir, 'harness/src/lib.ts'), 'fail');
    });
  });

  it('moves the generation when a file the suite reads outside src and test changes', async () => {
    const good = JSON.stringify({ hooks: { Stop: [{ matcher: 'mcp__.*' }] } });
    const { repo, stateDir } = committed({ 'harness/hooks.json': good, 'harness/test/settings.test.ts': "import { it } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\nit('regex matcher', () => { const c = JSON.parse(readFileSync(new URL('../hooks.json', import.meta.url), 'utf8')); assert.equal(c.hooks.Stop[0].matcher, 'mcp__.*'); });\n" });
    await withoutProcessKill(async () => {
      writeFileSync(join(repo, 'harness/src/main.ts'), 'export const x = 1;\n');
      await work(stateDir, await claim(repo, stateDir));
      assert.equal(verdictOf(repo, stateDir, 'harness/src/main.ts'), 'pass');
      writeFileSync(join(repo, 'harness/hooks.json'), JSON.stringify({ hooks: { Stop: [{ matcher: 'mcp__' }] } }));
      await work(stateDir, await claim(repo, stateDir));
      assert.equal(verdictOf(repo, stateDir, 'harness/hooks.json'), 'fail', 'a broken input of the suite passed from the cache');
    });
  });

  it('never caches a verdict under a generation the run did not see from start to end', async () => {
    const repo = contourRepo('label', { 'harness/src/lib.ts': 'export const two = 1;\n', 'harness/test/slow.test.ts': "import { it } from 'node:test';\nimport assert from 'node:assert/strict';\nit('two', async () => { await new Promise((r) => setTimeout(r, 2500)); const { two } = await import('../src/lib.ts'); assert.equal(two, 2); });\n" });
    const stateDir = join(sb.dir, 'st-label');
    const ctx: CheckContext = { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: sb.home }, stateDir, now: Date.now, deadlineMs: Infinity };
    const file: ChangedFile = { repo, path: 'harness/src/lib.ts', absPath: join(repo, 'harness/src/lib.ts'), digest: '0', status: 'M' };
    const red = suiteGeneration(repo);
    spawn('sh', ['-c', `sleep 1; printf 'export const two = 2;\\n' > '${join(repo, 'harness/src/lib.ts')}'`], { detached: true, stdio: 'ignore' }).unref();
    await withoutProcessKill(() => run(file, ctx));
    writeFileSync(join(repo, 'harness/src/lib.ts'), 'export const two = 1;\n');
    assert.equal(suiteGeneration(repo), red);
    const again = await withoutProcessKill(() => run(file, ctx));
    assert.equal(again.verdict, 'fail', 'the red tree was answered from a cache written while the tree was changing');
  });

});
