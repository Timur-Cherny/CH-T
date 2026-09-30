// INVARIANT: a finding is delivered per reader — the root session or one of its subagents — never per session.
// A subagent sees findings on files that changed inside its own window and never the pending-count line; handing a
// finding to a subagent does not spend it for the root, whose post or Stop still delivers it exactly once.
// REGRESSION 24.09: 291 sweep contexts inside 37 subagents in a week, 74 with findings on files the agent never
// touched; each one was marked delivered to the whole session and the root never saw it.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { route } from '../../src/main.ts';
import { State } from '../../src/state.ts';
import { deliver, digestOf, recordResult, rootReader } from '../../src/sweep.ts';
import { WINDOW_DIGEST_BYTES } from '../../src/window.ts';
import type { ChangedFile } from '../../src/checks/types.ts';
import { sandbox, payload, onlyGate, HARNESS_ROOT, type Sandbox } from '../_env.ts';
import type { Verdict } from '../../src/types.ts';
import { render } from '../../src/emit.ts';

function git(cwd: string, ...args: string[]): string { return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }); }

let seq = 0;
function repoWithCommit(sb: Sandbox): string {
  const repo = join(sb.dir, `repo${++seq}`); mkdirSync(repo);
  git(repo, 'init', '-q'); writeFileSync(join(repo, 'README.md'), 'base\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'init');
  return git(repo, 'rev-parse', '--show-toplevel').trim();
}

const text = (v: Verdict): string => ('text' in v ? v.text : 'reason' in v ? v.reason : '');

describe('sweep delivers per reader', () => {
  const sb = sandbox('harness-readers-');
  after(() => sb.cleanup());
  const base = { HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, HARNESS_ROOT };
  const sweepOnly = { ...base, ...onlyGate('sweep') };
  const stopOnly = { ...base, ...onlyGate('sweep-stop') };
  const frictionOnly = { ...base, ...onlyGate('friction') };
  let n = 0;
  const start = (session: string, agent: string, cwd: string) => route('agent-start', payload('SubagentStart', { session_id: session, agent_id: agent, agent_type: 'general-purpose' }, cwd) as never, frictionOnly);
  const post = (session: string, cwd: string, agent?: string, tool = 'Bash') => route('post', payload('PostToolUse', { session_id: session, tool_name: tool, tool_input: { command: 'true' }, tool_use_id: `t${++n}`, ...(agent ? { agent_id: agent, agent_type: 'general-purpose' } : {}) }, cwd) as never, sweepOnly);
  const stop = (session: string, cwd: string) => route('stop', payload('Stop', { session_id: session }, cwd) as never, stopOnly);

  it('keeps a finding on a file the root broke before the agent started away from the agent, and the root Stop still blocks on it', async () => {
    const repo = repoWithCommit(sb);
    writeFileSync(join(repo, 'conf.json'), '{"a": ');
    await start('s-steal', 'agent-1', repo);
    const inAgent = await post('s-steal', repo, 'agent-1');
    assert.doesNotMatch(text(inAgent), /conf\.json/, 'a finding outside the agent window reached the agent');
    const root = await stop('s-steal', repo);
    assert.equal(root.kind, 'block', 'the agent post spent the root finding');
    assert.match(text(root), /conf\.json \[syntax\] fail/);
  });

  it('gives the agent a finding on a file it broke inside its window, and the root gets the same finding once more', async () => {
    const repo = repoWithCommit(sb);
    await start('s-own', 'agent-2', repo);
    writeFileSync(join(repo, 'own.json'), '{"b": ');
    const inAgent = await post('s-own', repo, 'agent-2');
    assert.match(text(inAgent), /own\.json \[syntax\] fail/);
    assert.equal((await post('s-own', repo, 'agent-2')).kind, 'silent', 'the same reader got the same finding twice');
    const root = await post('s-own', repo);
    assert.match(text(root), /own\.json \[syntax\] fail/, 'the root lost a finding the agent had seen');
    assert.equal((await stop('s-own', repo)).kind, 'silent', 'the root was blocked on a finding it already had');
  });

  it('never hands the agent the line about checks running in the background', async () => {
    const repo = repoWithCommit(sb);
    const st = State.open(sb.stateDir);
    try { st.db.prepare("INSERT INTO jobs(job_id, repo, kind, status, owner_session, skips, started_at) VALUES('job-bg', ?, 'tsc-project', 'running', 's-bg', '[]', ?)").run(repo, Date.now()); }
    finally { st.close(); }
    await start('s-bg', 'agent-3', repo);
    assert.equal((await post('s-bg', repo, 'agent-3')).kind, 'silent');
    assert.match(text(await post('s-bg', repo)), /1 проверок в фоне/, 'the root lost the pending line');
  });

  it('gives an agent without a start row only what its own event checked', async () => {
    const repo = repoWithCommit(sb);
    writeFileSync(join(repo, 'old.json'), '{"c": ');
    await post('s-elsewhere', repo);
    writeFileSync(join(repo, 'new.json'), '{"d": ');
    const inAgent = await post('s-nostart', repo, 'agent-4');
    assert.match(text(inAgent), /new\.json \[syntax\] fail/);
    assert.doesNotMatch(text(inAgent), /old\.json/, 'the backlog of the session reached an agent without a window');
  });

  it('forgets a reader delivery when the file goes clean, so a second break reaches the agent and the root again', async () => {
    const repo = repoWithCommit(sb);
    await start('s-rebreak', 'agent-5', repo);
    writeFileSync(join(repo, 'flip.json'), '{"e": ');
    assert.match(text(await post('s-rebreak', repo, 'agent-5')), /flip\.json/);
    assert.match(text(await post('s-rebreak', repo)), /flip\.json/);
    writeFileSync(join(repo, 'flip.json'), '{"e": 1}');
    await post('s-rebreak', repo, 'agent-5'); await post('s-rebreak', repo);
    writeFileSync(join(repo, 'flip.json'), '{"e": ');
    assert.match(text(await post('s-rebreak', repo, 'agent-5')), /flip\.json/);
    assert.match(text(await post('s-rebreak', repo)), /flip\.json/);
  });

  it('forgets the root delivery when a subagent sees the file clean, so the same break told again reaches the root', async () => {
    const repo = repoWithCommit(sb);
    writeFileSync(join(repo, 'conf.json'), '{"ok": 1}\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'conf');
    writeFileSync(join(repo, 'conf.json'), '{"ok": ');
    assert.match(text(await post('s-forget', repo)), /conf\.json/);
    await start('s-forget', 'agent-6', repo);
    writeFileSync(join(repo, 'conf.json'), '{"ok": 1}\n');
    await post('s-forget', repo, 'agent-6');
    writeFileSync(join(repo, 'conf.json'), '{"ok": ');
    assert.match(text(await post('s-forget', repo)), /conf\.json \[syntax\] fail/, 'a clean state seen only by the agent left the root row in place');
  });

  it('counts a file longer than the window digest as changed in the window, so an edit past its end reaches the agent', async () => {
    const repo = repoWithCommit(sb);
    const big = `{"a": "${'x'.repeat(WINDOW_DIGEST_BYTES + 50_000)}"`;
    writeFileSync(join(repo, 'big.json'), `${big}}`);
    await start('s-big', 'agent-7', repo);
    writeFileSync(join(repo, 'big.json'), `${big}`);
    assert.match(text(await post('s-big', repo, 'agent-7')), /big\.json \[syntax\] fail/, 'the agent broke the tail of a large file and was not told');
  });

  it('marks a delivery by the digest the check ran on, so a later content of the file is still owed to the reader', () => {
    const repo = repoWithCommit(sb);
    const at = (text: string): ChangedFile => { writeFileSync(join(repo, 'race.json'), text); return { repo, path: 'race.json', absPath: join(repo, 'race.json'), digest: digestOf(join(repo, 'race.json')), status: '?' }; };
    const st = State.open(sb.stateDir);
    try {
      const first = at('{"r": ');
      const shown = recordResult(st, first, 'syntax', 'g', { verdict: 'fail', message: 'first break' }, 1);
      const later = at('{"r": 1,');
      recordResult(st, later, 'syntax', 'g', { verdict: 'fail', message: 'second break' }, 2);
      const told1 = deliver(st, rootReader('s-race'), [repo], 3, shown ? [shown] : [], [later]).found.map((f) => f.message);
      assert.deepEqual(told1, ['first break', 'second break'], 'the content that replaced the checked one was swallowed');
      assert.deepEqual(deliver(st, rootReader('s-race'), [repo], 4, [], [later]).found, [], 'the second content was told twice');
    } finally { st.close(); }
  });
});

describe('sweep reader edges found by race-auditor 24.09', () => {
  const sb = sandbox('harness-readers-edge-');
  after(() => sb.cleanup());
  const base = { HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, HARNESS_ROOT };
  let n = 0;
  const start = (session: string, agent: string, cwd: string) => route('agent-start', payload('SubagentStart', { session_id: session, agent_id: agent, agent_type: 'general-purpose' }, cwd) as never, { ...base, ...onlyGate('friction') });
  const agentStop = (session: string, agent: string, cwd: string) => route('agent-stop', payload('SubagentStop', { session_id: session, agent_id: agent, agent_type: 'general-purpose' }, cwd) as never, { ...base, ...onlyGate('friction') });
  const post = (session: string, cwd: string, agent?: string, input: Record<string, unknown> = { command: 'true' }, tool = 'Bash') => route('post', payload('PostToolUse', { session_id: session, tool_name: tool, tool_input: input, tool_use_id: `e${++n}`, ...(agent ? { agent_id: agent, agent_type: 'general-purpose' } : {}) }, cwd) as never, { ...base, ...onlyGate('sweep') });
  const stop = (session: string, cwd: string) => route('stop', payload('Stop', { session_id: session }, cwd) as never, { ...base, ...onlyGate('sweep-stop') });
  const fileAt = (repo: string, path: string, body: string): ChangedFile => { writeFileSync(join(repo, path), body); return { repo, path, absPath: join(repo, path), digest: digestOf(join(repo, path)), status: '?' }; };

  it('keeps a large file the root broke before the agent started away from the agent', async () => {
    const repo = repoWithCommit(sb);
    writeFileSync(join(repo, 'big.json'), `{"a": "${'x'.repeat(WINDOW_DIGEST_BYTES + 50_000)}"`);
    assert.match(text(await post('s-big-root', repo)), /big\.json \[syntax\] fail/);
    await start('s-big-root', 'agent-b1', repo);
    writeFileSync(join(repo, 'own.txt'), 'x\n');
    assert.doesNotMatch(text(await post('s-big-root', repo, 'agent-b1')), /big\.json/);
  });

  it('tells the agent that cut a large file down to exactly the digest window and broke it', async () => {
    const repo = repoWithCommit(sb);
    const body = `{"a": "${'x'.repeat(WINDOW_DIGEST_BYTES + 50_000)}"}`;
    writeFileSync(join(repo, 'trunc.json'), body);
    await post('s-trunc', repo);
    await start('s-trunc', 'agent-b2', repo);
    writeFileSync(join(repo, 'trunc.json'), body.slice(0, WINDOW_DIGEST_BYTES));
    assert.match(text(await post('s-trunc', repo, 'agent-b2')), /trunc\.json \[syntax\] fail/);
  });

  it('does not drop a delivery marked after this event listed the changed files', () => {
    const repo = repoWithCommit(sb);
    const st = State.open(sb.stateDir);
    try {
      const f = fileAt(repo, 'y.json', '{"y": ');
      const fnd = recordResult(st, f, 'syntax', 'g', { verdict: 'fail', message: 'y broken' }, 1);
      assert.deepEqual(deliver(st, rootReader('s-late'), [repo], 2, fnd ? [fnd] : [], [f]).found.map((x) => x.message), ['y broken']);
      deliver(st, { sessionId: 's-late', agentId: 'agent-b3', window: {}, since: null }, [repo], 3, [], [], { filesAt: 1 });
      assert.deepEqual(deliver(st, rootReader('s-late'), [repo], 4, [], [f]).found, [], 'the root was told twice while the file kept its content');
      const agent = { sessionId: 's-late', agentId: 'agent-b4', window: {}, since: null };
      assert.deepEqual(deliver(st, agent, [repo], 5, fnd ? [fnd] : [], [f]).found.map((x) => x.message), ['y broken']);
      deliver(st, rootReader('s-late'), [repo], 6, [], [], { filesAt: 4 });
      assert.deepEqual(deliver(st, agent, [repo], 7, [], [f]).found, [], 'a Stop that listed files before its drain dropped a later agent delivery');
    } finally { st.close(); }
  });

  it('drops a pass that arrives for content the file no longer holds', () => {
    const repo = repoWithCommit(sb);
    const st = State.open(sb.stateDir);
    try {
      const older = fileAt(repo, 'w.ts', 'export const a: number = 1;\n');
      const current = fileAt(repo, 'w.ts', 'export const a: number = "x";\n');
      recordResult(st, current, 'tsc-project', 'g', { verdict: 'fail', message: 'w.ts: TS2322' }, 1);
      assert.deepEqual(deliver(st, rootReader('s-stale'), [repo], 2, [], [current]).found.map((x) => x.message), ['w.ts: TS2322']);
      recordResult(st, older, 'tsc-project', 'g', { verdict: 'pass' }, 3);
      assert.deepEqual(deliver(st, rootReader('s-stale'), [repo], 4, [], [current]).found, [], 'a stale pass made the current break owed again');
    } finally { st.close(); }
  });

  it('keeps the backlog of a root the session did not know at the agent start away from the agent', async () => {
    const repoA = repoWithCommit(sb); const repoB = repoWithCommit(sb);
    writeFileSync(join(repoB, 'left.json'), '{"left": ');
    await post('s-elsewhere-b', repoB);
    await post('s-absent', repoA);
    await start('s-absent', 'agent-b5', repoA);
    writeFileSync(join(repoB, 'mine.txt'), 'agent work\n');
    assert.doesNotMatch(text(await post('s-absent', repoA, 'agent-b5', { file_path: join(repoB, 'mine.txt'), content: 'agent work\n' }, 'Write')), /left\.json/);
  });

  it('shows every finding of a large batch across events and never marks one it did not show', async () => {
    const repo = repoWithCommit(sb);
    for (let i = 0; i < 150; i++) writeFileSync(join(repo, `broken-file-with-a-long-descriptive-name-${String(i).padStart(3, '0')}.json`), '{"x": ');
    const seen: string[] = [];
    const take = (v: Verdict): number => { const got = [...text(v).matchAll(/^- (broken-file-[^ ]+\.json) \[/gm)].map((m) => m[1]); seen.push(...got); return got.length; };
    let round = take(await post('s-batch', repo));
    for (let i = 0; i < 5 && round; i++) round = take(await stop('s-batch', repo));
    assert.equal(new Set(seen).size, 150, `the root saw ${new Set(seen).size} of 150`);
    assert.equal(seen.length, 150, 'a finding was shown twice');
  });

  it('matches the start snapshot and the sweep roots through a symlinked cwd', async () => {
    const repo = repoWithCommit(sb);
    const viaLink = repo.replace(/^\/private\/var\//, '/var/');
    writeFileSync(join(repo, 'pre.json'), '{"pre": ');
    await post('s-link', viaLink);
    await start('s-link', 'agent-b6', viaLink);
    writeFileSync(join(repo, 'agent.txt'), 'x\n');
    assert.doesNotMatch(text(await post('s-link', repo, 'agent-b6')), /pre\.json/);
  });

  it('treats a resumed agent without a new start as windowless, so root breaks made meanwhile stay the root\'s', async () => {
    const repo = repoWithCommit(sb);
    await start('s-resume', 'agent-b7', repo);
    writeFileSync(join(repo, 'agent.txt'), 'agent work\n');
    await post('s-resume', repo, 'agent-b7');
    await agentStop('s-resume', 'agent-b7', repo);
    writeFileSync(join(repo, 'root.json'), '{"root": ');
    assert.match(text(await post('s-resume', repo)), /root\.json \[syntax\] fail/);
    assert.doesNotMatch(text(await post('s-resume', repo, 'agent-b7')), /root\.json/);
  });

  it('tells an agent the worker verdict on its edit in a root its start snapshot did not hold', async () => {
    const repoA = repoWithCommit(sb); const repoB = repoWithCommit(sb);
    const edit = (path: string) => route('post', payload('PostToolUse', { session_id: 's-reach', tool_name: 'Write', tool_input: { file_path: join(repoB, path), content: '' }, tool_use_id: `e${++n}`, agent_id: 'agent-b9', agent_type: 'general-purpose' }, repoA) as never, { ...base, ...onlyGate('sweep'), CLAUDE_SKIP_CHECK: '1' });
    await post('s-reach', repoA);
    await start('s-reach', 'agent-b9', repoA);
    const mine = fileAt(repoB, 'feature.ts', 'export const a: number = "x";\n');
    await edit('feature.ts');
    const st = State.open(sb.stateDir);
    try { recordResult(st, mine, 'tsc-project', 'g', { verdict: 'fail', message: 'feature.ts: TS2322' }, Date.now()); } finally { st.close(); }
    assert.match(text(await edit('README.md')), /feature\.ts \[tsc-project\] fail/, 'the worker verdict on the agent\'s own edit never reached it');
  });

  it('promises a windowless agent no later delivery of findings cut from its report, and still promises the root', async () => {
    const repo = repoWithCommit(sb);
    for (let i = 0; i < 150; i++) writeFileSync(join(repo, `cut-file-with-a-long-descriptive-name-${String(i).padStart(3, '0')}.json`), '{"x": ');
    const agentText = text(await post('s-cut', repo, 'agent-b10'));
    assert.match(agentText, /ещё \d+: не уместились в отчёт/);
    assert.doesNotMatch(agentText, /на следующем событии/, 'a windowless agent reads no backlog, so the promise is false');
    assert.match(text(await post('s-cut', repo)), /ещё \d+: не уместились в отчёт; по незакоммиченным файлам — на следующем событии/);
  });

  it('blocks the root Stop on a break owed anew even when its signature already blocked once', async () => {
    const repo = repoWithCommit(sb);
    writeFileSync(join(repo, 'c.json'), '{"c": 1}\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'c');
    writeFileSync(join(repo, 'c.json'), '{"c": ');
    assert.equal((await stop('s-sig', repo)).kind, 'block');
    writeFileSync(join(repo, 'c.json'), '{"c": 1}\n'); await post('s-sig', repo);
    await start('s-sig', 'agent-b8', repo);
    writeFileSync(join(repo, 'c.json'), '{"c": '); await post('s-sig', repo, 'agent-b8');
    const again = await stop('s-sig', repo);
    assert.equal(again.kind, 'block', `the root model was not told about the re-break: ${render(again, 'stop').stdout.slice(0, 80)}`);
  });
});
