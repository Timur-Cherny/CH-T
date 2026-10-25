// INVARIANT: a file a commit moved out of `git status` stays in the sweep of every session until that session has the
// verdicts on it: the HEAD cursor is per session and per repository, and it does not pass a commit while a check of one
// of its files is queued, running or deferred. A session that has never swept the repository starts from the cursor
// the repository last saw, so an edit committed in its very first call is still seen.
// REGRESSION 25.09 (README known defects, high): one `last_head` per repository, taken by the first sweep that
// saw HEAD move — another session swept first and the committing session never heard of its own broken commit; a
// worker verdict on a committed file, or a sync check the deadline put off, landed after the cursor had moved on and
// was never delivered.
// REGRESSION race-auditor 02.10 (P1–P3, P5): the cursor was released once the verdicts existed, not once the root had them.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { State } from '../../src/state.ts';
import { REPORT_CHARS, deliver, rootReader, settleCursors, sweep } from '../../src/sweep.ts';
import { runJob } from '../../src/jobs/worker.ts';
import { registerChecker } from '../../src/checks/registry.ts';
import type { GateContext } from '../../src/types.ts';
import { sandbox, payload, HARNESS_ROOT } from '../_env.ts';

const sb = sandbox('harness-head-cursor-');
after(() => sb.cleanup());
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: sb.home, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const OTHERS = { CLAUDE_SKIP_CHECK: '1', CLAUDE_SKIP_COMMENT_CHECK: '1', CLAUDE_SKIP_COMMENT_LANGUAGE: '1', CLAUDE_SKIP_DELIVERY_TRIPWIRE: '1', CLAUDE_SKIP_CONTOUR_SUITE: '1', CLAUDE_SKIP_SYNTAX: '1', CLAUDE_SKIP_PROJECT_CHECK: '1' };
const bad = (abs: string): boolean => readFileSync(abs, 'utf8').includes('BAD');
registerChecker({ name: 'cursor-sync', tier: 'sync', killSwitch: 'CLAUDE_SKIP_CURSOR_SYNC', applies: (f) => f.path.endsWith('.s'), run: async (f) => (bad(f.absPath) ? { verdict: 'fail', message: 'BAD in sync' } : { verdict: 'pass' }) });
registerChecker({ name: 'cursor-long', tier: 'sync', killSwitch: 'CLAUDE_SKIP_CURSOR_LONG', applies: (f) => f.path.endsWith('.l'), run: async (f) => (bad(f.absPath) ? { verdict: 'fail', message: `BAD ${'x'.repeat(900)} ${f.path}` } : { verdict: 'pass' }) });
registerChecker({ name: 'cursor-slow', tier: 'sync', killSwitch: 'CLAUDE_SKIP_CURSOR_SLOW', applies: (f) => f.path.endsWith('.t'), budgetMs: () => 50, run: async (f) => (readFileSync(f.absPath, 'utf8').includes('SLOW') ? { verdict: 'unknown', missing_reason: 'slow', transient: 'timeout' } : bad(f.absPath) ? { verdict: 'fail', message: 'BAD t' } : { verdict: 'pass' }) });
registerChecker({ name: 'cursor-worker', tier: 'worker', killSwitch: 'CLAUDE_SKIP_CURSOR_WORKER', applies: (f) => f.path.endsWith('.w'), run: async (f) => (bad(f.absPath) ? { verdict: 'fail', message: 'BAD in worker' } : { verdict: 'pass' }) });

let seq = 0;
function fixture(): { repo: string; stateDir: string; git: (...a: string[]) => string } {
  const dir = join(sb.dir, `r${++seq}`); mkdirSync(dir);
  const git = (...a: string[]): string => execFileSync('git', a, { cwd: dir, env: gitEnv, encoding: 'utf8' });
  writeFileSync(join(dir, 'README.md'), 'x\n');
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'base');
  return { repo: git('rev-parse', '--show-toplevel').trim(), stateDir: join(sb.dir, `st${seq}`), git };
}
const commit = (fx: ReturnType<typeof fixture>, rel: string, text: string): void => { writeFileSync(join(fx.repo, rel), text); fx.git('add', '.'); fx.git('commit', '-qm', rel); };

let n = 0;
/** One post of `session`: an `agent` post sweeps into its own ledger and leaves the root's cursor untouched. */
async function see(fx: ReturnType<typeof fixture>, session: string, opts: { syncDeadlineMs?: number; agent?: string; budget?: number } = {}): Promise<{ found: string[]; changed: number; jobs: string[]; omitted: number }> {
  const ctx: GateContext = { event: 'post', payload: payload('PostToolUse', { session_id: session, tool_name: 'Edit', tool_input: {}, tool_use_id: `h${++n}`, ...(opts.agent ? { agent_id: opts.agent } : {}) }, fx.repo) as never, env: { HOME: sb.home, CLAUDE_STATE_DIR: fx.stateDir, HARNESS_ROOT, PATH: process.env.PATH ?? '/usr/bin:/bin', ...OTHERS }, root: HARNESS_ROOT, stateDir: fx.stateDir, now: Date.now };
  const st = State.open(fx.stateDir);
  try {
    const out = await sweep(ctx, st, { spawnWorker: false, syncDeadlineMs: opts.syncDeadlineMs });
    const jobs = (st.db.prepare("SELECT job_id FROM jobs WHERE repo = ? AND status = 'claimed'").all(fx.repo) as Array<{ job_id: string }>).map((r) => r.job_id);
    if (opts.agent) return { found: [], changed: out.changed, jobs, omitted: 0 };
    const d = deliver(st, rootReader(session), out.roots, Date.now(), out.findings, out.files, { filesAt: out.filesAt, budget: opts.budget });
    settleCursors(st, session, out, Date.now());
    return { found: d.found.map((f) => `${f.path}:${f.level}`), changed: out.changed, jobs, omitted: d.omitted };
  } finally { st.close(); }
}
async function work(fx: ReturnType<typeof fixture>, jobs: string[]): Promise<void> {
  const st = State.open(fx.stateDir);
  try { for (const j of jobs) await runJob(st, j, { ...process.env, ...OTHERS }, HARNESS_ROOT); } finally { st.close(); }
}

describe('HEAD cursor', () => {
  it('tells the committing session about its own broken commit even when another session swept first', async () => {
    const fx = fixture();
    await see(fx, 's-a'); await see(fx, 's-b');
    commit(fx, 'a.s', 'BAD\n');
    assert.deepEqual((await see(fx, 's-b')).found, ['a.s:fail']);
    assert.deepEqual((await see(fx, 's-a')).found, ['a.s:fail'], 'the other session took the cursor and the committing one never heard');
  });

  it('delivers a worker verdict on a committed file that arrives after the event that queued it', async () => {
    const fx = fixture();
    await see(fx, 's-w');
    commit(fx, 'b.w', 'BAD\n');
    const first = await see(fx, 's-w');
    assert.equal(first.jobs.length, 1, 'the committed file was not queued');
    await work(fx, first.jobs);
    assert.deepEqual((await see(fx, 's-w')).found, ['b.w:fail'], 'the verdict landed after the cursor moved on and was lost');
  });

  it('checks a committed file whose sync check the deadline put off', async () => {
    const fx = fixture();
    await see(fx, 's-d');
    commit(fx, 'c.s', 'BAD\n');
    assert.deepEqual((await see(fx, 's-d', { syncDeadlineMs: 0 })).found, ['c.s:unknown']);
    assert.deepEqual((await see(fx, 's-d')).found, ['c.s:fail'], 'the deferred check of a committed file never ran');
  });

  it('lets the cursor pass the commit once the verdicts are in, so a settled commit is not swept forever', async () => {
    const fx = fixture();
    await see(fx, 's-p');
    commit(fx, 'd.w', 'ok\n');
    await work(fx, (await see(fx, 's-p')).jobs);
    await see(fx, 's-p');
    const later = await see(fx, 's-p');
    assert.deepEqual({ changed: later.changed, jobs: later.jobs, found: later.found }, { changed: 0, jobs: [], found: [] });
  });

  it('starts a new session from the cursor the repository last saw: an edit committed in its first call is seen', async () => {
    const fx = fixture();
    await see(fx, 's-old');
    commit(fx, 'e.s', 'BAD\n');
    assert.deepEqual((await see(fx, 's-new')).found, ['e.s:fail']);
  });

  it('keeps a session that never touched the repository out of commits older than the cursor', async () => {
    const fx = fixture();
    await see(fx, 's-1');
    commit(fx, 'f.s', 'BAD\n');
    await see(fx, 's-1');
    assert.deepEqual((await see(fx, 's-2')).found, [], 'a new session was told about a commit the repository cursor had already passed');
  });

  it('keeps the cursor for the root when a subagent post sweeps the same session before the root is told', async () => {
    const fx = fixture();
    await see(fx, 's-sub');
    commit(fx, 'g.w', 'BAD\n');
    const first = await see(fx, 's-sub');
    await work(fx, first.jobs);
    await see(fx, 's-sub', { agent: 'sub-1' });
    assert.deepEqual((await see(fx, 's-sub')).found, ['g.w:fail'], 'the subagent post released the root cursor and the root never heard');
  });

  it('tells every committed finding that did not fit the report on a later event', async () => {
    const fx = fixture();
    await see(fx, 's-budget');
    for (let i = 0; i < 15; i++) writeFileSync(join(fx.repo, `f${String(i).padStart(2, '0')}.l`), 'BAD\n');
    fx.git('add', '.'); fx.git('commit', '-qm', 'many');
    let told = 0;
    for (let i = 0; i < 3; i++) told += (await see(fx, 's-budget', { budget: REPORT_CHARS })).found.length;
    assert.equal(told, 15, 'findings cut by the report budget were never told again');
  });

  it('checks a committed file even when the change set is truncated by untracked files', async () => {
    const fx = fixture();
    await see(fx, 's-trunc');
    commit(fx, 'z.s', 'BAD\n');
    mkdirSync(join(fx.repo, 'gen'));
    for (let i = 0; i < 205; i++) writeFileSync(join(fx.repo, 'gen', `u${i}.txt`), 'u\n');
    const a = await see(fx, 's-trunc');
    rmSync(join(fx.repo, 'gen'), { recursive: true });
    const b = await see(fx, 's-trunc');
    assert.deepEqual([...a.found, ...b.found], ['z.s:fail'], 'the committed file was cut by truncation and the cursor passed it');
  });

  it('keeps a committed file whose check the same checker\'s bench puts off in the change set, and tells its unknown', async () => {
    const fx = fixture();
    await see(fx, 's-slow');
    writeFileSync(join(fx.repo, 'g.t'), 'SLOW\n');
    await see(fx, 's-slow');
    commit(fx, 'k.t', 'BAD\n');
    const all: string[] = []; let changed = 0;
    for (let i = 0; i < 3; i++) { const r = await see(fx, 's-slow'); all.push(...r.found); changed = r.changed; }
    assert.ok(all.includes('k.t:unknown'), `the deferred check of the committed file was not told: ${JSON.stringify(all)}`);
    assert.equal(changed, 2, 'the cursor passed a committed file whose check never ran');
  });
});
