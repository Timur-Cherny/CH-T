// INVARIANT: one worker job type-checks a TypeScript project once, not once per file of it, while the job files of that
// project hold the content the run saw; and a job taken over after its worker died goes on from the first file without
// a settled verdict instead of starting over.
// REGRESSION 25.09 (README known defects, high on large projects): tsc-project ran a full `tsc -p` for every file of
// the job, so the Stop drain ran out on a large project, and the next worker repeated the files already verified.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { State } from '../../src/state.ts';
import { digestOf, recordResult } from '../../src/sweep.ts';
import { runJob } from '../../src/jobs/worker.ts';
import { generation } from '../../src/contour.ts';
import '../../src/checks/index.ts';
import { registerChecker } from '../../src/checks/registry.ts';
import { sandbox, HARNESS_ROOT } from '../_env.ts';
import { TS_PATH } from '../checks/_repo.ts';

const sb = sandbox('harness-worker-batch-');
after(() => sb.cleanup());
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: sb.home, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const runsOf = (log: string): number => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0);
const OPTS = { strict: true, noEmit: true, noLib: true, types: [], target: 'es2022', module: 'esnext', moduleResolution: 'bundler' };
const GLOBALS = ['Array<T>', 'Boolean', 'CallableFunction', 'Function', 'IArguments', 'NewableFunction', 'Number', 'Object', 'RegExp', 'String'].map((t) => `interface ${t} {}`).join('\n');
const BROKEN = "export const wrong: number = 'text';\n";
const TS_PACKAGE = dirname(dirname(TS_PATH));

/** The project's TypeScript is the real one behind an entry that logs every load: one load is one program built. */
function countedTypescript(project: string, log: string): void {
  const pkg = join(project, 'node_modules', 'typescript');
  mkdirSync(pkg, { recursive: true });
  symlinkSync(join(TS_PACKAGE, 'lib'), join(pkg, 'lib'));
  const { version } = JSON.parse(readFileSync(join(TS_PACKAGE, 'package.json'), 'utf8')) as { version: string };
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'typescript', version, main: 'counted.js' }));
  writeFileSync(join(pkg, 'counted.js'), `require('node:fs').appendFileSync(${JSON.stringify(log)}, 'run\\n');\nmodule.exports = require('./lib/typescript.js');\n`);
}

let seq = 0;
function fixture(files: Record<string, string>, projects: string[]): { repo: string; stateDir: string; logs: Record<string, string> } {
  const dir = join(sb.dir, `r${++seq}`);
  const logs: Record<string, string> = {};
  for (const p of projects) {
    logs[p] = join(sb.dir, `tsc-${seq}-${p.replace(/\W/g, '_')}.log`);
    files[join(p, 'tsconfig.json')] = JSON.stringify({ compilerOptions: OPTS, include: ['**/*.ts'] });
    files[join(p, 'globals.d.ts')] = `${GLOBALS}\n`;
  }
  for (const [rel, text] of Object.entries({ 'README.md': 'x\n', '.gitignore': 'node_modules\n', ...files })) { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); }
  for (const p of projects) countedTypescript(join(dir, p), logs[p]!);
  execFileSync('git', ['init', '-q'], { cwd: dir, env: gitEnv });
  return { repo: execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, env: gitEnv, encoding: 'utf8' }).trim(), stateDir: join(sb.dir, `st${seq}`), logs };
}
function job(st: State, id: string, repo: string, kind: string, paths: string[]): void {
  st.db.prepare("INSERT INTO jobs(job_id, repo, kind, status, owner_session, skips, started_at) VALUES(?, ?, ?, 'claimed', 's', '[]', 0)").run(id, repo, kind);
  for (const p of paths) st.db.prepare('INSERT INTO job_files(job_id, repo, path, digest) VALUES(?, ?, ?, ?)').run(id, repo, p, digestOf(join(repo, p)));
}
const verdicts = (st: State, repo: string, checker: string): Record<string, string> => Object.fromEntries((st.db.prepare('SELECT path, verdict FROM verified WHERE repo = ? AND checker = ? ORDER BY path').all(repo, checker) as Array<{ path: string; verdict: string }>).map((r) => [r.path, r.verdict]));
const env = { ...process.env, PATH: process.env.PATH ?? '/usr/bin:/bin' };

describe('worker job', () => {
  it('runs tsc once per project of the job and gives every file of the project the verdict of that run', async () => {
    const fx = fixture({ 'a/x.ts': 'export const x = 1;\n', 'a/y.ts': BROKEN, 'a/z.ts': 'export const z = 1;\n', 'b/w.ts': 'export const w = 1;\n' }, ['a', 'b']);
    const st = State.open(fx.stateDir);
    try {
      job(st, 'j-tsc', fx.repo, 'tsc-project', ['a/x.ts', 'a/y.ts', 'a/z.ts', 'b/w.ts']);
      await runJob(st, 'j-tsc', env, HARNESS_ROOT);
      assert.deepEqual({ a: runsOf(fx.logs.a), b: runsOf(fx.logs.b) }, { a: 1, b: 1 }, 'tsc ran once per file instead of once per project');
      assert.deepEqual(verdicts(st, fx.repo, 'tsc-project'), { 'a/x.ts': 'fail', 'a/y.ts': 'fail', 'a/z.ts': 'fail', 'b/w.ts': 'pass' });
      const msg = (st.db.prepare("SELECT message FROM findings WHERE path = 'a/z.ts'").get() as { message: string }).message;
      assert.match(msg, /^a\/z\.ts: tsc — новых ошибок 1 [^\n]*\n[^\n]*y\.ts\(1,14\): error TS2322/, 'the finding of a file names that file and carries the run output');
    } finally { st.close(); }
  });

  it('runs tsc again for the next file once a job file of the project changed after the run', async () => {
    const fx = fixture({ 'p/one.ts': 'export const one = 1;\n', 'p/two.ts': 'export const two = 2;\n', 'p/three.ts': 'export const three = 3;\n' }, ['p']);
    let hits = 0;
    const tsc = await import('../../src/checks/tsc-project.ts');
    registerChecker({
      name: 'batch-probe', tier: 'worker', killSwitch: 'CLAUDE_SKIP_BATCH_PROBE', applies: () => false,
      run: async (f, ctx) => { const r = await tsc.run(f, ctx); if (++hits === 1) writeFileSync(join(fx.repo, 'p/three.ts'), BROKEN); return r; },
    });
    const st = State.open(fx.stateDir);
    try {
      job(st, 'j-moved', fx.repo, 'batch-probe', ['p/one.ts', 'p/two.ts', 'p/three.ts']);
      await runJob(st, 'j-moved', env, HARNESS_ROOT);
      assert.deepEqual(verdicts(st, fx.repo, 'batch-probe'), { 'p/one.ts': 'pass', 'p/two.ts': 'fail' }, 'a run older than a job file of the project was reused');
      assert.equal(runsOf(fx.logs.p), 2);
    } finally { st.close(); }
  });

  it('goes on from the first file without a settled verdict when it takes over a job', async () => {
    const fx = fixture({ 'r/a.ts': 'a\n', 'r/b.ts': 'b\n', 'r/c.ts': 'c\n' }, []);
    const ran: string[] = [];
    registerChecker({ name: 'resume-probe', tier: 'worker', killSwitch: 'CLAUDE_SKIP_RESUME_PROBE', applies: () => false, run: async (f) => { ran.push(f.path); return { verdict: 'pass' }; } });
    const st = State.open(fx.stateDir);
    try {
      job(st, 'j-resume', fx.repo, 'resume-probe', ['r/a.ts', 'r/b.ts', 'r/c.ts']);
      const a = join(fx.repo, 'r/a.ts');
      recordResult(st, { repo: fx.repo, path: 'r/a.ts', absPath: a, digest: digestOf(a), status: 'M' }, 'resume-probe', generation(HARNESS_ROOT), { verdict: 'pass' }, 1);
      await runJob(st, 'j-resume', env, HARNESS_ROOT);
      assert.deepEqual(ran.sort(), ['r/b.ts', 'r/c.ts'], 'the new worker repeated a file the dead one had already verified');
    } finally { st.close(); }
  });
});
