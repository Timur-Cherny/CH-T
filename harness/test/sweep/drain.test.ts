// INVARIANT: Stop only waits: it waits for the worker a job has — running or still starting — and hands a job nobody
// holds to a new worker, never running a check in the Stop process; so a suite longer than the drain window runs once
// across the Stops of every session. A job whose worker never came or died is queued again by the next event. A lock
// whose holder died makes nobody wait, and its directory stays empty for an older harness; a suite verdict is cached only
// for a tree the run saw unchanged from start to end, and an input dated in the future does not count as a change.
// REGRESSION 25.09: the drain counted a job its worker was running as left at once, ran orphans itself under its
// deadline and lost the cut run; handing such a job back let the drain of another session take it over the same way,
// so two sessions restarted the suite on every Stop and never reported it (race-auditor on 3e195b3 and dd12ada).
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { State } from '../../src/state.ts';
import { digestOf, recordResult, sweep, verdictGeneration } from '../../src/sweep.ts';
import { awaitJob, runJob } from '../../src/jobs/worker.ts';
import { ORPHAN_CLAIM_MS } from '../../src/jobs/hold.ts';
import { generation } from '../../src/contour.ts';
import { sweepStop } from '../../src/gates/sweep-gates.ts';
import { CHECKERS, registerChecker } from '../../src/checks/registry.ts';
import { NAME, run, suiteGeneration } from '../../src/checks/contour-suite.ts';
import type { CheckContext, ChangedFile } from '../../src/checks/types.ts';
import type { GateContext, Verdict } from '../../src/types.ts';
import { sandbox, payload, HARNESS_ROOT } from '../_env.ts';

const sb = sandbox('harness-drain-');
after(() => sb.cleanup());
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: sb.home, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const SLOW = (ms: number): string => `import { it } from 'node:test';\nit('slow', async () => { await new Promise((r) => setTimeout(r, ${ms})); });\n`;
const RED_SLOW = (runs: string, ms: number): string => `import { it } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { appendFileSync } from 'node:fs';\nimport { two } from '../src/lib.ts';\nit('two', async () => { appendFileSync(${JSON.stringify(runs)}, 'run\\n'); await new Promise((r) => setTimeout(r, ${ms})); assert.equal(two, 2); });\n`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let seq = 0;
function contour(files: Record<string, string>): { repo: string; stateDir: string } {
  const dir = join(sb.dir, `c${++seq}`);
  for (const [rel, text] of Object.entries({ 'harness/bin/hook': '#!/bin/sh\n', 'harness/src/main.ts': 'export {};\n', 'README.md': 'x\n', ...files })) { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); }
  const git = (...a: string[]): string => execFileSync('git', a, { cwd: dir, env: gitEnv, encoding: 'utf8' });
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'base');
  return { repo: git('rev-parse', '--show-toplevel').trim(), stateDir: join(sb.dir, `st${seq}`) };
}
const lockOf = (stateDir: string, repo: string): string => join(stateDir, NAME, `${createHash('sha256').update(repo).digest('hex').slice(0, 16)}.json.lock`);
async function withoutProcessKill<T>(fn: () => T | Promise<T>): Promise<T> {
  const prev = process.env.CLAUDE_SKIP_CONTOUR_SUITE;
  delete process.env.CLAUDE_SKIP_CONTOUR_SUITE;
  try { return await fn(); } finally { if (prev !== undefined) process.env.CLAUDE_SKIP_CONTOUR_SUITE = prev; }
}
const OTHERS = { CLAUDE_SKIP_CHECK: '1', CLAUDE_SKIP_COMMENT_CHECK: '1', CLAUDE_SKIP_COMMENT_LANGUAGE: '1', CLAUDE_SKIP_DELIVERY_TRIPWIRE: '1' };
const envOf = (stateDir: string): Record<string, string> => ({ HOME: sb.home, CLAUDE_STATE_DIR: stateDir, HARNESS_ROOT, PATH: process.env.PATH ?? '/usr/bin:/bin', ...OTHERS });
let n = 0;
const ctxOf = (repo: string, stateDir: string, event: 'post' | 'stop', root = HARNESS_ROOT, session = 's-drain'): GateContext => ({ event, payload: payload(event === 'stop' ? 'Stop' : 'PostToolUse', { session_id: session, tool_name: 'Edit', tool_input: {}, tool_use_id: `d${++n}` }, repo) as never, env: envOf(stateDir), root, stateDir, now: Date.now });
const claimed = (st: State, repo: string): string => (st.db.prepare("SELECT job_id FROM jobs WHERE repo = ? AND status = 'claimed'").get(repo) as { job_id: string }).job_id;
const undrained = (v: Verdict): boolean => v.kind === 'block' && /не дренировано/.test(v.reason);
const lines = (p: string): string[] => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean) : []);
function fakeRoot(name: string): { root: string; marker: string } {
  const root = join(sb.dir, name); const marker = join(sb.dir, `${name}.log`);
  mkdirSync(join(root, 'src', 'jobs'), { recursive: true });
  writeFileSync(join(root, 'src', 'jobs', 'worker.ts'), `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(marker)}, process.argv[2] + '\\n');\n`);
  return { root, marker };
}
async function spawned(marker: string, job: string): Promise<boolean> {
  for (let i = 0; i < 40 && !lines(marker).includes(job); i++) await sleep(100);
  return lines(marker).includes(job);
}
let ran = 0;
registerChecker({ name: 'count-fake', tier: 'worker', killSwitch: 'CLAUDE_SKIP_COUNT_FAKE', applies: () => false, run: async () => { ran++; return { verdict: 'pass' }; } });
let during: (path: string) => Promise<void> = async () => {};
registerChecker({ name: 'hook-fake', tier: 'worker', killSwitch: 'CLAUDE_SKIP_HOOK_FAKE', applies: () => false, run: async (f) => { await during(f.path); return { verdict: 'pass' }; } });
let inflightRepo = ''; const inflightRuns: string[] = [];
registerChecker({ name: 'inflight-fake', tier: 'worker', killSwitch: 'CLAUDE_SKIP_INFLIGHT_FAKE', applies: (f) => f.repo === inflightRepo && f.path.endsWith('.ts'), run: async (f) => { inflightRuns.push(f.path); await sleep(600); return { verdict: 'pass' }; } });
function threeFileJob(st: State, id: string, repo: string, kind: string): void {
  st.db.prepare("INSERT INTO jobs(job_id, repo, kind, status, owner_session, skips, started_at) VALUES(?, ?, ?, 'claimed', 's', '[]', 0)").run(id, repo, kind);
  for (const f of ['a', 'b', 'c']) st.db.prepare('INSERT INTO job_files(job_id, repo, path, digest) VALUES(?, ?, ?, ?)').run(id, repo, `harness/src/${f}.ts`, digestOf(join(repo, `harness/src/${f}.ts`)));
}

describe('Stop drain', () => {
  it('waits for the worker a job already has instead of blocking Stop at once', { timeout: 30000 }, async () => {
    const { repo, stateDir } = contour({});
    const worker = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      const st = State.open(stateDir);
      try { st.db.prepare("INSERT INTO jobs(job_id, repo, kind, status, pid, owner_session, skips, started_at) VALUES('job-live', ?, 'tsc-project', 'running', ?, 's-other', '[]', ?)").run(repo, worker.pid, Date.now()); } finally { st.close(); }
      setTimeout(() => { const s = State.open(stateDir); try { s.db.prepare("UPDATE jobs SET status = 'done', rc = 0, finished_at = ? WHERE job_id = 'job-live'").run(Date.now()); } finally { s.close(); } }, 1000);
      const t0 = Date.now();
      const v = await sweepStop(ctxOf(repo, stateDir, 'stop'), 10000);
      assert.equal(v.kind, 'silent', `Stop gave up on a running worker: ${JSON.stringify(v)}`);
      assert.ok(Date.now() - t0 >= 900, 'the job was done before the drain looked at it');
    } finally { worker.kill(); }
  });

  it('runs a red suite longer than the drain window once and reports it, instead of restarting it on every Stop', { timeout: 60000 }, async () => {
    const runs = join(sb.dir, 'suite-runs.log');
    const { repo, stateDir } = contour({ 'harness/src/lib.ts': 'export const two = 2;\n', 'harness/test/lib.test.ts': RED_SLOW(runs, 3000) });
    writeFileSync(join(repo, 'harness/src/lib.ts'), 'export const two = 1;\n');
    const verdicts: Verdict[] = [];
    await withoutProcessKill(async () => {
      for (let i = 0; i < 8; i++) {
        verdicts.push(await sweepStop(ctxOf(repo, stateDir, 'stop'), 1500));
        if (!undrained(verdicts.at(-1)!)) break;
        await sleep(300);
      }
    });
    const last = verdicts.at(-1)!;
    assert.match(last.kind === 'block' ? last.reason : '', /lib\.ts \[contour-suite\] fail/, `the red tree was never reported: ${JSON.stringify(verdicts)}`);
    assert.equal(lines(runs).length, 1, 'the suite started over on a later Stop');
  });

  it('shares one worker between the Stops of two sessions, so a suite whose worker died is run once and reported to both', { timeout: 120000 }, async () => {
    const runs = join(sb.dir, 'two-runs.log'); const out = join(sb.dir, 'two-stops.jsonl'); const loop = join(sb.dir, 'stop-loop.ts');
    const { repo, stateDir } = contour({ 'harness/src/lib.ts': 'export const two = 2;\n', 'harness/test/lib.test.ts': RED_SLOW(runs, 3000) });
    writeFileSync(join(repo, 'harness/src/lib.ts'), 'export const two = 1;\n');
    await withoutProcessKill(async () => {
      const st = State.open(stateDir);
      try {
        await sweep(ctxOf(repo, stateDir, 'post'), st, { spawnWorker: false, checkerFilter: (x) => x === NAME });
        st.db.prepare("UPDATE jobs SET status = 'running', pid = ?, started_at = ? WHERE job_id = ?").run(spawnSync('true').pid, Date.now(), claimed(st, repo));
      } finally { st.close(); }
    });
    writeFileSync(loop, `import { appendFileSync } from 'node:fs';
import { sweepStop } from ${JSON.stringify(join(HARNESS_ROOT, 'src/gates/sweep-gates.ts'))};
import { payload } from ${JSON.stringify(join(HARNESS_ROOT, 'test/_env.ts'))};
const [session, delay] = process.argv.slice(2);
const env = ${JSON.stringify(envOf(stateDir))};
await new Promise((r) => setTimeout(r, Number(delay)));
for (let i = 0; i < 8; i++) {
  const v = await sweepStop({ event: 'stop', payload: payload('Stop', { session_id: session }, ${JSON.stringify(repo)}), env, root: env.HARNESS_ROOT, stateDir: env.CLAUDE_STATE_DIR, now: Date.now }, 2500);
  const reason = v.kind === 'block' ? v.reason : '';
  appendFileSync(${JSON.stringify(out)}, JSON.stringify({ session, undrained: /не дренировано/.test(reason), red: /lib\\.ts \\[contour-suite\\] fail/.test(reason) }) + '\\n');
  if (!/не дренировано/.test(reason)) break;
  await new Promise((r) => setTimeout(r, 300));
}
`);
    const stops = (session: string, delay: number): Promise<number> => new Promise((res) => {
      const env: NodeJS.ProcessEnv = { ...process.env }; delete env.CLAUDE_SKIP_CONTOUR_SUITE;
      spawn(process.execPath, ['--disable-warning=ExperimentalWarning', loop, session, String(delay)], { stdio: 'ignore', env }).on('exit', (code) => res(code ?? -1));
    });
    assert.deepEqual(await Promise.all([stops('s-a', 0), stops('s-b', 800)]), [0, 0]);
    const seen = lines(out).map((l) => JSON.parse(l) as { session: string; red: boolean });
    for (const s of ['s-a', 's-b']) assert.ok(seen.some((x) => x.session === s && x.red), `${s} never heard the red tree after ${seen.length} Stops and ${lines(runs).length} suite starts`);
    assert.equal(lines(runs).length, 1, 'the Stops restarted the suite');
  });

  it('never runs a job in the Stop process: a job nobody holds goes to a new worker', { timeout: 30000 }, async () => {
    const { repo, stateDir } = contour({ 'harness/src/a.ts': 'a\n' });
    const { root, marker } = fakeRoot('orphan-root');
    const st = State.open(stateDir);
    try {
      st.db.prepare("INSERT INTO jobs(job_id, repo, kind, status, owner_session, skips, started_at) VALUES('job-orphan', ?, 'count-fake', 'claimed', 's', '[]', 0)").run(repo);
      st.db.prepare("INSERT INTO job_files(job_id, repo, path, digest) VALUES('job-orphan', ?, 'harness/src/a.ts', ?)").run(repo, digestOf(join(repo, 'harness/src/a.ts')));
    } finally { st.close(); }
    const before = ran;
    const v = await sweepStop(ctxOf(repo, stateDir, 'stop', root), 1500);
    assert.equal(ran, before, 'the Stop process ran the check itself');
    assert.ok(await spawned(marker, 'job-orphan'), 'no worker was spawned for the orphan');
    assert.ok(undrained(v), `the Stop did not wait for the new worker: ${JSON.stringify(v)}`);
  });

  it('starts the worker for a job its own sweep queued, as a post does', { timeout: 30000 }, async () => {
    const { repo, stateDir } = contour({ 'harness/test/ok.test.ts': SLOW(10) });
    writeFileSync(join(repo, 'harness/src/main.ts'), 'export const y = 2;\n');
    const { root, marker } = fakeRoot('own-root');
    await withoutProcessKill(() => sweepStop(ctxOf(repo, stateDir, 'stop', root), 1000));
    const st = State.open(stateDir);
    let job: string; try { job = claimed(st, repo); } finally { st.close(); }
    assert.ok(await spawned(marker, job), 'the Stop left its own job to the orphan rule');
  });

  it('waits for a worker still starting instead of spawning a second one', { timeout: 30000 }, async () => {
    const { repo, stateDir } = contour({});
    const { root, marker } = fakeRoot('starting-root');
    const st = State.open(stateDir);
    try { st.db.prepare("INSERT INTO jobs(job_id, repo, kind, status, owner_session, skips, started_at) VALUES('job-starting', ?, 'count-fake', 'claimed', 's', '[]', ?)").run(repo, Date.now()); } finally { st.close(); }
    assert.ok(undrained(await sweepStop(ctxOf(repo, stateDir, 'stop', root), 1000)));
    assert.equal(lines(marker).length, 0, 'the drain spawned a second worker for a job whose worker was starting');
  });

  it('leaves a job to the live worker that runs it', { timeout: 30000 }, async () => {
    const { repo, stateDir } = contour({ 'harness/src/a.ts': 'a\n' });
    const other = spawn('sleep', ['30'], { stdio: 'ignore' });
    const st = State.open(stateDir);
    try {
      st.db.prepare("INSERT INTO jobs(job_id, repo, kind, status, pid, owner_session, skips, started_at) VALUES('job-live2', ?, 'count-fake', 'running', ?, 's', '[]', ?)").run(repo, other.pid ?? 0, Date.now());
      st.db.prepare("INSERT INTO job_files(job_id, repo, path, digest) VALUES('job-live2', ?, 'harness/src/a.ts', ?)").run(repo, digestOf(join(repo, 'harness/src/a.ts')));
      const before = ran;
      assert.equal(await runJob(st, 'job-live2', envOf(stateDir), HARNESS_ROOT), 'taken');
      assert.equal(ran, before, 'a second worker ran a job a live worker holds');
    } finally { st.close(); other.kill(); }
  });

  it('takes over a job only while its row is as read: of two workers spawned for one job, one runs it', { timeout: 30000 }, async () => {
    const { repo, stateDir } = contour({ 'harness/src/a.ts': 'a\n' });
    const other = spawn('sleep', ['30'], { stdio: 'ignore' });
    const st = State.open(stateDir);
    try {
      st.db.prepare("INSERT INTO jobs(job_id, repo, kind, status, owner_session, skips, started_at) VALUES('job-cas', ?, 'count-fake', 'claimed', 's', '[]', 0)").run(repo);
      st.db.prepare("INSERT INTO job_files(job_id, repo, path, digest) VALUES('job-cas', ?, 'harness/src/a.ts', ?)").run(repo, digestOf(join(repo, 'harness/src/a.ts')));
      let calls = 0;
      // runJob reads the row first and the clock next: the first read of the clock falls between the read and the take-over.
      const now = (): number => { if (++calls === 1) st.db.prepare("UPDATE jobs SET status = 'running', pid = ?, started_at = ? WHERE job_id = 'job-cas'").run(other.pid ?? 0, Date.now()); return Date.now(); };
      const before = ran;
      assert.equal(await runJob(st, 'job-cas', envOf(stateDir), HARNESS_ROOT, now), 'taken');
      assert.equal(ran, before, 'two workers ran one job');
    } finally { st.close(); other.kill(); }
  });

  it('renews its heartbeat before each file, so the TTL never hands a job its live worker still runs to another', { timeout: 30000 }, async () => {
    const { repo, stateDir } = contour({ 'harness/src/a.ts': 'a\n', 'harness/src/b.ts': 'b\n', 'harness/src/c.ts': 'c\n' });
    const { root, marker } = fakeRoot('ttl-root');
    let clock = 1e12; const now = (): number => clock;
    const st = State.open(stateDir);
    try {
      threeFileJob(st, 'job-ttl', repo, 'hook-fake');
      let seen = '';
      during = async (path) => { if (path.endsWith('c.ts')) seen = await awaitJob(st, 'job-ttl', envOf(stateDir), root, now, 0); clock += 10 * 60_000; };
      assert.equal(await runJob(st, 'job-ttl', envOf(stateDir), HARNESS_ROOT, now), 'done');
      assert.equal(seen, 'taken');
      await sleep(500);
      assert.equal(lines(marker).length, 0, 'a Stop 20 minutes into a live run handed its job to a second worker');
    } finally { during = async () => {}; st.close(); }
  });

  for (const [at, checked] of [['b', ['a', 'b']], ['c', ['a', 'b', 'c']]] as const) {
    it(`stops without closing a job another worker took over during file ${at}, so it is not marked done under that worker`, { timeout: 30000 }, async () => {
      const { repo, stateDir } = contour({ 'harness/src/a.ts': 'a\n', 'harness/src/b.ts': 'b\n', 'harness/src/c.ts': 'c\n' });
      const other = spawn('sleep', ['30'], { stdio: 'ignore' });
      const st = State.open(stateDir);
      const seen: string[] = [];
      try {
        threeFileJob(st, `job-lost-${at}`, repo, 'hook-fake');
        during = async (path) => { seen.push(path.slice(-4, -3)); if (path.endsWith(`${at}.ts`)) st.db.prepare("UPDATE jobs SET status = 'running', pid = ?, started_at = ? WHERE job_id = ?").run(other.pid ?? 0, Date.now(), `job-lost-${at}`); };
        assert.equal(await runJob(st, `job-lost-${at}`, envOf(stateDir), HARNESS_ROOT), 'taken');
        assert.deepEqual({ ...st.db.prepare('SELECT status, pid FROM jobs WHERE job_id = ?').get(`job-lost-${at}`) }, { status: 'running', pid: other.pid });
        assert.deepEqual(seen, checked, 'the worker kept checking files of a job it had lost');
      } finally { during = async () => {}; st.close(); other.kill(); }
    });
  }

  it('replaces a worker that died after taking its job no faster than once per ORPHAN_CLAIM_MS', { timeout: 30000 }, async () => {
    const { repo, stateDir } = contour({ 'harness/src/a.ts': 'a\n' });
    const root = join(sb.dir, 'crash-root'); const marker = join(sb.dir, 'crash-root.log');
    mkdirSync(join(root, 'src', 'jobs'), { recursive: true });
    writeFileSync(join(root, 'src', 'jobs', 'worker.ts'), `import { DatabaseSync } from 'node:sqlite';\nimport { appendFileSync } from 'node:fs';\nconst db = new DatabaseSync(process.env.CLAUDE_STATE_DIR + '/harness.db');\ndb.exec('PRAGMA busy_timeout = 3000');\ndb.prepare("UPDATE jobs SET status = 'running', pid = ?, started_at = ? WHERE job_id = ?").run(process.pid, Date.now(), process.argv[2]);\nappendFileSync(${JSON.stringify(marker)}, process.argv[2] + '\\n');\nprocess.exit(1);\n`);
    const st = State.open(stateDir);
    try {
      st.db.prepare("INSERT INTO jobs(job_id, repo, kind, status, owner_session, skips, started_at) VALUES('job-crash', ?, 'count-fake', 'claimed', 's', '[]', 0)").run(repo);
      assert.equal(await awaitJob(st, 'job-crash', envOf(stateDir), root, Date.now, Math.min(2500, ORPHAN_CLAIM_MS - 1000)), 'taken');
      await sleep(300);
      assert.equal(lines(marker).length, 1, `a job whose worker kept dying got ${lines(marker).length} workers inside one ORPHAN_CLAIM_MS`);
    } finally { st.close(); }
  });

  it('never queues a file again while a job someone holds still has it', { timeout: 30000 }, async () => {
    const { repo, stateDir } = contour({ 'harness/src/a.ts': 'a\n', 'harness/src/b.ts': 'b\n', 'harness/src/c.ts': 'c\n' });
    for (const f of ['a', 'b', 'c']) writeFileSync(join(repo, `harness/src/${f}.ts`), `export const ${f} = 1;\n`);
    inflightRepo = repo; inflightRuns.length = 0;
    const only = { spawnWorker: false, checkerFilter: (x: string) => x === 'inflight-fake' };
    const st = State.open(stateDir);
    try {
      await sweep(ctxOf(repo, stateDir, 'post'), st, only);
      const first = claimed(st, repo);
      const w1 = runJob(st, first, envOf(stateDir), HARNESS_ROOT);
      await sleep(900);
      await sweep(ctxOf(repo, stateDir, 'post'), st, only);
      const more = (st.db.prepare('SELECT job_id FROM jobs WHERE repo = ? AND job_id != ?').all(repo, first) as Array<{ job_id: string }>).map((j) => j.job_id);
      await Promise.all([w1, ...more.map((j) => runJob(st, j, envOf(stateDir), HARNESS_ROOT))]);
      assert.deepEqual([...inflightRuns].sort(), ['harness/src/a.ts', 'harness/src/b.ts', 'harness/src/c.ts'], 'a file of a running job was queued and checked a second time');
    } finally { inflightRepo = ''; st.close(); }
  });

  for (const [name, left] of [['no worker came for', { status: 'claimed', pid: null, started_at: 0 }], ['whose worker died', { status: 'running', pid: spawnSync('true').pid, started_at: 1 }]] as const) {
    it(`lets the next post start a job ${name}`, { timeout: 60000 }, async () => {
      const { repo, stateDir } = contour({ 'harness/test/ok.test.ts': SLOW(10) });
      writeFileSync(join(repo, 'harness/src/main.ts'), 'export const y = 2;\n');
      const { root, marker } = fakeRoot(`post-root-${name.split(' ')[0]}`);
      await withoutProcessKill(async () => {
        const st = State.open(stateDir);
        try {
          await sweep(ctxOf(repo, stateDir, 'stop', root), st, { spawnWorker: false, checkerFilter: (x) => x === NAME });
          const job = claimed(st, repo);
          st.db.prepare('UPDATE jobs SET status = ?, pid = ?, started_at = ? WHERE job_id = ?').run(left.status, left.pid, left.started_at, job);
          await sweep(ctxOf(repo, stateDir, 'post', root), st, { checkerFilter: (x) => x === NAME });
          assert.ok(await spawned(marker, job), `a job ${name} waited for the next Stop`);
        } finally { st.close(); }
      });
    });
  }
});

describe('contour-suite lock and cache', () => {
  const plain = (stateDir: string, deadlineMs = 30000): CheckContext => ({ env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: sb.home }, stateDir, now: Date.now, deadlineMs });
  const fileOf = (repo: string, path = 'harness/src/main.ts'): ChangedFile => ({ repo, path, absPath: join(repo, path), digest: '0', status: 'M' });

  it('takes over a lock whose recorded holder is dead instead of waiting it out', { timeout: 60000 }, async () => {
    const { repo, stateDir } = contour({ 'harness/test/ok.test.ts': SLOW(10) });
    const lock = lockOf(stateDir, repo);
    mkdirSync(lock, { recursive: true });
    writeFileSync(`${lock}.pid`, String(spawnSync('true').pid));
    const t0 = Date.now();
    const r = await withoutProcessKill(() => run(fileOf(repo), plain(stateDir)));
    assert.equal(r.verdict, 'pass');
    assert.ok(Date.now() - t0 < 15000, `waited ${Date.now() - t0} ms on a dead holder`);
    assert.equal(existsSync(lock), false);
    assert.equal(existsSync(`${lock}.pid`), false);
  });

  it('does not take a live lock for dead because an older holder record lies beside it', { timeout: 60000 }, async () => {
    const runs = join(sb.dir, 'stale-pid-runs.log');
    const { repo, stateDir } = contour({ 'harness/test/p.test.ts': `import { it } from 'node:test';\nimport { appendFileSync } from 'node:fs';\nit('p', () => { appendFileSync(${JSON.stringify(runs)}, 'run\\n'); });\n` });
    const lock = lockOf(stateDir, repo);
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(`${lock}.pid`, String(spawnSync('true').pid));
    const old = new Date(Date.now() - 20 * 60_000); utimesSync(`${lock}.pid`, old, old);
    mkdirSync(lock);
    const r = await withoutProcessKill(() => run(fileOf(repo), plain(stateDir, 3000)));
    assert.equal(r.transient, 'unstarted', JSON.stringify(r));
    assert.equal(lines(runs).length, 0, 'a lock an older harness holds was taken for dead by the record of an earlier holder');
    assert.equal(existsSync(lock), true);
  });

  it('keeps the lock directory empty while a run holds it, so a harness that knows only rmdir removes a stale one', { timeout: 60000 }, async () => {
    const seenLog = join(sb.dir, 'lock-seen.log');
    const { repo, stateDir } = contour({});
    const lock = lockOf(stateDir, repo);
    mkdirSync(join(repo, 'harness/test'), { recursive: true });
    writeFileSync(join(repo, 'harness/test/lock.test.ts'), `import { it } from 'node:test';\nimport { appendFileSync, existsSync, readdirSync } from 'node:fs';\nit('sees the lock', () => { appendFileSync(${JSON.stringify(seenLog)}, JSON.stringify({ entries: readdirSync(${JSON.stringify(lock)}), holder: existsSync(${JSON.stringify(`${lock}.pid`)}) }) + '\\n'); });\n`);
    assert.equal((await withoutProcessKill(() => run(fileOf(repo), plain(stateDir)))).verdict, 'pass');
    assert.deepEqual(lines(seenLog).map((l) => JSON.parse(l)), [{ entries: [], holder: true }]);
  });

  it('caches the verdict of a tree with an input dated in the future after one run', { timeout: 60000 }, async () => {
    const runs = join(sb.dir, 'future-runs.log');
    const { repo, stateDir } = contour({ 'graph/note.md': '# n\n', 'harness/test/ok.test.ts': `import { it } from 'node:test';\nimport { appendFileSync } from 'node:fs';\nit('ok', () => { appendFileSync(${JSON.stringify(runs)}, 'run\\n'); });\n` });
    const future = new Date(Date.now() + 3600_000);
    utimesSync(join(repo, 'graph/note.md'), future, future);
    const r = await withoutProcessKill(() => run(fileOf(repo), plain(stateDir, 8000)));
    assert.equal(r.verdict, 'pass', `an input from the future read as a change during every run: ${JSON.stringify(r)}`);
    assert.equal(lines(runs).length, 1);
    assert.equal((await withoutProcessKill(() => run(fileOf(repo), plain(stateDir, 8000)))).verdict, 'pass');
    assert.equal(lines(runs).length, 1, 'the verdict was not cached');
  });

  it('reports a run the lock wait or re-runs of a moving tree cut short as unstarted, not as the suite timing out', { timeout: 60000 }, async () => {
    const { repo, stateDir } = contour({ 'harness/src/lib.ts': 'export const v = 0;\n', 'harness/test/p.test.ts': "import { it } from 'node:test';\nit('p', async () => { await new Promise((r) => setTimeout(r, 2000)); });\n" });
    const lib = join(repo, 'harness/src/lib.ts');
    spawn('sh', ['-c', `sleep 1; printf 'export const v = 1;\\n' > '${lib}'; sleep 2.2; printf 'export const v = 2;\\n' > '${lib}'`], { detached: true, stdio: 'ignore' }).unref();
    const r = await withoutProcessKill(() => run(fileOf(repo, 'harness/src/lib.ts'), plain(stateDir, 6000)));
    assert.notEqual(r.transient, 'timeout', `a 2 s suite was recorded as timing out: ${JSON.stringify(r)}`);
  });

  it('queues a worker check again that was left unstarted, and still defers one that timed out on its full budget', async () => {
    const { repo, stateDir } = contour({});
    writeFileSync(join(repo, 'harness/src/main.ts'), 'export const y = 2;\n');
    const suite = CHECKERS.find((c) => c.name === NAME)!;
    const file: ChangedFile = { repo, path: 'harness/src/main.ts', absPath: join(repo, 'harness/src/main.ts'), digest: digestOf(join(repo, 'harness/src/main.ts')), status: 'M' };
    const outcome = async (transient: 'unstarted' | 'timeout'): Promise<{ queued: number; deferred: number }> => withoutProcessKill(async () => {
      const st = State.open(stateDir);
      try {
        st.db.exec('DELETE FROM jobs; DELETE FROM job_files; DELETE FROM verified; DELETE FROM findings');
        recordResult(st, file, NAME, verdictGeneration(generation(HARNESS_ROOT), suite, repo), { verdict: 'unknown', missing_reason: 'x', transient }, Date.now(), 600_000);
        const out = await sweep(ctxOf(repo, stateDir, 'post'), st, { spawnWorker: false, checkerFilter: (x) => x === NAME });
        return { queued: (st.db.prepare('SELECT count(*) c FROM jobs WHERE repo = ?').get(repo) as { c: number }).c, deferred: out.deferred };
      } finally { st.close(); }
    });
    assert.deepEqual(await outcome('unstarted'), { queued: 1, deferred: 0 }, 'an unstarted suite verdict was deferred for good');
    assert.deepEqual(await outcome('timeout'), { queued: 0, deferred: 1 });
  });

  it('never caches a verdict for a tree that an edit left and came back to inside one run', { timeout: 90000 }, async () => {
    const { repo, stateDir } = contour({ 'harness/src/lib.ts': 'export const two = 1;\n', 'harness/test/lib.test.ts': "import { it } from 'node:test';\nimport assert from 'node:assert/strict';\nit('two', async () => { await new Promise((r) => setTimeout(r, 1000)); const { two } = await import('../src/lib.ts'); await new Promise((r) => setTimeout(r, 2500)); assert.equal(two, 2); });\n" });
    const ctx = plain(stateDir, Infinity);
    const file = fileOf(repo, 'harness/src/lib.ts');
    const red = suiteGeneration(repo); const lib = join(repo, 'harness/src/lib.ts');
    spawn('sh', ['-c', `sleep 0.5; printf 'export const two = 2;\\n' > '${lib}'; sleep 2; printf 'export const two = 1;\\n' > '${lib}'`], { detached: true, stdio: 'ignore' }).unref();
    await withoutProcessKill(() => run(file, ctx));
    assert.equal(suiteGeneration(repo), red);
    assert.notEqual((await withoutProcessKill(() => run(file, ctx))).verdict, 'pass', 'the red tree was answered from a run that read the transient green edit');
  });
});
