// INVARIANT: an unknown that more time can cure (deadline spent before the check started, check killed by its
// timeout) is not "verified" — the same content is checked again as soon as a materially larger budget is on offer;
// pass, fail and an unknown no budget can cure stay settled. A checker that did not finish in B ms is not launched
// again for any file of that repo while less than 2B is on offer, and a repeated transient unknown is not news.
// It broke silently: the skip rule compared digest and generation and never looked at the verdict, so a change set
// larger than the 1500 ms sync budget got its deadline-exhausted unknown once and was never checked again, while
// the head line of the sweep kept counting those files as already verified.
// Time is the fixture's clock and check.sh is scripted, never spawned: on a loaded machine a wall-clock deadline went
// to git status before the first launch, and the scenarios below turned into different ones with the same names.
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { route } from '../../src/main.ts';
import '../../src/checks/index.ts';
import { CHECKERS } from '../../src/checks/registry.ts';
import { budgetMs } from '../../src/checks/project-check.ts';
import { deliver, digestOf, recordResult, rootReader, sweep } from '../../src/sweep.ts';
import type { Finding, SweepOptions, SweepOutcome } from '../../src/sweep.ts';
import { State } from '../../src/state.ts';
import { generation } from '../../src/contour.ts';
import type { ChangedFile, CheckContext, CheckResult, Checker } from '../../src/checks/types.ts';
import type { GateContext } from '../../src/types.ts';
import { sandbox, payload, HARNESS_ROOT, onlyGate } from '../_env.ts';
import type { Sandbox } from '../_env.ts';
import { TS_PATH } from '../checks/_repo.ts';

const PROJECT_CHECK: Checker = CHECKERS.find((c) => c.name === 'project-check') ?? assert.fail('project-check is not registered: every sweep below would run without it');

type Mode = 'fail' | 'pass';
/** check.sh as a script of virtual durations: with no mode it outlives any budget, with one it answers at once;
 * a `slow` file takes that many ms and passes whatever the mode; `during` runs inside the launch, where another
 * session may act. Only a launch moves the clock — by what it took, or by the budget that cut it off. */
interface Script { slow?: Record<string, number>; during?: (f: ChangedFile, ctx: CheckContext) => void }

interface Fixture { sb: Sandbox; repo: string; top: string; env: Record<string, string>; now: () => number; launches: string[]; mode: (m: Mode) => void; ctx: (id: string, session?: string) => GateContext }

function fixture(t: TestContext, files: Record<string, string>, script: Script = {}): Fixture {
  const sb = sandbox('harness-transient-');
  const repo = join(sb.dir, 'repo');
  mkdirSync(join(repo, '.claude'), { recursive: true });
  writeFileSync(join(repo, '.claude', 'check.sh'), '#!/bin/bash\necho "scripted by the test, must not run: $1"\nexit 1\n', { mode: 0o755 });
  for (const name of Object.keys(files)) if (name.endsWith('.md')) writeFileSync(join(repo, name), '# base\n');
  const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: sb.home, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  for (const args of [['init', '-q'], ['add', '.'], ['commit', '-qm', 'base']]) execFileSync('git', args, { cwd: repo, env: gitEnv });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(repo, name), text);
  const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: repo, env: gitEnv, encoding: 'utf8' }).trim();
  const env = { HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, HARNESS_ROOT, PATH: process.env.PATH ?? '/usr/bin:/bin', CLAUDE_HARNESS_TS: TS_PATH };
  let clock = 1_000_000; let mode: Mode | null = null; const launches: string[] = [];
  t.mock.method(PROJECT_CHECK, 'run', async (f: ChangedFile, cctx: CheckContext): Promise<CheckResult> => {
    launches.push(f.path);
    script.during?.(f, cctx);
    const budget = budgetMs(cctx); const slow = script.slow?.[f.path];
    const takes = slow ?? (mode ? 0 : Infinity);
    if (takes > budget) { clock += budget; return { verdict: 'unknown', missing_reason: 'check.sh превысил таймаут', transient: 'timeout' }; }
    clock += takes;
    return mode === 'fail' && slow === undefined ? { verdict: 'fail', message: `${f.path}: broken: ${f.path}` } : { verdict: 'pass' };
  });
  const now = (): number => clock;
  return {
    sb, repo, top, env, now, launches,
    mode: (m) => { mode = m; },
    ctx: (id, session = 'session-1') => ({ event: 'post', payload: payload('PostToolUse', { session_id: session, tool_name: 'Bash', tool_input: { command: 'x' }, tool_use_id: id }, repo) as never, env, root: HARNESS_ROOT, stateDir: sb.stateDir, now }),
  };
}
const only = (...names: string[]): SweepOptions => ({ spawnWorker: false, checkerFilter: (n) => names.includes(n) });
const told = (f: Finding[]): string[][] => f.map((x) => [x.path, x.checker, x.level, x.message]);
const seen = (o: SweepOutcome): { checked: number; skippedVerified: number; findings: string[][] } => ({ checked: o.checked, skippedVerified: o.skippedVerified, findings: told(o.findings) });

describe('sweep', () => {
  it('checks the same content again after a timeout once a larger budget is on offer — a timeout verifies nothing', async (t) => {
    const fx = fixture(t, { 'doc.md': '# changed\n' }); const st = State.open(fx.sb.stateDir);
    try {
      const first = await sweep(fx.ctx('t1'), st, { ...only('project-check'), syncDeadlineMs: 400 });
      assert.deepEqual(seen(first), { checked: 1, skippedVerified: 0, findings: [['doc.md', 'project-check', 'unknown', 'check.sh превысил таймаут']] });
      fx.mode('fail');
      const second = await sweep(fx.ctx('t2'), st, { ...only('project-check'), syncDeadlineMs: 5000 });
      assert.deepEqual(seen(second), { checked: 1, skippedVerified: 0, findings: [['doc.md', 'project-check', 'fail', 'doc.md: broken: doc.md']] },
        'Miss this and a real failure in unchanged content is never reported: the timeout stays in `verified` and the file counts as «уже подтверждено»');
    } finally { st.close(); fx.sb.cleanup(); }
  });

  it('runs what the deadline never let start, and runs it before the check that already burned a budget', async (t) => {
    const fx = fixture(t, { 'a.md': '# a\n', 'b.md': '# b\n' }); const st = State.open(fx.sb.stateDir);
    try {
      const first = await sweep(fx.ctx('t1'), st, { ...only('project-check'), syncDeadlineMs: 300 });
      assert.deepEqual(told(first.findings), [['a.md', 'project-check', 'unknown', 'check.sh превысил таймаут'], ['b.md', 'project-check', 'unknown', 'дедлайн синхронного яруса исчерпан']]);
      fx.mode('pass');
      const second = await sweep(fx.ctx('t2'), st, { ...only('project-check'), syncDeadlineMs: 5000 });
      assert.deepEqual(seen(second), { checked: 2, skippedVerified: 0, findings: [] }, 'Miss this and the tail of a large change set is never checked at all');
      assert.deepEqual(fx.launches, ['a.md', 'b.md', 'a.md'], 'the never-started check goes first: the one that ate a whole budget must not starve it again');
      const third = await sweep(fx.ctx('t3'), st, { ...only('project-check'), syncDeadlineMs: 5000 });
      assert.deepEqual(seen(third), { checked: 0, skippedVerified: 2, findings: [] });
    } finally { st.close(); fx.sb.cleanup(); }
  });

  for (const settled of ['pass', 'fail'] as const) {
    it(`does not run a settled ${settled} again for unchanged content (no regression)`, async (t) => {
      const fx = fixture(t, { 'doc.md': '# changed\n' }); const st = State.open(fx.sb.stateDir);
      try {
        fx.mode(settled);
        assert.equal((await sweep(fx.ctx('t1'), st, only('project-check'))).checked, 1);
        assert.deepEqual(seen(await sweep(fx.ctx('t2'), st, only('project-check'))), { checked: 0, skippedVerified: 1, findings: [] });
        assert.deepEqual(fx.launches, ['doc.md']);
      } finally { st.close(); fx.sb.cleanup(); }
    });
  }

  it('does not run an unknown that no budget can cure again — a missing parser is not a timeout (no regression)', async (t) => {
    const fx = fixture(t, { 'x.ts': '// plain\nexport const x = 1;\n' }); const st = State.open(fx.sb.stateDir);
    try {
      const noTypescript = { ...fx.ctx('t1'), env: { ...fx.env, CLAUDE_HARNESS_TS: '' } };
      const first = await sweep(noTypescript, st, only('comment-language'));
      assert.deepEqual(first.findings.map((f) => [f.path, f.level]), [['x.ts', 'unknown']]);
      assert.deepEqual(seen(await sweep({ ...noTypescript, payload: fx.ctx('t2').payload }, st, only('comment-language'))), { checked: 0, skippedVerified: 1, findings: [] },
        'Miss this and every event re-runs a check that cannot answer, forever');
    } finally { st.close(); fx.sb.cleanup(); }
  });

  it('benches a checker that did not finish with a real budget: no second launch for any file, and the checkers behind it finally run', async (t) => {
    const fx = fixture(t, { 'a.md': '# a\n', 'x.ts': '// комментарий\nexport const x = 1;\n' }); const st = State.open(fx.sb.stateDir);
    try {
      const both = only('project-check', 'comment-language');
      const first = await sweep(fx.ctx('t1'), st, { ...both, syncDeadlineMs: 600 });
      assert.deepEqual(told(first.findings).map((r) => r.slice(0, 3)), [['a.md', 'project-check', 'unknown'], ['x.ts', 'project-check', 'unknown'], ['x.ts', 'comment-language', 'unknown']]);
      const second = await sweep(fx.ctx('t2'), st, { ...both, syncDeadlineMs: 600 });
      assert.deepEqual(told(second.findings).map((r) => r.slice(0, 3)), [['x.ts', 'comment-language', 'fail']],
        'Miss this and one slow check.sh keeps the structural checks of the whole change set unknown forever');
      await sweep(fx.ctx('t3'), st, { ...both, syncDeadlineMs: 600 });
      assert.deepEqual(fx.launches, ['a.md'], 'Miss this and every event launches a doomed script again — each one outlives its kill as an orphan');
    } finally { st.close(); fx.sb.cleanup(); }
  });

  it('relaunches a cut-off check only once twice its cut-off is on offer — one ms less and it stays benched', async (t) => {
    const fx = fixture(t, { 'a.md': '# a\n' }); const st = State.open(fx.sb.stateDir);
    try {
      await sweep(fx.ctx('t1'), st, { ...only('project-check'), syncDeadlineMs: 600 });
      await sweep(fx.ctx('t2'), st, { ...only('project-check'), syncDeadlineMs: 1199 });
      assert.deepEqual(fx.launches, ['a.md'], 'Miss this and a check.sh that cannot finish is relaunched whenever a little more time turns up, an orphan each time');
      await sweep(fx.ctx('t3'), st, { ...only('project-check'), syncDeadlineMs: 1200 });
      assert.deepEqual(fx.launches, ['a.md', 'a.md'], 'Miss this and a check cut off once never gets the doubled budget that could let it finish');
    } finally { st.close(); fx.sb.cleanup(); }
  });

  it('does not launch a check another session settled while this sweep was busy — the snapshot is re-read before every launch', async (t) => {
    const settleB = (f: ChangedFile, cctx: CheckContext): void => {
      if (f.path !== 'a.md') return;
      const other = State.open(cctx.stateDir); const b = join(f.repo, 'b.md');
      try { recordResult(other, { repo: f.repo, path: 'b.md', absPath: b, digest: digestOf(b), status: 'M' }, 'project-check', generation(HARNESS_ROOT), { verdict: 'pass' }, 1); } finally { other.close(); }
    };
    const fx = fixture(t, { 'a.md': '# a\n', 'b.md': '# b\n' }, { during: settleB }); const st = State.open(fx.sb.stateDir);
    try {
      fx.mode('pass');
      const out = await sweep(fx.ctx('t1'), st, only('project-check'));
      assert.deepEqual({ launches: fx.launches, ...seen(out) }, { launches: ['a.md'], checked: 1, skippedVerified: 1, findings: [] },
        'Miss this and parallel agents in one repository each repeat the whole sweep of the other instead of sharing it');
    } finally { st.close(); fx.sb.cleanup(); }
  });

  it('neither counts a worker-tier timeout as verified nor queues it again — re-running a ten-minute job is a decision, not a side effect', async (t) => {
    const fx = fixture(t, { 'tsconfig.json': '{}\n', 'x.ts': 'export const x = 1;\n' }); const st = State.open(fx.sb.stateDir);
    try {
      const file: ChangedFile = { repo: fx.top, path: 'x.ts', absPath: join(fx.top, 'x.ts'), digest: digestOf(join(fx.top, 'x.ts')), status: '?' };
      recordResult(st, file, 'tsc-project', generation(HARNESS_ROOT), { verdict: 'unknown', missing_reason: 'tsc превысил таймаут', transient: 'timeout' }, 1, 120000);
      const out = await sweep(fx.ctx('t1'), st, only('tsc-project'));
      const jobs = (st.db.prepare('SELECT count(*) c FROM jobs').get() as { c: number }).c;
      assert.deepEqual({ skippedVerified: out.skippedVerified, deferred: out.deferred, pending: out.pending, jobs }, { skippedVerified: 0, deferred: 1, pending: 0, jobs: 0 });
    } finally { st.close(); fx.sb.cleanup(); }
  });

  it('keeps a pass settled when an older harness left a budget beside it', async (t) => {
    const fx = fixture(t, { 'doc.md': '# changed\n' }); const st = State.open(fx.sb.stateDir);
    try {
      st.db.prepare('INSERT INTO verified(repo, path, checker, digest, verdict, checker_gen, at, timed_out_after_ms) VALUES(?,?,?,?,?,?,?,?)')
        .run(fx.top, 'doc.md', 'project-check', digestOf(join(fx.top, 'doc.md')), 'pass', generation(HARNESS_ROOT), 1, 500);
      const out = await sweep(fx.ctx('t1'), st, only('project-check'));
      assert.deepEqual({ launches: fx.launches, ...seen(out) }, { launches: [], checked: 0, skippedVerified: 1, findings: [] });
    } finally { st.close(); fx.sb.cleanup(); }
  });

  it('tells a second session the verdict that replaced the unknown it was told', async (t) => {
    const fx = fixture(t, { 'doc.md': '# changed\n' }); const st = State.open(fx.sb.stateDir);
    const pass = async (id: string, session: string, syncDeadlineMs: number): Promise<string[][]> => {
      const out = await sweep(fx.ctx(id, session), st, { ...only('project-check'), syncDeadlineMs });
      return told(deliver(st, rootReader(session), out.roots, 0, out.findings, out.files).found);
    };
    try {
      const unknown = [['doc.md', 'project-check', 'unknown', 'check.sh превысил таймаут']];
      assert.deepEqual(await pass('t1', 'one', 300), unknown);
      assert.deepEqual(await pass('t2', 'two', 300), unknown, 'the second session learns the open unknown from the shared table');
      assert.deepEqual(await pass('t3', 'two', 300), [], 'and is not told the same unknown twice');
      fx.mode('fail');
      const failed = [['doc.md', 'project-check', 'fail', 'doc.md: broken: doc.md']];
      assert.deepEqual(await pass('t4', 'one', 5000), failed);
      assert.deepEqual(await pass('t5', 'two', 5000), failed, 'Miss this and the session that was told «unknown» never hears that the file is in fact broken');
      assert.deepEqual(fx.launches, ['doc.md', 'doc.md'], 'the second session must not pay for a launch the first one already made');
    } finally { st.close(); fx.sb.cleanup(); }
  });
});

describe('recordResult', () => {
  const file = (repo: string): ChangedFile => ({ repo, path: 'doc.md', absPath: join(repo, 'doc.md'), digest: 'd1', status: 'M' });
  const row = (st: State): { verdict: string; timed_out_after_ms: number | null } => {
    const r = st.db.prepare('SELECT * FROM verified WHERE path = ?').get('doc.md') as { verdict: string; timed_out_after_ms?: number | null };
    return { verdict: r.verdict, timed_out_after_ms: r.timed_out_after_ms ?? null };
  };
  const findings = (st: State): unknown[] => st.db.prepare('SELECT level, message FROM findings').all();

  it('keeps a settled verdict when a slower session reports a timeout for the same content', () => {
    const sb = sandbox('harness-record-'); const st = State.open(sb.stateDir);
    try {
      recordResult(st, file(sb.dir), 'project-check', 'g1', { verdict: 'pass' }, 1);
      assert.equal(recordResult(st, file(sb.dir), 'project-check', 'g1', { verdict: 'unknown', missing_reason: 'check.sh превысил таймаут', transient: 'timeout' }, 2, 900), null);
      assert.deepEqual(row(st), { verdict: 'pass', timed_out_after_ms: null }, 'Miss this and a loaded machine un-verifies what a healthy one verified, launching the check again');
      assert.deepEqual(findings(st), []);
    } finally { st.close(); sb.cleanup(); }
  });

  it('drops the finding of the same content once that content passes', () => {
    const sb = sandbox('harness-record-'); const st = State.open(sb.stateDir);
    try {
      recordResult(st, file(sb.dir), 'project-check', 'g1', { verdict: 'unknown', missing_reason: 'дедлайн синхронного яруса исчерпан', transient: 'unstarted' }, 1, 0);
      assert.deepEqual(row(st), { verdict: 'unknown', timed_out_after_ms: 0 });
      recordResult(st, file(sb.dir), 'project-check', 'g1', { verdict: 'pass' }, 2);
      assert.deepEqual(findings(st), [], 'Miss this and a session that joins later is told «unknown» about a file that has passed');
    } finally { st.close(); sb.cleanup(); }
  });

  it('ignores the transient mark on anything but unknown — a fail is settled whatever the checker claims', () => {
    const sb = sandbox('harness-record-'); const st = State.open(sb.stateDir);
    try {
      recordResult(st, file(sb.dir), 'project-check', 'g1', { verdict: 'fail', message: 'doc.md: broken', transient: 'timeout' }, 1, 900);
      assert.deepEqual(row(st), { verdict: 'fail', timed_out_after_ms: null });
    } finally { st.close(); sb.cleanup(); }
  });
});

describe('sweepStop', () => {
  // The real door has the real 1500 ms budget: a-slow.md spends 1300 of it and passes, b.md is left a sliver of 200.
  const SLIVER: Script = { slow: { 'a-slow.md': 1300 } };
  const stop = (fx: Fixture): ReturnType<typeof route> => route('stop', payload('Stop', {}, fx.repo) as never, { ...fx.env, ...onlyGate('sweep-stop') }, fx.now);

  it('blocks a second Stop when the retried check turns the unknown into a failure', async (t) => {
    const fx = fixture(t, { 'a-slow.md': '# a\n', 'b.md': '# b\n' }, SLIVER);
    try {
      const first = await stop(fx);
      assert.equal(first.kind, 'block');
      assert.match((first as { reason: string }).reason, /b\.md \[project-check\] unknown: /);
      fx.mode('fail');
      const second = await stop(fx);
      assert.equal(second.kind, 'block', 'Miss this and the turn ends on a broken file: the unknown was reported once and the check never ran');
      assert.match((second as { reason: string }).reason, /b\.md \[project-check\] fail: b\.md: broken: b\.md/);
    } finally { fx.sb.cleanup(); }
  });

  it('does not block a second Stop on the same check timing out again — a repeated unknown is not news', async (t) => {
    const fx = fixture(t, { 'a-slow.md': '# a\n', 'b.md': '# b\n' }, SLIVER);
    try {
      assert.equal((await stop(fx)).kind, 'block');
      const second = await stop(fx);
      assert.equal(second.kind, 'silent', `Miss this and a check nobody can speed up locks the session: ${JSON.stringify(second)}`);
    } finally { fx.sb.cleanup(); }
  });
});
