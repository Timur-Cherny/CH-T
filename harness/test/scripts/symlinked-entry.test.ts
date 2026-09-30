// INVARIANT: an entry point of the harness behaves the same whatever path it was reached by — through a symlinked
// directory it prints the same stdout, the same stderr and exits with the same code as through its real path, and
// every module that can be started as a program decides that with isMainModule, never with a comparison of its own.
// It broke silently: ~/.claude/harness is a symlink, import.meta.url is the real path and argv[1] the typed one, so
// twelve copies of the guard skipped main() and exited 0 with no output. For due.ts, whose contract is «silence
// means nothing is due», that read as an all-clear while three rules were overdue; one copy had been repaired
// by hand, the other eleven had not.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sandbox, payload, HARNESS_ROOT, NODE_BIN } from '../_env.ts';
import '../../src/checks/index.ts';
import { isMainModule } from '../../src/is-main.ts';
import { sweep } from '../../src/sweep.ts';
import { State } from '../../src/state.ts';

const sb = sandbox('harness-symlinked-entry-');
after(() => sb.cleanup());
const LINKED = join(sb.dir, 'linked-harness');
symlinkSync(HARNESS_ROOT, LINKED);
const EMPTY = join(sb.dir, 'empty'); mkdirSync(EMPTY);
const ENV = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir };

// A call that is loud on purpose: silence could not be told from main() that never ran.
const LOUD: Record<string, string[]> = {
  'scripts/due.ts': ['--bogus'],
  'scripts/friction-prefilter.ts': ['--bogus'],
  'scripts/readme-inventory.ts': ['--bogus'],
  'scripts/toolchain.ts': ['--bogus'],
  'scripts/export.ts': [],
  'scripts/change-facts.ts': [],
  'scripts/code-metrics.ts': [],
  'scripts/shell-replay.ts': ['--root', EMPTY, '--days', '1'],
  'scripts/data-answers.ts': [],
  'scripts/memory-prefilter.ts': [],
  'scripts/telemetry-recount.ts': ['--bogus'],
  'src/main.ts': ['bogus-event'],
};
// Tools of the author's own tree: a public export leaves them out (harness.export.json), and only their absence is allowed.
const OPTIONAL: ReadonlySet<string> = new Set(['scripts/readme-inventory.ts', 'scripts/data-answers.ts', 'scripts/memory-prefilter.ts']);
const present = (rel: string): boolean => !OPTIONAL.has(rel) || existsSync(join(HARNESS_ROOT, rel));
// Entry points this file cannot call loudly; each has its own case below or a reason not to be run at all.
const ELSEWHERE: Record<string, string> = {
  'scripts/vendor.ts': 'main() rewrites VENDOR.lock of the repository — never run from a test',
  'src/jobs/worker.ts': 'silent by design — proved by the state of its job',
  'src/session/git-freshness.ts': 'silent by design — proved by the row it writes',
};

function start(root: string, rel: string, args: string[], env: Record<string, string> = ENV): { rc: number | null; stdout: string; stderr: string } {
  const r = spawnSync(NODE_BIN, ['--disable-warning=ExperimentalWarning', join(root, rel), ...args], { encoding: 'utf8', env, input: '', timeout: 60000 });
  return { rc: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('isMainModule', () => {
  const real = join(HARNESS_ROOT, 'src', 'is-main.ts');
  it('is true for the real path and for the same file reached through a symlinked directory or a symlinked file', () => {
    const fileLink = join(sb.dir, 'is-main-link.ts'); symlinkSync(real, fileLink);
    assert.deepEqual([real, join(LINKED, 'src', 'is-main.ts'), fileLink].map((p) => isMainModule(pathToFileURL(real).href, p)), [true, true, true]);
  });
  it('is false for another file, for no argv[1] at all and for a path that does not exist — and never throws', () => {
    const url = pathToFileURL(real).href;
    assert.deepEqual([join(HARNESS_ROOT, 'src', 'git.ts'), undefined, join(sb.dir, 'gone.ts')].map((p) => isMainModule(url, p)), [false, false, false]);
    assert.equal(isMainModule('not a url', real), false);
  });
});

describe('an entry point reached through a symlinked directory', () => {
  for (const [rel, args] of Object.entries(LOUD)) {
    it(`${rel} answers exactly as it does by its real path`, { skip: !present(rel) && 'not in this tree' }, () => {
      const direct = start(HARNESS_ROOT, rel, args);
      assert.ok(direct.rc !== 0 || direct.stdout.length > 0, `the probe call must be loud by the real path, got ${JSON.stringify(direct)}`);
      assert.deepEqual(start(LINKED, rel, args), direct, 'Miss this and the tool exits 0 in silence — for a checker that means «nothing to report»');
    });
  }

  it('the detached worker runs its job when the harness root it was given is a symlink', async () => {
    const repo = join(sb.dir, 'repo'); mkdirSync(repo);
    const git = (...a: string[]): void => { execFileSync('git', a, { cwd: repo, env: { ...process.env, HOME: sb.home, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }); };
    writeFileSync(join(repo, 'tsconfig.json'), '{}\n'); writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
    git('init', '-q'); git('add', '.'); git('commit', '-qm', 'base');
    writeFileSync(join(repo, 'a.ts'), 'export const a = 2;\n');
    const st = State.open(sb.stateDir);
    const env = { ...ENV, HARNESS_ROOT };
    const out = await sweep({ event: 'post', payload: payload('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'x' }, tool_use_id: 't1' }, repo) as never, env, root: HARNESS_ROOT, stateDir: sb.stateDir, now: Date.now }, st, { spawnWorker: false, checkerFilter: (n) => n === 'tsc-project' });
    assert.equal(out.pending, 1);
    const { job_id: jobId } = st.db.prepare('SELECT job_id FROM jobs').get() as { job_id: string };
    st.close();
    start(LINKED, 'src/jobs/worker.ts', [jobId], { ...ENV, HARNESS_ROOT: LINKED });
    const after = State.open(sb.stateDir);
    const status = (after.db.prepare('SELECT status FROM jobs WHERE job_id = ?').get(jobId) as { status: string }).status;
    after.close();
    assert.equal(status, 'done', 'Miss this and the job stays claimed for ever: Stop keeps waiting for a check no process will run');
  });

  it('the background fetch writes its row when it is started through a symlink', () => {
    const repo = join(sb.dir, 'fetched'); mkdirSync(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const stateDir = join(sb.dir, 'fetch-state');
    start(LINKED, 'src/session/git-freshness.ts', ['--fetch', repo, stateDir]);
    const st = State.open(stateDir);
    const rows = (() => { try { return (st.db.prepare('SELECT count(*) c FROM git_freshness').get() as { c: number }).c; } catch { return 0; } })();
    st.close();
    assert.equal(rows, 1, 'Miss this and «behind upstream» is never computed — the freshness gate reports nothing, which reads as up to date');
  });
});

describe('the guard has one home', () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []; });
  const sources = [...walk(join(HARNESS_ROOT, 'src')), ...walk(join(HARNESS_ROOT, 'scripts'))].map((p) => relative(HARNESS_ROOT, p));
  const entries = sources.filter((rel) => rel !== 'src/is-main.ts' && readFileSync(join(HARNESS_ROOT, rel), 'utf8').includes('isMainModule('));

  it('every module that can be started as a program is exercised here or named with the reason it is not', () => {
    assert.deepEqual(entries.sort(), [...Object.keys(LOUD), ...Object.keys(ELSEWHERE)].filter(present).sort(),
      'Miss this and the next script added to the harness is never started through the symlink it will be used by');
  });
});
