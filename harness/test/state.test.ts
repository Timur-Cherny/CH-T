// INVARIANT I6: 8 сессий на одной базе не теряют и не двоят записи; claim атомарен; порядок PRAGMA
// (busy_timeout первым) даёт 0 «database is locked» при параллельном открытии свежей базы.
// Молча ломалось: capture-commits без замка писал журнал и снимал чужой lock (capture-commits-lock.test.sh).
// Второй инвариант того же класса: перевод журнала в WAL — единственный шаг открытия, который
// busy_timeout НЕ покрывает (SQLite отвечает BUSY сразу), поэтому открытие обязано его переждать само.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { State, SCHEMA_VERSION } from '../src/state.ts';
import { sandbox, NODE_BIN, HARNESS_ROOT } from './_env.ts';

describe('State', () => {
  const sb = sandbox();
  after(() => sb.cleanup());

  it('opens a fresh database with the schema and an explicit user_version', () => {
    const st = State.open(sb.stateDir);
    const ver = (st.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    assert.equal(ver, SCHEMA_VERSION);
    const tables = (st.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    for (const t of ['verified', 'jobs', 'findings', 'claims', 'stop_blocks', 'agent_window', 'markers']) assert.ok(tables.includes(t), t);
    st.close();
  });

  // The `verified` table exactly as schema v1 created it, with one row an older harness wrote.
  const V1 = `CREATE TABLE verified(repo TEXT, path TEXT, checker TEXT, digest TEXT, verdict TEXT CHECK(verdict IN ('pass','fail','unknown')), checker_gen TEXT, missing_reason TEXT, at INTEGER, PRIMARY KEY(repo, path, checker));
    INSERT INTO verified VALUES('/r', 'a.md', 'project-check', 'd1', 'unknown', 'g1', 'дедлайн синхронного яруса исчерпан', 1); PRAGMA user_version = 1;`;
  const columns = (st: State): string[] => (st.db.prepare('PRAGMA table_info(verified)').all() as { name: string }[]).map((c) => c.name);

  it('adds timed_out_after_ms to a v1 base and keeps its rows settled — an old unknown is not retried by a guess', () => {
    const sb3 = sandbox();
    const old = new DatabaseSync(join(sb3.stateDir, 'harness.db')); old.exec(V1); old.close();
    const st = State.open(sb3.stateDir);
    assert.ok(columns(st).includes('timed_out_after_ms'), 'Miss this and every sweep dies on «no such column» the moment the new harness meets the live base');
    assert.deepEqual({ ...(st.db.prepare('SELECT path, verdict, timed_out_after_ms FROM verified').get() as object) }, { path: 'a.md', verdict: 'unknown', timed_out_after_ms: null });
    assert.equal((st.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, SCHEMA_VERSION);
    st.close(); sb3.cleanup();
  });

  it('adds the evidence and queue columns to a base whose tables came from an earlier shape of the commits journal', () => {
    const sb3 = sandbox();
    const old = new DatabaseSync(join(sb3.stateDir, 'harness.db'));
    old.exec(`CREATE TABLE head_moves(repo TEXT, session_id TEXT, started_at INTEGER, ended_at INTEGER, PRIMARY KEY(repo, session_id, ended_at));
      CREATE TABLE pending_commits(repo TEXT, hash TEXT, due_at INTEGER, PRIMARY KEY(repo, hash)); PRAGMA user_version = 2;`);
    old.close();
    const st = State.open(sb3.stateDir);
    const cols = (t: string): string[] => (st.db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    assert.ok(cols('head_moves').includes('named'), 'Miss this and every post dies on «no column named named» against a base an earlier build created');
    for (const c of ['kind', 'moved_at', 'common']) assert.ok(cols('pending_commits').includes(c), `pending_commits.${c} missing — every Stop answers «запись отложена» forever`);
    st.close(); sb3.cleanup();
  });

  it('survives 12 processes migrating the same v1 base at once — exactly one ALTER wins, nobody fails', () => {
    const sb3 = sandbox(); const script = join(sb3.dir, 'open.ts');
    const old = new DatabaseSync(join(sb3.stateDir, 'harness.db')); old.exec('PRAGMA journal_mode = WAL'); old.exec(V1); old.close();
    writeFileSync(script, `import { State } from '${HARNESS_ROOT}/src/state.ts';\nconst st = State.open(process.argv[2]);\nst.close();\nconsole.log('ok');`);
    const par = spawnSync('sh', ['-c', `for i in $(seq 1 12); do "${NODE_BIN}" --disable-warning=ExperimentalWarning "${script}" "${sb3.stateDir}" & done; wait`], { encoding: 'utf8', timeout: 60000 });
    assert.equal((par.stdout.match(/ok/g) ?? []).length, 12, `Miss this and a hook that loses the race crashes instead of checking:\n${par.stderr}`);
    const st = State.open(sb3.stateDir);
    assert.equal(columns(st).filter((c) => c === 'timed_out_after_ms').length, 1);
    st.close(); sb3.cleanup();
  });

  it('grants a claim to exactly one of two claimants for the same (session, event, tool_use_id)', () => {
    const a = State.open(sb.stateDir); const b = State.open(sb.stateDir);
    const first = a.claim('s1', 'post', 'toolu_x'); const second = b.claim('s1', 'post', 'toolu_x');
    assert.deepEqual([first, second], [true, false]);
    assert.equal(a.claim('s1', 'post', 'toolu_y'), true);
    a.close(); b.close();
  });

  it('survives 16 processes opening a fresh database at once — zero "database is locked" (busy_timeout before WAL)', () => {
    const sb2 = sandbox(); const script = join(sb2.dir, 'open.ts');
    writeFileSync(script, `import { State } from '${HARNESS_ROOT}/src/state.ts';\nconst st = State.open(process.argv[2]);\nst.tx(() => st.db.prepare('INSERT INTO markers(key,value,at) VALUES(?,?,?)').run('p' + process.pid, 'x', 1));\nst.close();\nconsole.log('ok');`);
    const procs = Array.from({ length: 16 }, () => spawnSync(NODE_BIN, ['--disable-warning=ExperimentalWarning', script, sb2.stateDir], { encoding: 'utf8' }));
    // spawnSync последовательный; настоящую параллельность даёт sh с &:
    const par = spawnSync('sh', ['-c', `for i in $(seq 1 16); do "${NODE_BIN}" --disable-warning=ExperimentalWarning "${script}" "${sb2.stateDir}_par" & done; wait`], { encoding: 'utf8', timeout: 60000 });
    assert.equal(procs.filter((p) => p.status === 0).length, 16, procs.map((p) => p.stderr).join('\n'));
    assert.equal((par.stdout.match(/ok/g) ?? []).length, 16, par.stderr);
    const st = State.open(sb2.stateDir + '_par');
    assert.equal((st.db.prepare('SELECT count(*) c FROM markers').get() as { c: number }).c, 16);
    st.close(); sb2.cleanup();
  });

  it('waits out a foreign lock while switching the journal of a not-yet-WAL database instead of failing', async () => {
    const sb4 = sandbox();
    // Состояние, в котором падал Stop-хук: база создана, но в WAL ещё не переведена,
    // и чужая транзакция держит замок. busy_timeout здесь бесполезен: на смене журнала SQLite
    // не зовёт busy-handler и отвечает отказом сразу (замерено — 28 мс при busy_timeout 3000 мс).
    // Цена отказа — потерянная строка журнала коммитов.
    const holder = new DatabaseSync(join(sb4.stateDir, 'harness.db'));
    holder.exec('PRAGMA busy_timeout = 3000');
    holder.exec('CREATE TABLE IF NOT EXISTS probe(x)');
    holder.exec('BEGIN IMMEDIATE');
    holder.prepare('INSERT INTO probe(x) VALUES(1)').run();

    const script = join(sb4.dir, 'open.ts');
    writeFileSync(script, `import { State } from '${HARNESS_ROOT}/src/state.ts';\nconst st = State.open(process.argv[2]);\nst.close();\nconsole.log('ok');`);
    const child = spawn(NODE_BIN, ['--disable-warning=ExperimentalWarning', script, sb4.stateDir], { encoding: 'utf8' });
    let out = '';
    child.stdout.on('data', (b: Buffer) => { out += b; });
    child.stderr.on('data', (b: Buffer) => { out += b; });
    const release = setTimeout(() => { holder.exec('COMMIT'); holder.close(); }, 400);

    const [code] = (await once(child, 'close')) as [number];
    clearTimeout(release);
    assert.equal(code, 0, `открытие не пережило чужой замок — в бою это молча потерянное событие:\n${out}`);
    assert.match(out, /ok/);

    const after = State.open(sb4.stateDir);
    const mode = (after.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
    after.close();
    assert.equal(mode, 'wal', 'журнал так и не переведён в WAL');
    sb4.cleanup();
  });

  it('moves a corrupt file aside and starts empty — everything becomes unverified, never silently verified', () => {
    const sb3 = sandbox();
    writeFileSync(join(sb3.stateDir, 'harness.db'), 'this is not a database, definitely not');
    const st = State.open(sb3.stateDir);
    assert.equal((st.db.prepare('SELECT count(*) c FROM verified').get() as { c: number }).c, 0);
    st.close();
    assert.ok(readdirSync(sb3.stateDir).some((f) => f.startsWith('harness.db.corrupt-')), 'повреждённая база не отложена в сторону');
    assert.ok(existsSync(join(sb3.stateDir, 'harness.db')));
    sb3.cleanup();
  });

  it('rolls a failed transaction back completely', () => {
    const st = State.open(sb.stateDir);
    assert.throws(() => st.tx(() => { st.setMarker('k', 'v'); throw new Error('mid'); }), /mid/);
    assert.equal(st.marker('k'), null);
    st.close();
  });
});
