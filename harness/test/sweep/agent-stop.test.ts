// INVARIANT: SubagentStop prints nothing a model reads. Claude Code answers additionalContext or block on it with one
// more subagent turn, and that turn's text replaces the report the parent receives (docs: hooks#subagentstop).
// Nothing is spent on the subagent: a finding waits for the next post or Stop of the session, and Stop blocks on it once.
// REGRESSION 24.09: in one week 68 SubagentStop contexts (sweep findings on files the agent never touched, "checks in
// background", friction unknown) each got one more subagent turn; reports reached the parent as replies to the hook.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { route } from '../../src/main.ts';
import { State } from '../../src/state.ts';
import { sandbox, payload, runHook, onlyGate, HARNESS_ROOT, NODE_BIN, type Sandbox } from '../_env.ts';

function git(cwd: string, ...args: string[]): string { return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }); }

let seq = 0;
function repoWithCommit(sb: Sandbox): string {
  const repo = join(sb.dir, `repo${++seq}`); mkdirSync(repo);
  git(repo, 'init', '-q'); writeFileSync(join(repo, 'README.md'), 'base\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'init');
  return git(repo, 'rev-parse', '--show-toplevel').trim();
}

const HOOK_ENV = { CLAUDE_HARNESS_NODE: NODE_BIN };
const subagent = (event: 'SubagentStart' | 'SubagentStop', session: string, agentId: string, cwd: string) =>
  payload(event, { session_id: session, agent_id: agentId, agent_type: 'general-purpose', ...(event === 'SubagentStop' ? { stop_hook_active: false, last_assistant_message: 'REPORT' } : {}) }, cwd);

describe('SubagentStop hands nothing back to the subagent', () => {
  const sb = sandbox('harness-agent-stop-');
  after(() => sb.cleanup());

  it('prints nothing for a broken file the root left before the agent started, and the root Stop still blocks on it once', async () => {
    const repo = repoWithCommit(sb);
    writeFileSync(join(repo, 'conf.json'), '{"a": ');
    assert.equal(runHook('agent-start', subagent('SubagentStart', 's-foreign', 'agent-1', repo), sb, HOOK_ENV).stdout, '');
    const stop = runHook('agent-stop', subagent('SubagentStop', 's-foreign', 'agent-1', repo), sb, HOOK_ENV);
    assert.equal(stop.rc, 0, stop.stderr);
    assert.equal(stop.stdout, '', 'SubagentStop output gives the subagent another turn and its reply replaces the report');
    const root = await route('stop', payload('Stop', { session_id: 's-foreign' }, repo) as never, { HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, HARNESS_ROOT, ...onlyGate('sweep-stop') });
    assert.equal(root.kind, 'block', 'the finding was spent on the subagent and never reached the root');
    assert.match((root as { reason: string }).reason, /conf\.json \[syntax\] fail/);
    const again = await route('stop', payload('Stop', { session_id: 's-foreign' }, repo) as never, { HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, HARNESS_ROOT, ...onlyGate('sweep-stop') });
    assert.equal(again.kind, 'silent', 'one block per finding: the second Stop does not lock the session');
  });

  it('prints nothing while background checks of the session are still running', () => {
    const repo = repoWithCommit(sb);
    const st = State.open(sb.stateDir);
    try { st.db.prepare("INSERT INTO jobs(job_id, repo, kind, status, owner_session, skips, started_at) VALUES('job-in-flight', ?, 'tsc-project', 'running', 's-pending', '[]', ?)").run(repo, Date.now()); }
    finally { st.close(); }
    runHook('agent-start', subagent('SubagentStart', 's-pending', 'agent-2', repo), sb, HOOK_ENV);
    const stop = runHook('agent-stop', subagent('SubagentStop', 's-pending', 'agent-2', repo), sb, HOOK_ENV);
    assert.equal(stop.rc, 0, stop.stderr);
    assert.equal(stop.stdout, '');
  });

  it('prints nothing when friction cannot prove the trace of the agent diff, and the journal keeps the unknown', () => {
    const repo = repoWithCommit(sb);
    runHook('agent-start', subagent('SubagentStart', 's-friction', 'agent-3', repo), sb, HOOK_ENV);
    mkdirSync(join(repo, 'tests')); writeFileSync(join(repo, 'tests', 'test_a.py'), 'assert 1 == 1\n');
    // The agent's own Write: a file that merely appears in the tree is not the agent's (INC-FRICTION-AGENT-WINDOW-PARENT-EDITS).
    runHook('post', payload('PostToolUse', { session_id: 's-friction', agent_id: 'agent-3', agent_type: 'general-purpose', tool_name: 'Write', tool_input: { file_path: join(repo, 'tests', 'test_a.py') }, tool_use_id: 'toolu_w1' }, repo), sb, HOOK_ENV);
    const stop = runHook('agent-stop', subagent('SubagentStop', 's-friction', 'agent-3', repo), sb, HOOK_ENV);
    assert.equal(stop.rc, 0, stop.stderr);
    assert.equal(stop.stdout, '');
    const journal = join(sb.home, '.claude', 'exec-telemetry', 'personal-friction.jsonl');
    assert.ok(existsSync(journal), 'friction wrote no event');
    const e = readFileSync(journal, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>).find((x) => x.agent_id === 'agent-3');
    assert.equal(e?.trace_kind, 'unknown'); assert.equal(e?.missing_reason, 'no_parser_for_file_kind');
  });
});
