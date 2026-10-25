// Antigravity documents neither exit codes nor what a failed hook means, and PostToolUse has no channel to the model.
// INVARIANT: every Antigravity pre-call is judged by the same gates as Claude's and anything short of a pass is
// {decision: deny}; an unparsed input or an unknown tool is a deny, never an allow; every registry gate is reached by an
// Antigravity event or named N/A; a post finding reaches the model on the next PreInvocation exactly once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { handle, AGY_EVENTS, AGY_NA, addNote } from './antigravity.ts';
import { unreachedGates } from './core.ts';

const baseEnv: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env)
  .filter(([k]) => !k.startsWith('CLAUDE_SKIP_') && k !== 'CLAUDE_HARNESS_UNKNOWN' && k !== 'BRAIN_TASK' && k !== 'BRAIN_MCP_ALLOWED'));
const site = join(mkdtempSync(join(tmpdir(), 'TEST-agy-site-')), 'harness.config.json');
writeFileSync(site, JSON.stringify({ protectedBranches: ['main'], ownerHosts: ['git.corp.example'] }));
const state = mkdtempSync(join(tmpdir(), 'TEST-agy-state-'));
const env = { ...baseEnv, BRAIN_AGY_STATE_DIR: state, CLAUDE_HARNESS_CONFIG: site, BRAIN_MCP_ALLOWED: 'tracker' };
const ws = mkdtempSync(join(tmpdir(), 'TEST-agy-ws-'));
execFileSync('git', ['init', '-q', ws]);

const call = (name: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) => JSON.stringify({
  conversationId: 'conv-1', workspacePaths: [ws], transcriptPath: '/private/transcript', modelName: 'm', toolCall: { name, args }, stepIdx: 3, ...extra,
});

test('every registry gate is reached by an Antigravity event or named N/A with a reason', () => {
  assert.deepEqual(unreachedGates(AGY_EVENTS, AGY_NA), []);
  for (const [k, v] of Object.entries(AGY_NA)) assert.ok(v.length > 10, `${k}: причина N/A обязана быть названа`);
});

test('run_command reaches the commit gate: AI attribution is denied, a clean message is allowed', async () => {
  const denied = await handle('PreToolUse', call('run_command', { CommandLine: 'git commit -m "Generated with Claude"', Cwd: ws }), env);
  assert.equal(denied.decision, 'deny');
  assert.match(String(denied.reason), /commit-msg/);
  const clean = await handle('PreToolUse', call('run_command', { CommandLine: 'git commit -m "fix: adapter"', Cwd: ws }), env);
  assert.equal(clean.decision, 'allow');
});

test('a relative Cwd is refused: the gates judge a command by its directory', async () => {
  const r = await handle('PreToolUse', call('run_command', { CommandLine: 'git status', Cwd: 'sub' }), env);
  assert.equal(r.decision, 'deny');
});

test('write_to_file and every chunk of multi_replace_file_content go through the write gates', async () => {
  const owner = join(ws, 'harness', 'owner', 'x.json');
  const w = await handle('PreToolUse', call('write_to_file', { TargetFile: owner, CodeContent: '{}', Overwrite: true }), env);
  assert.equal(w.decision, 'deny', 'Miss this and the owner directory is writable by the agent');
  const m = await handle('PreToolUse', call('multi_replace_file_content', { TargetFile: 'a.txt', ReplacementChunks: [{ TargetContent: 'a', ReplacementContent: 'b' }, { TargetContent: 'c' }] }), env);
  assert.equal(m.decision, 'deny', 'a chunk without ReplacementContent is not provable');
  const ok = await handle('PreToolUse', call('replace_file_content', { TargetFile: 'a.txt', TargetContent: 'a', ReplacementContent: 'b' }), env);
  assert.equal(ok.decision, 'allow');
});

test('unknown tools, subagents and unlisted MCP are denied; read-only tools and listed MCP pass', async () => {
  for (const [name, args] of [['invoke_subagent', {}], ['define_subagent', {}], ['schedule', {}], ['some_new_tool', {}], ['call_mcp_tool', { ServerName: 'db', ToolName: 'query' }]] as const) {
    assert.equal((await handle('PreToolUse', call(name, args), env)).decision, 'deny', name);
  }
  assert.equal((await handle('PreToolUse', call('view_file', { AbsolutePath: '/etc/hosts' }), env)).decision, 'allow');
  assert.equal((await handle('PreToolUse', call('call_mcp_tool', { ServerName: 'tracker', ToolName: 'list' }), env)).decision, 'allow');
});

test('a malformed input on PreToolUse is a deny, not a crash and not an allow', async () => {
  assert.equal((await handle('PreToolUse', '{', env)).decision, 'deny');
  assert.equal((await handle('PreToolUse', JSON.stringify({ conversationId: 'x', workspacePaths: ['relative'] }), env)).decision, 'deny');
});

test('a post finding waits and reaches the model once, on the next PreInvocation', async () => {
  addNote(env, 'conv-1', 'sweep: файл не разобран');
  const first = await handle('PreInvocation', call('x', {}, { invocationNum: 1 }), env);
  assert.match(JSON.stringify(first), /sweep: файл не разобран/);
  const second = await handle('PreInvocation', call('x', {}, { invocationNum: 2 }), env);
  assert.deepEqual(second, {});
});

test('SessionStart injects the shared workflow and the brain task context, never the transcript', async () => {
  const ctx = join(state, 'ctx.txt'); writeFileSync(ctx, 'Текущая задача: returns');
  const r = await handle('SessionStart', call('x', {}), { ...env, BRAIN_CONTEXT_FILE: ctx });
  const text = JSON.stringify(r);
  assert.match(text, /runtimes\/WORKFLOW.md/); assert.match(text, /Текущая задача: returns/);
  assert.doesNotMatch(text, /private\/transcript/);
});

test('Stop with nothing pending lets the agent stop', async () => {
  const r = await handle('Stop', call('x', {}, { executionNum: 0, terminationReason: 'model_stop', fullyIdle: true }), env);
  assert.equal(r.decision, 'stop');
});

test.after(() => { rmSync(state, { recursive: true, force: true }); rmSync(ws, { recursive: true, force: true }); });

test('a live terminal is not a way around the gates: manage_task input and persistent terminals are refused', async () => {
  assert.equal((await handle('PreToolUse', call('manage_task', { Action: 'send_input', Input: 'git push origin HEAD:main\n' }), env)).decision, 'deny');
  assert.equal((await handle('PreToolUse', call('manage_task', { Action: 'list' }), env)).decision, 'allow');
  assert.equal((await handle('PreToolUse', call('run_command', { CommandLine: "alias p='git push'", Cwd: ws, RunPersistent: true }), env)).decision, 'deny');
  assert.equal((await handle('PreToolUse', call('run_command', { CommandLine: 'ls', Cwd: ws, RequestedTerminalID: 't1' }), env)).decision, 'deny');
  assert.equal((await handle('PreToolUse', call('run_command', { CommandLine: 'ls', Cwd: ws, RunPersistent: false }), env)).decision, 'allow');
});
