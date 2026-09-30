// Порт hooks/spec/friction-classify.test.sh (15 кейсов) + окно агента (H7) + доковые пути (H6).
// Молча ломалось: classify считал `work-docs/sql/sample.sql` с NOT NULL за миграцию с констрейнтом
// (INC-FRICTION-DOC-AS-CONSTRAINT, класс К1 — regex по тексту), а окно диффа было общим для всех
// агентов сессии (INC-FRICTION-UNKNOWN-AGENTS: attribution всегда window).
// INVARIANT: уровень и след — функции диффа с начала окна агента; документ описывает гарантию, а не
// создаёт её; SQL виден только как AST (parseSql), TS — только как AST (compiler API проекта);
// нет парсера → trace_kind unknown + причина, никогда не none и не constraint.
// INVARIANT (перенос eb93275/04ef969 из замороженного bash): констрейнт и domain по .sql — только из пути миграции;
// guard — только подключённый предохранитель (файл из команды хука settings.json либо модуль реестра
// gates/index.ts харнесса, чей bin/hook стоит в команде). Путь hooks/ сам следа не даёт.
import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, appendFileSync, utimesSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { route } from '../src/main.ts';
import { State } from '../src/state.ts';
import '../src/friction.ts';
import { resolveTypescript, toolchainDir } from '../src/toolchain.ts';
import { sandbox, payload, runHook, NODE_BIN } from './_env.ts';
import type { Sandbox } from './_env.ts';

/** Пакет typescript для TS-кейсов: существующий пин CLAUDE_HARNESS_TS, иначе тулчейн харнесса. Нет обоих — кейс падает, а не пропускается. */
function findTypescript(): string | null {
  const cands: string[] = [];
  if (process.env.CLAUDE_HARNESS_TS) cands.push(dirname(dirname(process.env.CLAUDE_HARNESS_TS)));
  const tc = resolveTypescript(process.env);
  if (tc.path) cands.push(dirname(dirname(tc.path)));
  return cands.find((c) => existsSync(join(c, 'package.json'))) ?? null;
}
const TS_LIB = findTypescript();
const itTs = it;

function sh(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
}
let seq = 0;
function mkRepo(sb: Sandbox, withTs = false): string {
  const repo = join(sb.dir, `repo${seq++}`); mkdirSync(repo, { recursive: true });
  sh(repo, 'init', '-q'); writeFileSync(join(repo, 'README.md'), 'base\n'); sh(repo, 'add', '-A'); sh(repo, 'commit', '-qm', 'init');
  appendFileSync(join(repo, '.git', 'info', 'exclude'), 'node_modules\n');
  if (withTs) {
    if (!TS_LIB) throw new Error('typescript для TS-кейсов не найден: ~/.claude/harness/bin/run scripts/toolchain.ts --install');
    mkdirSync(join(repo, 'node_modules')); symlinkSync(TS_LIB, join(repo, 'node_modules', 'typescript'));
  }
  return repo;
}
function write(repo: string, rel: string, text: string): void { mkdirSync(dirname(join(repo, rel)), { recursive: true }); writeFileSync(join(repo, rel), text); }
// The sweep kill-switch stays on: whatever else subscribes to subagent events, only friction is under test here.
function env(sb: Sandbox, extra: Record<string, string> = {}): Record<string, string> { return { HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, CLAUDE_SKIP_TREE_SWEEP: '1', ...extra }; }
// Своя сессия на каждый тест: корни сессии и окна агентов живут в общей базе и иначе перетекают между тестами.
let sessSeq = 0; let session = 'session-0';
const newSession = (): void => { session = `session-${++sessSeq}`; };
let agentSeq = 0;
const agent = (): string => `agent-${++agentSeq}`;
async function start(sb: Sandbox, cwd: string, id: string, extra: Record<string, unknown> = {}) {
  return route('agent-start', payload('SubagentStart', { session_id: session, agent_id: id, agent_type: 'worker', ...extra }, cwd) as never, env(sb));
}
async function stop(sb: Sandbox, cwd: string, id: string, extra: Record<string, unknown> = {}, e: Record<string, string> = {}) {
  return route('agent-stop', payload('SubagentStop', { session_id: session, agent_id: id, agent_type: 'worker', ...extra }, cwd) as never, env(sb, e));
}
async function toolWrite(sb: Sandbox, repo: string, rel: string, text: string, agentId?: string) {
  write(repo, rel, text);
  return route('post', payload('PostToolUse', { session_id: session, tool_name: 'Write', tool_input: { file_path: join(repo, rel) }, tool_use_id: `toolu_w${++callSeq}`, ...(agentId ? { agent_id: agentId, agent_type: 'worker' } : {}) }, repo) as never, env(sb));
}
let callSeq = 0;
/** An agent's Bash call: pre-bash, whatever `body` does to the tree, then post (unless the call never gets one). */
async function bash(sb: Sandbox, repo: string, agentId: string | undefined, body: () => void | Promise<void>, opts: { background?: boolean; post?: boolean; id?: string | null } = {}) {
  const id = opts.id === null ? undefined : opts.id ?? `toolu_b${++callSeq}`;
  const who = agentId ? { agent_id: agentId, agent_type: 'worker' } : {};
  const input = { command: 'true', ...(opts.background ? { run_in_background: true } : {}) };
  const pre = await route('pre-bash', payload('PreToolUse', { session_id: session, tool_name: 'Bash', tool_input: input, ...(id ? { tool_use_id: id } : {}), ...who }, repo) as never, env(sb));
  await body();
  const post = opts.post === false ? null : await route('post', payload('PostToolUse', { session_id: session, tool_name: 'Bash', tool_input: input, ...(id ? { tool_use_id: id } : {}), ...who }, repo) as never, env(sb));
  return { pre, post };
}
type Ev = Record<string, unknown>;
function events(sb: Sandbox): Ev[] {
  const p = join(sb.home, '.claude', 'exec-telemetry', 'personal-friction.jsonl');
  return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Ev) : [];
}
function last(sb: Sandbox): Ev { const e = events(sb); assert.ok(e.length, 'no friction event written'); return e[e.length - 1]; }

describe('friction: level by diff (port of friction-classify.test.sh)', () => {
  const sb = sandbox('harction-');
  after(() => sb.cleanup());
  beforeEach(newSession);

  it('reports no_change with scope none on a clean tree instead of inventing a level, and stays silent', async () => {
    const repo = mkRepo(sb);
    const v = await stop(sb, repo, agent());
    assert.equal(v.kind, 'silent');
    const e = last(sb);
    assert.equal(e.friction_state, 'no_change'); assert.equal(e.scope, 'none'); assert.equal(e.trace_kind, 'none'); assert.equal(e.files_changed, 0);
  });
  it('rates one file in one root as function', async () => {
    const repo = mkRepo(sb); write(repo, 'src/a.py', 'x=1\n');
    await stop(sb, repo, agent());
    assert.equal(last(sb).scope, 'function');
  });
  it('rates more than three files as module', async () => {
    const repo = mkRepo(sb); for (let i = 1; i <= 5; i++) write(repo, `src/f${i}.py`, `x=${i}\n`);
    await stop(sb, repo, agent());
    assert.equal(last(sb).scope, 'module');
  });
  it('rates a migration under src/ as domain, but a migration that only adds a column carries no trace and is not sufficient', async () => {
    const repo = mkRepo(sb); write(repo, 'src/migrations/001.sql', 'ALTER TABLE t ADD COLUMN c int;\n');
    await stop(sb, repo, agent());
    const e = last(sb);
    assert.equal(e.scope, 'domain');
    assert.notEqual(e.trace_kind, 'constraint');
    assert.equal(e.trace_kind, 'none');
    assert.equal(e.safeguard_sufficient, false);
  });
  it('rates a migration with ADD CONSTRAINT UNIQUE as domain/constraint and a sufficient safeguard', async () => {
    const repo = mkRepo(sb); write(repo, 'src/migrations/002.sql', 'ALTER TABLE t ADD CONSTRAINT t_uniq UNIQUE (a, b);\n');
    const v = await stop(sb, repo, agent());
    assert.equal(v.kind, 'silent');
    const e = last(sb);
    assert.equal(e.scope, 'domain'); assert.equal(e.trace_kind, 'constraint'); assert.equal(e.safeguard_sufficient, true);
  });
  it('does not take a NOT NULL column for a constraint trace — a new column is not a guarantee (SPEC: CHECK/UNIQUE/INDEX/FK)', async () => {
    const repo = mkRepo(sb); write(repo, 'src/migrations/003.sql', 'ALTER TABLE t ADD COLUMN c int NOT NULL DEFAULT 0;\n');
    await stop(sb, repo, agent());
    assert.equal(last(sb).trace_kind, 'none');
  });
  it('does not take SQL words inside a code string for a constraint — the classifier no longer measures its own source (К1)', async () => {
    const repo = mkRepo(sb); write(repo, 'src/a.py', 'CONSTRAINT = "add constraint|unique|not null"\n');
    await stop(sb, repo, agent());
    assert.notEqual(last(sb).trace_kind, 'constraint'); assert.equal(last(sb).scope, 'function');
  });
  it('does not take a SQL string in a non-migration TS file for a constraint — only queryRunner.query literals inside migrations count', async () => {
    const repo = mkRepo(sb); write(repo, 'src/repo.ts', "export const q = 'ALTER TABLE t ADD CONSTRAINT u UNIQUE (a)';\n");
    await stop(sb, repo, agent());
    assert.equal(last(sb).trace_kind, 'none'); assert.equal(last(sb).scope, 'function');
  });
  itTs('reads CREATE UNIQUE INDEX out of a queryRunner.query literal in a TS migration via the TS-AST and SQL-AST — domain/constraint', async () => {
    const repo = mkRepo(sb, true);
    write(repo, 'src/migrations/1725000000000-serial-unique.ts', [
      "import { MigrationInterface, QueryRunner } from 'typeorm';",
      'export class SerialUnique1725000000000 implements MigrationInterface {',
      '  public async up(queryRunner: QueryRunner): Promise<void> {',
      '    await queryRunner.query(`CREATE UNIQUE INDEX "units_serial_uniq" ON "units" ("serial_id") WHERE quantity > 0`);',
      '  }',
      '  public async down(queryRunner: QueryRunner): Promise<void> { await queryRunner.query(`DROP INDEX "units_serial_uniq"`); }',
      '}', ''].join('\n'));
    const v = await stop(sb, repo, agent());
    assert.equal(v.kind, 'silent', JSON.stringify(v));
    const e = last(sb);
    assert.equal(e.scope, 'domain'); assert.equal(e.trace_kind, 'constraint'); assert.equal(e.safeguard_sufficient, true);
  });
  itTs('ignores a constraint that lives only in a comment of a TS migration — a comment is not a statement', async () => {
    const repo = mkRepo(sb, true);
    write(repo, 'src/migrations/1725000000001-note.ts', [
      '// ALTER TABLE t ADD CONSTRAINT t_uniq UNIQUE (a, b) — сделать в следующей миграции',
      'export class Note1725000000001 { public async up(queryRunner: { query(s: string): Promise<void> }): Promise<void> { await queryRunner.query(`ALTER TABLE t ADD COLUMN c int`); } }', ''].join('\n'));
    await stop(sb, repo, agent());
    assert.equal(last(sb).scope, 'domain'); assert.equal(last(sb).trace_kind, 'none');
  });
  it('falls back to the harness toolchain when the CLAUDE_HARNESS_TS pin points into a deleted worktree', async () => {
    const repo = mkRepo(sb); write(repo, 'src/a.spec.ts', 'expect(1).toBe(1);\n');
    await stop(sb, repo, agent(), {}, { CLAUDE_HARNESS_TS: '/gone/worktree/node_modules/typescript/lib/typescript.js', CLAUDE_HARNESS_TOOLCHAIN: toolchainDir(process.env) ?? '' });
    assert.equal(last(sb).trace_kind, 'assertion');
  });
  it('answers unknown, not none, when the pin is rotten and no toolchain is reachable', async () => {
    const repo = mkRepo(sb); write(repo, 'src/b.spec.ts', 'expect(1).toBe(1);\n');
    await stop(sb, repo, agent(), {}, { CLAUDE_HARNESS_TS: '/gone/worktree/node_modules/typescript/lib/typescript.js' });
    assert.equal(last(sb).trace_kind, 'unknown');
  });
  itTs('rates a spec file whose added lines carry a live expect() as assertion', async () => {
    const repo = mkRepo(sb, true); write(repo, 'src/a.spec.ts', 'expect(1).toBe(1);\n');
    await stop(sb, repo, agent());
    assert.equal(last(sb).trace_kind, 'assertion');
  });
  itTs('does not rate a spec file with the assert commented out as assertion — the path is not the trace', async () => {
    const repo = mkRepo(sb, true); write(repo, 'src/a.spec.ts', '// expect(1).toBe(1);\nexport const x = 1;\n');
    await stop(sb, repo, agent());
    assert.equal(last(sb).trace_kind, 'none');
  });
  it('rates a hook script wired by a settings.json hook command as guard', async () => {
    const repo = mkRepo(sb); write(repo, 'hooks/g.sh', 'echo guard\n');
    write(repo, 'settings.json', hookSettings('"$CLAUDE_PROJECT_DIR"/hooks/g.sh'));
    await stop(sb, repo, agent());
    assert.equal(last(sb).trace_kind, 'guard');
  });
  // Decision 22.09: the strict wording of friction-review wins over «first three» — a hook guards a process, not data.
  it('does not take a wired hook for a sufficient safeguard of a domain change, and does for a module one (both sides)', async () => {
    const repo = mkRepo(sb);
    write(repo, 'src/migrations/002.sql', 'ALTER TABLE t ADD COLUMN d int;\n');
    write(repo, 'hooks/g.sh', 'echo guard\n');
    write(repo, 'settings.json', hookSettings('"$CLAUDE_PROJECT_DIR"/hooks/g.sh'));
    await stop(sb, repo, agent());
    const e = last(sb);
    assert.equal(e.scope, 'domain'); assert.equal(e.trace_kind, 'guard'); assert.equal(e.safeguard_sufficient, false);
    const mod = mkRepo(sb);
    for (const f of ['a', 'b', 'c', 'd']) write(mod, `src/${f}.py`, 'x=1\n');
    write(mod, 'hooks/g.sh', 'echo guard\n');
    write(mod, 'settings.json', hookSettings('"$CLAUDE_PROJECT_DIR"/hooks/g.sh'));
    await stop(sb, mod, agent());
    const m = last(sb);
    assert.equal(m.scope, 'module'); assert.equal(m.trace_kind, 'guard'); assert.equal(m.safeguard_sufficient, true);
  });
  it('rates a skill file under skills/ as rule', async () => {
    const repo = mkRepo(sb); write(repo, 'skills/x/SKILL.md', 'правило\n');
    await stop(sb, repo, agent());
    assert.equal(last(sb).trace_kind, 'rule');
  });
  it('rates a plain edit without a safeguard as none', async () => {
    const repo = mkRepo(sb); write(repo, 'src/a.py', 'y = 2\n');
    await stop(sb, repo, agent());
    assert.equal(last(sb).trace_kind, 'none');
  });
  it('moves the window: a second stop without edits reports no_change', async () => {
    const repo = mkRepo(sb); write(repo, 'src/a.py', 'y = 2\n');
    await stop(sb, repo, agent());
    assert.equal(last(sb).friction_state, 'derived_from_diff');
    await stop(sb, repo, agent());
    assert.equal(last(sb).friction_state, 'no_change');
  });
  it('does not count a large dirty file the agent left byte for byte, whatever happened to its mtime', async () => {
    const repo = mkRepo(sb); write(repo, 'data/big.txt', 'reference row with padding\n'.repeat(20000));
    const id = agent();
    await start(sb, repo, id);
    const later = new Date(Date.now() + 5000); utimesSync(join(repo, 'data/big.txt'), later, later);
    await stop(sb, repo, id);
    assert.equal(last(sb).files_changed, 0, 'a stash and pop of a file the agent never edited made a change of the window');
  });
  it('takes no window outside git and answers the subagent nothing at its start either', async () => {
    const dir = join(sb.dir, 'nogit-start'); mkdirSync(dir, { recursive: true });
    const v = await start(sb, dir, agent());
    assert.equal(v.kind, 'silent', JSON.stringify(v));
  });
  it('records not_a_git_repo outside git without a made-up level and answers the subagent nothing', async () => {
    const dir = join(sb.dir, 'nogit'); mkdirSync(dir, { recursive: true });
    const v = await stop(sb, dir, agent());
    assert.equal(v.kind, 'silent', JSON.stringify(v));
    const e = last(sb);
    assert.equal(e.friction_state, 'unavailable'); assert.equal(e.missing_reason, 'not_a_git_repo'); assert.equal('scope' in e, false);
  });
  it('sees a new file inside a new directory (-uall) — files_changed 1', async () => {
    const repo = mkRepo(sb); write(repo, 'brand/new/dir/f.py', 'x=1\n');
    await stop(sb, repo, agent());
    assert.equal(last(sb).files_changed, 1);
  });
  it('writes every event as one valid JSON line', () => {
    const p = join(sb.home, '.claude', 'exec-telemetry', 'personal-friction.jsonl');
    for (const l of readFileSync(p, 'utf8').split('\n').filter(Boolean)) assert.doesNotThrow(() => JSON.parse(l), l.slice(0, 80));
  });
});

describe('friction: documentation is not a guarantee (INC-FRICTION-DOC-AS-CONSTRAINT, H6)', () => {
  const sb = sandbox('harction-doc-');
  after(() => sb.cleanup());
  beforeEach(newSession);

  it('rates work-docs/sql/sample.sql with NOT NULL and CONSTRAINT as function/none — a documented query creates nothing in a database', async () => {
    const repo = mkRepo(sb); write(repo, 'work-docs/sql/sample.sql', 'CREATE TABLE sample (id int NOT NULL, CONSTRAINT sample_uniq UNIQUE (id));\n');
    await stop(sb, repo, agent());
    const e = last(sb);
    assert.equal(e.scope, 'function'); assert.equal(e.trace_kind, 'none'); assert.equal(e.files_changed, 1);
  });
  it('rates a migration path outside src/ as neither domain nor constraint — only src/** is code', async () => {
    const repo = mkRepo(sb); write(repo, 'migrations/001.sql', 'ALTER TABLE t ADD CONSTRAINT t_uniq UNIQUE (a, b);\n');
    await stop(sb, repo, agent());
    assert.equal(last(sb).scope, 'function'); assert.equal(last(sb).trace_kind, 'none');
  });
  it('does not lift two documentation edits in two roots to module', async () => {
    const repo = mkRepo(sb); write(repo, 'docs/a.md', 'a\n'); write(repo, 'epics/b.md', 'b\n');
    await stop(sb, repo, agent());
    assert.equal(last(sb).scope, 'function'); assert.equal(last(sb).files_changed, 2);
  });
  it('rates edits in two repositories of the session as domain, unless both are documentation', async () => {
    const a = mkRepo(sb); const b = mkRepo(sb);
    const st = State.open(sb.stateDir);
    st.db.prepare('INSERT OR IGNORE INTO session_roots(session_id, repo, first_seen) VALUES(?,?,?)').run(session, a, 1);
    st.db.prepare('INSERT OR IGNORE INTO session_roots(session_id, repo, first_seen) VALUES(?,?,?)').run(session, b, 1);
    st.close();
    write(a, 'src/a.py', 'x=1\n'); write(b, 'src/b.py', 'x=1\n');
    await stop(sb, a, agent());
    assert.equal(last(sb).scope, 'domain');
    write(a, 'notes/a.md', 'x\n'); write(b, 'notes/b.md', 'x\n');
    await stop(sb, a, agent());
    assert.equal(last(sb).scope, 'function'); assert.equal(last(sb).files_changed, 2);
  });
});

describe('friction: agent window and attribution (INC-FRICTION-UNKNOWN-AGENTS, H7)', () => {
  const sb = sandbox('harction-win-');
  after(() => sb.cleanup());
  beforeEach(newSession);

  it('attributes the diff since SubagentStart to the agent and does not credit edits made before the start', async () => {
    const repo = mkRepo(sb); write(repo, 'src/before.py', 'x=1\n');
    const id = agent();
    assert.equal((await start(sb, repo, id)).kind, 'silent');
    await stop(sb, repo, id);
    const e = last(sb);
    assert.equal(e.attribution, 'agent'); assert.equal(e.files_changed, 0); assert.equal(e.friction_state, 'no_change'); assert.equal(e.concurrent_agents, 0);
    assert.equal(typeof e.duration_s, 'number');
  });
  it('credits the agent with a file its own Write left inside its window', async () => {
    const repo = mkRepo(sb); const id = agent();
    await start(sb, repo, id); await toolWrite(sb, repo, 'src/inside.py', 'x=1\n', id);
    await stop(sb, repo, id);
    assert.equal(last(sb).attribution, 'agent'); assert.equal(last(sb).files_changed, 1); assert.equal(last(sb).adapter, 'claude-friction-3');
  });
  it('marks agent_overlapping with concurrent_agents when another open agent shares the root', async () => {
    const repo = mkRepo(sb); const a = agent(); const b = agent();
    await start(sb, repo, a); await start(sb, repo, b); write(repo, 'src/x.py', 'x=1\n');
    await stop(sb, repo, a);
    assert.equal(last(sb).attribution, 'agent_overlapping'); assert.equal(last(sb).concurrent_agents, 1);
    await stop(sb, repo, b);
    assert.equal(last(sb).attribution, 'agent_overlapping');
  });
  it('falls back to attribution window when no SubagentStart was recorded — and says so instead of pretending', async () => {
    const repo = mkRepo(sb); write(repo, 'src/x.py', 'x=1\n');
    await stop(sb, repo, agent());
    assert.equal(last(sb).attribution, 'window'); assert.equal(last(sb).concurrent_agents, null);
  });
  it('keeps an open agent of another root out of the concurrency count', async () => {
    const a = mkRepo(sb); const b = mkRepo(sb); const ida = agent(); const idb = agent();
    await start(sb, a, ida); await start(sb, b, idb); write(a, 'src/x.py', 'x=1\n');
    await stop(sb, a, ida);
    assert.equal(last(sb).attribution, 'agent'); assert.equal(last(sb).concurrent_agents, 0);
  });
  // REGRESSION INC-FRICTION-UNKNOWN-AGENTS (third occurrence, 21.09): the port fell back to the shared window for
  // Claude Code's internal agents and classified the root session's edits under them — 61% of changed events.
  it('gives an agent with neither a start row nor a type no level and leaves the shared window where it was', async () => {
    const repo = mkRepo(sb);
    write(repo, 'src/before.py', 'x=1\n'); await stop(sb, repo, agent());
    write(repo, 'src/root_edit.py', 'x=1\n');
    await stop(sb, repo, agent(), { agent_type: '' });
    const internal = last(sb);
    assert.equal(internal.attribution, 'internal'); assert.equal(internal.files_changed, 0);
    assert.equal(internal.missing_reason, 'internal_agent_without_start'); assert.equal('scope' in internal, false);
    await stop(sb, repo, agent());
    assert.equal(last(sb).attribution, 'window'); assert.equal(last(sb).files_changed, 1, 'the root edit stays in the next typed window');
  });
  it('keeps the window fallback for a typed agent without a start row — a resumed agent, not an internal one', async () => {
    const repo = mkRepo(sb); write(repo, 'src/x.py', 'x=1\n');
    await stop(sb, repo, agent(), { agent_type: 'race-auditor' });
    assert.equal(last(sb).attribution, 'window');
  });
  it('records an empty agent_type as null, not as an empty label', async () => {
    const repo = mkRepo(sb);
    await stop(sb, repo, agent(), { agent_type: '' });
    assert.equal(last(sb).agent_type, null);
  });
});

// REGRESSION INC-FRICTION-AGENT-WINDOW-PARENT-EDITS (21.09, repeat 29.09): the window diff of a shared tree credited read-only
// agents with the root's edits (43 of 83 stops of race-auditor/spec-critic/Explore) and wrote one diff on every overlapping stop
// (92 of 149 agent_overlapping events were repeats). Authorship now comes from the agent's own calls.
// INVARIANT: files_changed of a tracked agent = files its own Edit/Write/Bash calls left changed; the root is never tracked.
describe('friction: authorship by the agent\'s own calls (INC-FRICTION-AGENT-WINDOW-PARENT-EDITS)', () => {
  const sb = sandbox('harction-auth-');
  after(() => sb.cleanup());
  beforeEach(newSession);

  it('gives a read-only agent nothing while the root edits the tree through Write and through Bash', async () => {
    const repo = mkRepo(sb); const id = agent();
    await start(sb, repo, id);
    await toolWrite(sb, repo, 'src/root_a.py', 'a=1\n');
    await bash(sb, repo, undefined, () => write(repo, 'src/root_b.py', 'b=1\n'));
    write(repo, 'src/untracked_writer.py', 'c=1\n');
    await stop(sb, repo, id, { agent_type: 'race-auditor' });
    const e = last(sb);
    assert.equal(e.files_changed, 0); assert.equal(e.friction_state, 'no_change'); assert.equal(e.adapter, 'claude-friction-3');
  });
  it('credits the agent with what its Bash call wrote', async () => {
    const repo = mkRepo(sb); const id = agent();
    await start(sb, repo, id);
    await bash(sb, repo, id, () => { write(repo, 'src/a.py', 'a=1\n'); write(repo, 'src/b.py', 'b=1\n'); });
    await stop(sb, repo, id);
    assert.equal(last(sb).files_changed, 2); assert.equal(last(sb).scope, 'function');
  });
  it('keeps a file the root wrote with Write during the agent\'s Bash call out of the agent\'s share, and keeps the agent\'s own', async () => {
    const repo = mkRepo(sb); const id = agent();
    await start(sb, repo, id);
    await bash(sb, repo, id, async () => { write(repo, 'src/mine.py', 'm=1\n'); await toolWrite(sb, repo, 'src/root.py', 'r=1\n'); });
    await stop(sb, repo, id);
    assert.equal(last(sb).files_changed, 1);
  });
  it('gives each of two overlapping agents only its own file, so one diff is not written twice', async () => {
    const repo = mkRepo(sb); const a = agent(); const b = agent();
    await start(sb, repo, a); await start(sb, repo, b);
    await toolWrite(sb, repo, 'src/a.py', 'a=1\n', a);
    await stop(sb, repo, a); const ea = last(sb);
    await stop(sb, repo, b); const eb = last(sb);
    assert.equal(ea.files_changed, 1); assert.equal(ea.attribution, 'agent_overlapping');
    assert.equal(eb.files_changed, 0);
  });
  it('credits nothing for a Bash call that never got its post (denied or interrupted) and names the gap', async () => {
    const repo = mkRepo(sb); const id = agent();
    await start(sb, repo, id);
    await bash(sb, repo, id, () => write(repo, 'src/x.py', 'x=1\n'), { post: false });
    await stop(sb, repo, id);
    assert.equal(last(sb).files_changed, 0); assert.match(String(last(sb).missing_reason), /call_unclosed/);
  });
  it('closes a background Bash call at the stop and credits what it wrote after its post', async () => {
    const repo = mkRepo(sb); const id = agent();
    await start(sb, repo, id);
    await bash(sb, repo, id, () => {}, { background: true });
    write(repo, 'src/late.py', 'l=1\n');
    await stop(sb, repo, id);
    assert.equal(last(sb).files_changed, 1);
    assert.doesNotMatch(String(last(sb).missing_reason ?? ''), /call_unclosed/);
  });
  it('names a Bash call without tool_use_id instead of guessing its writes', async () => {
    const repo = mkRepo(sb); const id = agent();
    await start(sb, repo, id);
    await bash(sb, repo, id, () => write(repo, 'src/x.py', 'x=1\n'), { id: null });
    await stop(sb, repo, id);
    assert.equal(last(sb).files_changed, 0); assert.match(String(last(sb).missing_reason), /call_without_id/);
  });
  it('writes no friction state for root calls when no agent is tracked, and stays silent on every call event', async () => {
    const repo = mkRepo(sb);
    const w = await toolWrite(sb, repo, 'src/r.py', 'r=1\n');
    const { pre, post } = await bash(sb, repo, undefined, () => write(repo, 'src/s.py', 's=1\n'));
    for (const v of [w, pre, post]) assert.equal(v?.kind, 'silent');
    const st = State.open(sb.stateDir);
    try {
      const n = (t: string) => (st.db.prepare(`SELECT count(*) AS n FROM ${t} WHERE session_id = ?`).get(session) as { n: number }).n;
      assert.equal(n('tool_write'), 0); assert.equal(n('agent_call'), 0);
    } finally { st.close(); }
  });
  it('keeps the window diff and the old label for a window opened before tracking existed', async () => {
    const repo = mkRepo(sb); const id = agent();
    await start(sb, repo, id);
    const st = State.open(sb.stateDir);
    try { st.db.prepare('DELETE FROM agent_tracked WHERE session_id = ? AND agent_id = ?').run(session, id); } finally { st.close(); }
    write(repo, 'src/x.py', 'x=1\n');
    await stop(sb, repo, id);
    assert.equal(last(sb).files_changed, 1); assert.equal(last(sb).adapter, 'claude-friction-2');
  });
  it('drops the agent\'s rows at its stop', async () => {
    const repo = mkRepo(sb); const id = agent();
    await start(sb, repo, id); await toolWrite(sb, repo, 'src/a.py', 'a=1\n', id);
    await bash(sb, repo, id, () => {}, { post: false });
    await stop(sb, repo, id);
    const st = State.open(sb.stateDir);
    try {
      for (const t of ['tool_write', 'agent_call', 'agent_tracked']) assert.equal((st.db.prepare(`SELECT count(*) AS n FROM ${t} WHERE session_id = ?`).get(session) as { n: number }).n, 0, t);
    } finally { st.close(); }
  });
});

// Findings of race-auditor on the authorship diff (29.09), each red before its fix.
describe('friction: authorship holds under the shim, failures, ordering, caps, background and resume', () => {
  const sb = sandbox('harction-auth-adv-');
  after(() => sb.cleanup());
  beforeEach(newSession);
  const rows = (t: string): number => { const st = State.open(sb.stateDir); try { return (st.db.prepare(`SELECT count(*) AS n FROM ${t} WHERE session_id = ?`).get(session) as { n: number }).n; } finally { st.close(); } };

  it('reaches onPreBash through the real shim for an agent command without a trigger word (sed -i)', async () => {
    const repo = mkRepo(sb); const id = agent();
    write(repo, 'src/x.py', 'a=1\n'); sh(repo, 'add', '-A'); sh(repo, 'commit', '-qm', 'x');
    await start(sb, repo, id);
    const input = { command: "sed -i '' s/a/b/ src/x.py" };
    const pre = runHook('pre-bash', payload('PreToolUse', { session_id: session, tool_name: 'Bash', tool_input: input, tool_use_id: 'toolu_sed1', agent_id: id, agent_type: 'worker', permission_mode: 'auto' }, repo), sb, { CLAUDE_HARNESS_NODE: NODE_BIN, CLAUDE_SKIP_TREE_SWEEP: '1' });
    assert.equal(pre.rc, 0); assert.equal(pre.stdout, '');
    assert.equal(rows('agent_call'), 1, 'the agent call was not bracketed');
    write(repo, 'src/x.py', 'b=1\n');
    await route('post', payload('PostToolUse', { session_id: session, tool_name: 'Bash', tool_input: input, tool_use_id: 'toolu_sed1', agent_id: id, agent_type: 'worker' }, repo) as never, env(sb));
    await stop(sb, repo, id);
    assert.equal(last(sb).files_changed, 1);
  });
  it('names a post Bash of an agent whose pre never registered the call instead of reporting a clean window', async () => {
    const repo = mkRepo(sb); const id = agent();
    await start(sb, repo, id); write(repo, 'src/x.py', 'x=1\n');
    await route('post', payload('PostToolUse', { session_id: session, tool_name: 'Bash', tool_input: { command: 'true' }, tool_use_id: 'toolu_lost', agent_id: id, agent_type: 'worker' }, repo) as never, env(sb));
    await stop(sb, repo, id);
    assert.match(String(last(sb).missing_reason), /call_untracked/);
  });
  it('does not take a failed Edit (PostToolUseFailure) for a write of its caller', async () => {
    const repo = mkRepo(sb); const id = agent();
    await start(sb, repo, id); write(repo, 'src/root.py', 'r=1\n');
    await route('post', payload('PostToolUseFailure', { session_id: session, tool_name: 'Edit', tool_input: { file_path: join(repo, 'src/root.py'), old_string: 'zzz', new_string: 'q' }, tool_use_id: 'toolu_f1', error: 'String to replace not found', agent_id: id, agent_type: 'worker' }, repo) as never, env(sb));
    await stop(sb, repo, id, { agent_type: 'race-auditor' });
    assert.equal(last(sb).files_changed, 0);
  });
  it('keeps the agent\'s Bash write when a root Edit on the same file failed during the call', async () => {
    const repo = mkRepo(sb); const id = agent();
    await start(sb, repo, id);
    await bash(sb, repo, id, async () => {
      write(repo, 'src/mine.py', 'm=1\n');
      await route('post', payload('PostToolUseFailure', { session_id: session, tool_name: 'Edit', tool_input: { file_path: join(repo, 'src/mine.py'), old_string: 'zzz', new_string: 'q' }, tool_use_id: 'toolu_f2', error: 'File has been modified since read' }, repo) as never, env(sb));
    });
    await stop(sb, repo, id);
    assert.equal(last(sb).files_changed, 1);
  });
  it('keeps a root Write out of the agent\'s share even when the root\'s post lands after the agent\'s post', async () => {
    const repo = mkRepo(sb); const id = agent();
    await start(sb, repo, id);
    await bash(sb, repo, id, () => write(repo, 'src/root.py', 'r=1\n'));
    await route('post', payload('PostToolUse', { session_id: session, tool_name: 'Write', tool_input: { file_path: join(repo, 'src/root.py') }, tool_use_id: 'toolu_rw' }, repo) as never, env(sb));
    await stop(sb, repo, id, { agent_type: 'race-auditor' });
    assert.equal(last(sb).files_changed, 0);
  });
  it('keeps the agent\'s file and names the cap when the stop snapshot is capped', async () => {
    const repo = mkRepo(sb); const id = agent();
    for (let i = 0; i < 205; i++) write(repo, `a/f${String(i).padStart(3, '0')}.txt`, `${i}\n`);
    await start(sb, repo, id);
    await toolWrite(sb, repo, 'z/agent.py', 'x=1\n', id);
    await stop(sb, repo, id);
    assert.equal(last(sb).files_changed, 1); assert.match(String(last(sb).missing_reason), /files_capped/);
  });
  it('names a background call closed at the stop: its window spans others\' Bash writes', async () => {
    const repo = mkRepo(sb); const id = agent();
    await start(sb, repo, id);
    await bash(sb, repo, id, () => {}, { background: true });
    await bash(sb, repo, undefined, () => write(repo, 'src/root_b.py', 'b=1\n'));
    await stop(sb, repo, id, { agent_type: 'race-auditor' });
    assert.match(String(last(sb).missing_reason), /background_window/);
  });
  it('leaves no root rows once the last tracked agent of the session stopped', async () => {
    const repo = mkRepo(sb); const id = agent();
    await start(sb, repo, id);
    await toolWrite(sb, repo, 'src/r1.py', 'r=1\n');
    await stop(sb, repo, id);
    assert.equal(rows('tool_write'), 0);
  });
  it('does not credit a resumed agent\'s second stop with the tree diff', async () => {
    const repo = mkRepo(sb); const id = agent();
    await start(sb, repo, id);
    await toolWrite(sb, repo, 'src/a.py', 'a=1\n', id);
    await stop(sb, repo, id);
    write(repo, 'src/root_after.py', 'q=1\n');
    await stop(sb, repo, id);
    const e = last(sb);
    assert.equal(e.files_changed, 0); assert.equal(e.missing_reason, 'resumed_without_start'); assert.equal(e.friction_state, 'not_applicable');
  });
});

describe('friction: unknown is recorded in the journal, not a silent none, and never becomes a subagent turn', () => {
  const sb = sandbox('harction-unk-');
  after(() => sb.cleanup());
  beforeEach(newSession);

  it('reports trace_kind unknown with ts_parser_unavailable for a TS migration when no typescript is reachable from the file', async () => {
    const repo = mkRepo(sb, false);
    write(repo, 'src/migrations/1725000000002-x.ts', 'export class X { async up(q: { query(s: string): Promise<void> }) { await q.query(`CREATE UNIQUE INDEX i ON t (a)`); } }\n');
    const v = await stop(sb, repo, agent(), {}, { CLAUDE_HARNESS_TS: join(sb.dir, 'absent', 'typescript.js') });
    assert.equal(v.kind, 'silent', JSON.stringify(v));
    const e = last(sb);
    assert.equal(e.scope, 'domain'); assert.equal(e.trace_kind, 'unknown'); assert.equal(e.missing_reason, 'ts_parser_unavailable'); assert.equal(e.safeguard_sufficient, null);
  });
  it('reports trace_kind unknown with sql_parse_error for a migration the SQL parser cannot read', async () => {
    const repo = mkRepo(sb); write(repo, 'src/migrations/bad.sql', 'ALTER TABEL t ADD CONSTRAINTT u UNIQUE (a);\n');
    const v = await stop(sb, repo, agent());
    assert.equal(v.kind, 'silent', JSON.stringify(v));
    const e = last(sb);
    assert.equal(e.trace_kind, 'unknown'); assert.equal(e.missing_reason, 'sql_parse_error');
  });
  it('reports trace_kind unknown for a spec file that no parser of the harness can read', async () => {
    const repo = mkRepo(sb); write(repo, 'tests/test_a.py', 'assert 1 == 1\n');
    await stop(sb, repo, agent());
    assert.equal(last(sb).trace_kind, 'unknown'); assert.equal(last(sb).missing_reason, 'no_parser_for_file_kind');
  });
});

describe('friction: kill-switch through route()', () => {
  const sb = sandbox('harction-kill-');
  after(() => sb.cleanup());
  beforeEach(newSession);

  it('stays silent under CLAUDE_SKIP_FRICTION=1 and writes nothing to the journal or the state', async () => {
    const repo = mkRepo(sb); write(repo, 'src/a.py', 'x=1\n');
    const id = agent(); const kill = env(sb, { CLAUDE_SKIP_FRICTION: '1' });
    assert.equal((await route('agent-start', payload('SubagentStart', { session_id: session, agent_id: id, agent_type: 'worker' }, repo) as never, kill)).kind, 'silent');
    assert.equal((await route('agent-stop', payload('SubagentStop', { session_id: session, agent_id: id, agent_type: 'worker' }, repo) as never, kill)).kind, 'silent');
    assert.equal(events(sb).length, 0);
    assert.equal(existsSync(join(sb.stateDir, 'harness.db')), false);
  });
});

function hookSettings(...commands: string[]): string {
  return `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: commands.map((command) => ({ type: 'command', command })) }] } })}\n`;
}

// Рецидив 10.09 (04ef969): .sql вне миграций давал domain+constraint; рецидив 09.09 (eb93275): любой путь hooks/
// давал guard — отключённый скрипт, React-хук и shell-спека закрывали доменный уровень предохранителем, которого нет.
describe('friction: a trace needs a migration path or a wired safeguard (INC-FRICTION-TRACE-BY-PATH)', () => {
  const sb = sandbox('harction-trace-');
  after(() => sb.cleanup());
  beforeEach(newSession);

  it('does not lift a .sql file outside migrations to domain — the extension is not a schema change', async () => {
    const repo = mkRepo(sb); write(repo, 'src/queries/report.sql', 'SELECT id FROM orders WHERE deleted_at IS NOT NULL;\n');
    await stop(sb, repo, agent());
    assert.equal(last(sb).scope, 'function');
  });
  it('still rates a .sql file inside a migrations directory as domain', async () => {
    const repo = mkRepo(sb); write(repo, 'src/db/migrations/004.sql', 'ALTER TABLE orders ADD COLUMN note text;\n');
    await stop(sb, repo, agent());
    assert.equal(last(sb).scope, 'domain');
  });
  it('does not take CREATE UNIQUE INDEX in a .sql file outside migrations for a constraint — a sample query is applied by hand', async () => {
    const repo = mkRepo(sb); write(repo, 'src/queries/uniq.sql', 'CREATE UNIQUE INDEX orders_ext_uniq ON orders (external_id);\n');
    await stop(sb, repo, agent());
    assert.equal(last(sb).trace_kind, 'none'); assert.equal(last(sb).scope, 'function');
  });
  it('takes the same CREATE UNIQUE INDEX inside a migrations directory for a constraint', async () => {
    const repo = mkRepo(sb); write(repo, 'src/db/migrations/005.sql', 'CREATE UNIQUE INDEX orders_ext_uniq ON orders (external_id);\n');
    await stop(sb, repo, agent());
    const e = last(sb);
    assert.equal(e.scope, 'domain'); assert.equal(e.trace_kind, 'constraint'); assert.equal(e.safeguard_sufficient, true);
  });
  it('does not rate a hook script that no settings.json wires as guard — a disabled script in hooks/ is not a safeguard', async () => {
    const repo = mkRepo(sb); write(repo, 'hooks/orphan.sh', 'echo guard\n');
    write(repo, 'settings.json', hookSettings('"$CLAUDE_PROJECT_DIR"/hooks/other.sh'));
    await stop(sb, repo, agent());
    assert.equal(last(sb).trace_kind, 'none');
  });
  it('does not rate src/hooks/ of a UI project as guard — a React hooks directory is not a Claude hook', async () => {
    const repo = mkRepo(sb); write(repo, 'src/hooks/useStageTimer.ts', 'export const useStageTimer = (): number => 0;\n');
    await stop(sb, repo, agent());
    assert.equal(last(sb).trace_kind, 'none');
  });
  it('reports a shell spec under hooks/spec as unknown — ok/bad lines are not parsed, and the hooks/ path is not a guard', async () => {
    const repo = mkRepo(sb); write(repo, 'hooks/spec/g.test.sh', 'ok "подключённый хук → guard"\n');
    await stop(sb, repo, agent());
    assert.equal(last(sb).trace_kind, 'unknown'); assert.equal(last(sb).missing_reason, 'no_parser_for_file_kind');
  });
  it('rates a gate module imported from gates/index.ts of a harness wired in settings.json as guard', async () => {
    const repo = mkRepo(sb);
    write(repo, 'settings.json', hookSettings('"$HOME"/.claude/harness/bin/hook pre-bash'));
    write(repo, 'harness/src/gates/index.ts', "import './g.ts';\n"); write(repo, 'harness/src/gates/g.ts', "export const NAME = 'g';\n");
    await stop(sb, repo, agent());
    assert.equal(last(sb).trace_kind, 'guard');
  });
  it('rates a checker imported through a nested index of the gate registry as guard', async () => {
    const repo = mkRepo(sb);
    write(repo, 'settings.json', hookSettings('"$HOME"/.claude/harness/bin/hook post'));
    write(repo, 'harness/src/gates/index.ts', "import '../checks/index.ts';\n"); write(repo, 'harness/src/checks/index.ts', "import './syntax.ts';\n");
    write(repo, 'harness/src/checks/syntax.ts', "export const NAME = 'syntax';\n");
    await stop(sb, repo, agent());
    assert.equal(last(sb).trace_kind, 'guard');
  });
  it('does not rate a gate module as guard when gates/index.ts does not import it or imports it only inside a comment', async () => {
    const repo = mkRepo(sb);
    write(repo, 'settings.json', hookSettings('"$HOME"/.claude/harness/bin/hook pre-bash'));
    write(repo, 'harness/src/gates/index.ts', "import './other.ts';\n// import './g.ts';\n/*\nimport './g.ts';\n*/\n");
    write(repo, 'harness/src/gates/g.ts', "export const NAME = 'g';\n");
    await stop(sb, repo, agent());
    assert.equal(last(sb).trace_kind, 'none');
  });
  it('does not rate an imported gate module as guard when no settings.json wires the harness router', async () => {
    const repo = mkRepo(sb);
    write(repo, 'harness/src/gates/index.ts', "import './g.ts';\n"); write(repo, 'harness/src/gates/g.ts', "export const NAME = 'g';\n");
    await stop(sb, repo, agent());
    assert.equal(last(sb).trace_kind, 'none');
  });
  it('reads settings.json of the repository that owns the file, not of the session cwd', async () => {
    const a = mkRepo(sb); const b = mkRepo(sb);
    const st = State.open(sb.stateDir);
    for (const r of [a, b]) st.db.prepare('INSERT OR IGNORE INTO session_roots(session_id, repo, first_seen) VALUES(?,?,?)').run(session, r, 1);
    st.close();
    write(a, 'settings.json', hookSettings('"$CLAUDE_PROJECT_DIR"/hooks/g.sh')); sh(a, 'add', '-A'); sh(a, 'commit', '-qm', 'wire');
    write(b, 'hooks/g.sh', 'echo guard\n');
    await stop(sb, a, agent());
    assert.equal(last(sb).trace_kind, 'none');
  });
});

describe('friction: user-level settings.json wires hooks too', () => {
  const sb = sandbox('harction-home-');
  after(() => sb.cleanup());
  beforeEach(newSession);
  const wireHome = (): void => write(sb.home, '.claude/settings.json', hookSettings('"$HOME"/.claude/hooks/home-wired.sh', '"$HOME"/.claude/harness/bin/hook session-start'));

  it('rates a hook script wired only in $HOME/.claude/settings.json as guard', async () => {
    wireHome(); const repo = mkRepo(sb); write(repo, 'hooks/home-wired.sh', 'echo guard\n');
    await stop(sb, repo, agent());
    assert.equal(last(sb).trace_kind, 'guard');
  });
  it('does not take a bare argument of a hook command for a wired file — only a word with a path names a file', async () => {
    wireHome(); const repo = mkRepo(sb); write(repo, 'session-start', 'x\n');
    await stop(sb, repo, agent());
    assert.equal(last(sb).trace_kind, 'none');
  });
});
