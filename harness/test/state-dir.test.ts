// INVARIANT: каталог состояния контура резолвится ОДИН раз на процесс и всегда абсолютен.
// Оба способа получить относительный путь закрыты здесь: пустая переменная (join('', …) → cwd)
// и отсутствующая переменная у потребителя, который дорезолвил её сам (`env.CLAUDE_STATE_DIR ?? ''`).
// Цена промаха — не падение, а расслоение: кэш проверок уезжает в cwd сессии, замок перестаёт
// сериализовать воркеры, «уже подтверждено» считается заново.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import '../src/main.ts'; // реестр гейтов должен быть заполнен до onlyGate
import { sandbox, onlyGate, HARNESS_ROOT, NODE_BIN } from './_env.ts';
import { State, resolveStateDir } from '../src/state.ts';
import { registerChecker } from '../src/checks/registry.ts';
import { runJob } from '../src/jobs/worker.ts';
import { digestOf } from '../src/sweep.ts';

const sb = sandbox('state-dir-');
let seen: string | null = null;
after(() => sb.cleanup());

describe('resolveStateDir', () => {
  it('treats an empty CLAUDE_STATE_DIR as absent — same as `:-` in bin/hook and `or` in the python hooks', () => {
    const home = join(sb.dir, 'h1');
    assert.equal(resolveStateDir({ CLAUDE_STATE_DIR: '', HOME: home }), join(home, '.claude', 'exec-telemetry'));
    assert.equal(resolveStateDir({ CLAUDE_STATE_DIR: '   ', HOME: home }), join(home, '.claude', 'exec-telemetry'));
    assert.equal(resolveStateDir({ HOME: home }), join(home, '.claude', 'exec-telemetry'));
  });

  it('refuses a relative CLAUDE_STATE_DIR instead of resolving it against cwd', () => {
    assert.throws(() => resolveStateDir({ CLAUDE_STATE_DIR: 'exec-telemetry', HOME: sb.home }), /абсолют/i);
    assert.throws(() => resolveStateDir({ CLAUDE_STATE_DIR: './state', HOME: sb.home }), /абсолют/i);
  });

  it('refuses to invent a path when neither CLAUDE_STATE_DIR nor HOME can give an absolute one', () => {
    assert.throws(() => resolveStateDir({}), /HOME/);
    assert.throws(() => resolveStateDir({ HOME: '' }), /HOME/);
    assert.throws(() => resolveStateDir({ HOME: 'relative/home' }), /HOME/);
  });

  it('keeps an absolute CLAUDE_STATE_DIR as given, trimmed', () => {
    assert.equal(resolveStateDir({ CLAUDE_STATE_DIR: sb.stateDir, HOME: sb.home }), sb.stateDir);
    assert.equal(resolveStateDir({ CLAUDE_STATE_DIR: ` ${sb.stateDir} `, HOME: sb.home }), sb.stateDir);
  });
});

describe('router with an empty CLAUDE_STATE_DIR', () => {
  it('writes nothing into cwd and puts the database under the home state dir', () => {
    const home = join(sb.dir, 'router-home');
    const cwd = join(sb.dir, 'router-cwd');
    mkdirSync(home, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const before = readdirSync(cwd).sort();

    const script = join(sb.dir, 'route-empty.ts');
    writeFileSync(script, [
      `import { route } from '${HARNESS_ROOT}/src/main.ts';`,
      `const env = JSON.parse(process.argv[2]);`,
      `const p = { session_id: 'sd-1', cwd: process.cwd(), hook_event_name: 'Stop' };`,
      `route('stop', p, env).then((v) => { console.log(JSON.stringify(v)); });`,
    ].join('\n'));

    const env = { PATH: '/usr/bin:/bin', HOME: home, CLAUDE_STATE_DIR: '', HARNESS_ROOT, ...onlyGate('sweep-stop') };
    const r = spawnSync(NODE_BIN, ['--disable-warning=ExperimentalWarning', script, JSON.stringify(env)], {
      cwd, env, encoding: 'utf8', timeout: 60000,
    });

    assert.deepEqual(readdirSync(cwd).sort(), before, `состояние уехало в cwd: ${r.stdout}${r.stderr}`);
    assert.ok(existsSync(join(home, '.claude', 'exec-telemetry', 'harness.db')),
      `база не появилась в домашнем каталоге состояния: ${r.stdout}${r.stderr}`);
    assert.doesNotMatch(r.stdout, /mkdir ''/, 'гейты упали на пустом пути вместо того, чтобы прочитать его как «переменной нет»');
  });
});

describe('worker drain', () => {
  it('hands the checker the state dir of the database it writes into, not a re-read of the environment', async () => {
    registerChecker({
      name: 'state-dir-probe', tier: 'worker', killSwitch: 'CLAUDE_SKIP_STATE_DIR_PROBE',
      applies: () => true,
      run: async (_f, ctx) => { seen = ctx.stateDir; return { verdict: 'pass' as const }; },
    });

    const stateDir = join(sb.dir, 'drain-state');
    const repo = join(sb.dir, 'drain-repo');
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, 'f.txt'), 'x');

    const st = State.open(stateDir);
    try {
      st.db.prepare("INSERT INTO jobs(job_id, repo, kind, status, skips, started_at) VALUES('j1', ?, 'state-dir-probe', 'claimed', '[]', 0)").run(repo);
      st.db.prepare('INSERT INTO job_files(job_id, repo, path, digest) VALUES(?,?,?,?)').run('j1', repo, 'f.txt', digestOf(join(repo, 'f.txt')));
      // ctx.env живого хука: CLAUDE_STATE_DIR не выставлен — settings.json его не задаёт, bin/hook не экспортирует.
      await runJob(st, 'j1', { HOME: sb.home } as NodeJS.ProcessEnv, HARNESS_ROOT);
      assert.equal(seen, stateDir);
    } finally { st.close(); }
  });
});
