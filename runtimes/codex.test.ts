// Codex 0.154 treats a PreToolUse `ask` as a hook error and runs the tool, kills a hook on its timeout, and never hands
// the hook the command's `workdir`; a gate the adapter never reached or rendered wrongly let the call through without a word.
// INVARIANT: every pre-call Codex makes is judged by the same gates as Claude's, and anything short of a clean pass is a
// block (rc 2); every registry gate is either reached by a Codex event or named N/A with a reason; a call whose verdict
// depends on its repository names that directory in the command itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { handle, payloadOf, patchCalls, patchChecks, renderCodex, CODEX_NA, CODEX_EVENTS } from './codex.ts';
import '../harness/src/gates/index.ts';
import { GATES } from '../harness/src/gates/registry.ts';

const payload = (tool_name = 'Bash', command = 'pwd', extra: Record<string, unknown> = {}, cwd = tmpdir()) => ({
  hook_event_name: 'PreToolUse', session_id: 'TEST', cwd, tool_name, tool_input: { command, ...extra },
});
const baseEnv: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env)
  .filter(([k]) => !k.startsWith('CLAUDE_SKIP_') && k !== 'CLAUDE_HARNESS_UNKNOWN' && k !== 'BRAIN_TASK'));
// A company site as a harness.config.json declares it; the gates read hosts and branches from here only.
const site = join(mkdtempSync(join(tmpdir(), 'TEST-brain-site-')), 'harness.config.json');
writeFileSync(site, JSON.stringify({ protectedBranches: ['team/main'], integrationBranches: ['team/dev'], ownerHosts: ['git.corp.example'] }));
const env = { ...baseEnv, BRAIN_MCP_ALLOWED: 'tracker', BRAIN_CODEX_STATE_DIR: join(tmpdir(), 'TEST-unused-brain-state'), CLAUDE_HARNESS_CONFIG: site };
const reason = (v: { kind: string; reason?: string; text?: string }): string => v.reason ?? v.text ?? '';
const patch = (...body: string[]) => ['*** Begin Patch', ...body, '*** End Patch'].join('\n');

function repo(dir: string, remote: string): string {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', remote]);
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
  return dir;
}

test('payload rejects missing identity and strips private transcript/output fields', () => {
  assert.throws(() => payloadOf('{}'));
  const p = payloadOf(JSON.stringify({ ...payload(), transcript_path: '/private', prompt: 'SECRET', tool_response: { stdout: 'SECRET' } }));
  assert.equal(p.session_id, 'codex:TEST');
  assert.doesNotMatch(JSON.stringify(p), /SECRET|transcript/);
});

test('canonical command reaches the existing commit gate: deny and clean control', async () => {
  const denied = await handle(JSON.stringify(payload('Bash', 'git commit -m "Generated with Claude"')), env);
  assert.equal(denied.verdict.kind, 'deny');
  assert.equal(renderCodex(denied.verdict, denied.event).rc, 2);
  const clean = await handle(JSON.stringify(payload('Bash', 'git commit -m "NO-JS: update adapter"')), env);
  assert.equal(clean.verdict.kind, 'silent');
});

test('wrong-contract cmd is refused, never silently substituted for a missing command', async () => {
  const p = { ...payload(), tool_input: { cmd: 'pwd' } };
  const result = await handle(JSON.stringify(p), env);
  assert.equal(result.verdict.kind, 'deny');
});

test('a malformed patch is refused, never asked — Codex runs a tool whose hook answered ask', async () => {
  const result = await handle(JSON.stringify(payload('apply_patch', 'not a patch')), env);
  assert.equal(result.verdict.kind, 'deny', 'Miss this and an unparsed patch is applied with no gate having seen it');
  assert.equal(renderCodex(result.verdict, result.event).rc, 2);
});

test('an ask from a gate is rendered as a block on pre events, whatever CLAUDE_HARNESS_UNKNOWN says except note', () => {
  const ask = { kind: 'ask' as const, gate: 'data-boundary', reason: 'host from a variable' };
  for (const mode of [undefined, 'ask', 'deny']) {
    const out = renderCodex(ask, 'pre-bash');
    assert.equal(out.rc, 2, `CLAUDE_HARNESS_UNKNOWN=${mode}: Miss this and Codex prints the rows it was asked about`);
    assert.doesNotMatch(out.stdout, /"ask"/);
  }
});

test('patch maps multiple files and move destination to post-write checks', () => {
  const p = payloadOf(JSON.stringify(payload('apply_patch', patch('*** Add File: first.txt', '+one', '*** Update File: old.txt', '*** Move to: new.txt', '@@', '-old', '+new'))));
  const calls = patchCalls(p);
  assert.equal(calls.length, 2);
  assert.match(JSON.stringify(calls[1]), /new.txt/);
});

test('an update hunk reaches pre-write as an edit with the exact old and new text, as Claude sends it', () => {
  const p = payloadOf(JSON.stringify(payload('apply_patch', patch('*** Update File: notes/a.md', '@@', ' keep', '-old line', '+new line', '*** End of File'))));
  const checks = patchChecks(p);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].event, 'pre-write');
  const ti = (checks[0].payload as { tool_input: Record<string, unknown> }).tool_input;
  assert.equal(ti.old_string, 'keep\nold line', 'Miss this and memory-frontmatter cannot rebuild the file and refuses every note edit');
  assert.equal(ti.new_string, 'keep\nnew line');
});

test('a bad migration added by patch is refused before it is written', async () => {
  const badMigration = payload('apply_patch', patch('*** Add File: src/migration/bad.ts', '+export class Bad {}'));
  const result = await handle(JSON.stringify(badMigration), env);
  assert.equal(result.verdict.kind, 'deny');
});

test('deleting or moving an owner file by patch is refused like rm and mv — a delete was invisible to every gate', async () => {
  const del = await handle(JSON.stringify(payload('apply_patch', patch('*** Delete File: harness/owner/pre-push-exceptions.json'))), env);
  assert.equal(del.verdict.kind, 'deny', 'Miss this and the owner exception list disappears with no gate having seen the path');
  const move = await handle(JSON.stringify(payload('apply_patch', patch('*** Update File: harness/owner/rules.json', '*** Move to: tmp/rules.json'))), env);
  assert.equal(move.verdict.kind, 'deny');
  const control = await handle(JSON.stringify(payload('apply_patch', patch('*** Delete File: notes/old.txt'))), env);
  assert.equal(control.verdict.kind, 'silent');
});

test('a patch written through an apply_patch heredoc in Bash is judged as a patch', async () => {
  const heredoc = (dir: string, file: string) => `cd ${dir} && apply_patch <<'EOF'\n${patch(`*** Add File: ${file}`, '+{}')}\nEOF`;
  const harness = join(tmpdir(), 'TEST-brain-heredoc', 'harness');
  const owner = await handle(JSON.stringify(payload('Bash', heredoc(harness, 'owner/x.json'))), env);
  assert.equal(owner.verdict.kind, 'deny', 'Miss this and the owner directory is written by a patch the file gates never saw');
  const control = await handle(JSON.stringify(payload('Bash', heredoc(harness, 'notes/x.json'))), env);
  assert.equal(control.verdict.kind, 'silent');
  const relative = await handle(JSON.stringify(payload('Bash', heredoc('harness', 'owner/x.json'))), env);
  assert.match(reason(relative.verdict), /workdir/, 'A relative cd resolves against the workdir the hook never sees');
});

test('a directory-bound git or glab call without an explicit absolute directory is refused — the hook never sees workdir', async () => {
  // Probe 24.09 on Codex 0.154: the model called exec_command with workdir=<sub>, the hook got the session cwd and tool_input {command} only.
  const dir = mkdtempSync(join(tmpdir(), 'TEST-brain-workdir-'));
  try {
    const corp = repo(join(dir, 'corp'), 'https://git.corp.example/team/tmp.git');
    const gh = repo(join(dir, 'gh'), 'https://github.com/example/tmp.git');
    const tag = 'push origin HEAD:refs/tags/v9.9.9';
    const bare = await handle(JSON.stringify(payload('Bash', `git ${tag}`, {}, gh)), env);
    assert.equal(bare.verdict.kind, 'deny', 'Miss this and owner-actions judges the session repo while the tag lands wherever workdir pointed');
    assert.match(reason(bare.verdict), /явн/);
    const relative = await handle(JSON.stringify(payload('Bash', `cd ../corp && git ${tag}`, {}, gh)), env);
    assert.match(reason(relative.verdict), /явн/);
    const viaC = await handle(JSON.stringify(payload('Bash', `git -C ${corp} ${tag}`, {}, gh)), env);
    assert.match(reason(viaC.verdict), /owner-actions/);
    const viaCd = await handle(JSON.stringify(payload('Bash', `cd ${corp} && git ${tag}`, {}, gh)), env);
    assert.match(reason(viaCd.verdict), /owner-actions/);
    const hiddenShapes = [
      `(cd ${corp}); git ${tag}`, `sh -c 'git ${tag}'`, `echo x | xargs git ${tag}`, 'git pp', 'glab mr merge 1',
      `bash -lc 'git ${tag}'`, `zsh -fc 'git push origin HEAD:team/main'`, `sh -c "sh -c 'git ${tag}'"`,
      `git -C "$PWD" ${tag}`, `cd "$PWD" && git tag v9.9.9`, `C="cd ${corp}"; cd ${gh} && eval $C; git ${tag}`,
      `cd ${corp}; X=$(false) && cd ${gh}; git ${tag}`, 'git commit -F msg.txt',
    ];
    for (const hidden of hiddenShapes) {
      const r = await handle(JSON.stringify(payload('Bash', hidden, {}, gh)), env);
      assert.match(reason(r.verdict), /явн/, `Miss this and «${hidden}» is judged in the session repository, not where it runs`);
    }
    for (const bound of [`git -C ${gh} commit -F msg.txt`, 'git commit -m "x"', `git commit -F ${join(gh, 'msg.txt')}`]) {
      const r = await handle(JSON.stringify(payload('Bash', bound, {}, gh)), env);
      assert.doesNotMatch(reason(r.verdict), /явн/, bound);
    }
    const legacy = process.env.CLAUDE_HARNESS_SHELL_PARSER;
    process.env.CLAUDE_HARNESS_SHELL_PARSER = 'legacy';
    try {
      const leaked = await handle(JSON.stringify(payload('Bash', `(cd ${corp}); git ${tag}`, {}, gh)), env);
      assert.match(reason(leaked.verdict), /явн/, 'The legacy parser has no shell scopes, so only git -C may name the directory');
      const named = await handle(JSON.stringify(payload('Bash', `git -C ${corp} ${tag}`, {}, gh)), env);
      assert.match(reason(named.verdict), /owner-actions/);
    } finally {
      if (legacy === undefined) delete process.env.CLAUDE_HARNESS_SHELL_PARSER; else process.env.CLAUDE_HARNESS_SHELL_PARSER = legacy;
    }
    for (const safe of ['git status', 'git tag -l', `git -C ${gh} log -1`]) {
      const r = await handle(JSON.stringify(payload('Bash', safe, {}, gh)), env);
      assert.doesNotMatch(reason(r.verdict), /явн/, safe);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a command for a shell outside the sh family is refused — the gates parse sh syntax only', async () => {
  const fish = await handle(JSON.stringify(payload('Bash', 'pwd', { shell: 'fish' })), env);
  assert.equal(fish.verdict.kind, 'deny');
  const zsh = await handle(JSON.stringify(payload('Bash', 'pwd', { shell: '/bin/zsh' })), env);
  assert.equal(zsh.verdict.kind, 'silent');
});

test('a deny arrives before resource-guard starts waiting — a hook killed on timeout loses the deny', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'TEST-brain-resource-'));
  try {
    const corp = repo(join(dir, 'corp'), 'https://git.corp.example/team/tmp.git');
    const starved = { ...env, RESOURCE_GUARD_MIN_MB: '99999999', RESOURCE_GUARD_WAIT_S: '6', RESOURCE_GUARD_POLL_S: '1' };
    const t0 = performance.now();
    const r = await handle(JSON.stringify(payload('Bash', `cd ${corp} && npm test && git push origin HEAD:refs/tags/v9.9.9`)), starved);
    assert.match(reason(r.verdict), /owner-actions/);
    assert.ok(performance.now() - t0 < 3000, 'Miss this and the deny waits behind a 240 s resource wait that the hook timeout cuts off');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('only the listed MCP servers pass; write_stdin, spawn_agent and any other tool are refused', async () => {
  for (const tool of ['write_stdin', 'spawn_agent', 'mcp__node_repl__js', 'some_new_tool']) {
    const r = await handle(JSON.stringify(payload(tool, 'x')), env);
    assert.equal(r.verdict.kind, 'deny', `${tool}: Miss this and input reaches a live terminal or a subagent past every gate`);
  }
  const tracker = await handle(JSON.stringify(payload('mcp__tracker__tracker_list', 'x')), env);
  assert.equal(tracker.verdict.kind, 'silent');
});

test('a kill switch in the environment does not lift a gate for a brain task', async () => {
  const del = JSON.stringify(payload('apply_patch', patch('*** Delete File: harness/owner/pre-push-exceptions.json')));
  const task = await handle(del, { ...env, BRAIN_TASK: 'APP-1', CLAUDE_SKIP_OWNER_FILES: '1' });
  assert.equal(task.verdict.kind, 'deny', 'Miss this and one inherited CLAUDE_SKIP_* turns a gate off for every executor');
  const manual = await handle(del, { ...env, CLAUDE_SKIP_OWNER_FILES: '1' });
  assert.equal(manual.verdict.kind, 'silent');
});

test('Stop and SessionStart output carries only the fields their Codex schema accepts', () => {
  const context = { kind: 'context' as const, gate: 'sweep-stop', text: 'findings again' };
  const stop = JSON.parse(renderCodex(context, 'stop').stdout);
  const allowed = ['continue', 'decision', 'reason', 'stopReason', 'suppressOutput', 'systemMessage'];
  assert.deepEqual(Object.keys(stop).filter((k) => !allowed.includes(k)), [], 'Miss this and Codex rejects the whole Stop output');
  assert.equal(stop.systemMessage, 'sweep-stop: findings again');
  const block = JSON.parse(renderCodex({ kind: 'block', gate: 'sweep-stop', reason: 'bad.json' }, 'stop').stdout);
  assert.equal(block.decision, 'block');
  const start = JSON.parse(renderCodex({ kind: 'block', gate: 'x', reason: 'r' }, 'session-start').stdout);
  assert.ok(!('decision' in start));
});

test('every registry gate is reached by a Codex event or named N/A with a reason', () => {
  const handled = new Set<string>(CODEX_EVENTS);
  const orphans = GATES.filter((g) => !(g.name in CODEX_NA) && !g.events.some((e) => handled.has(e))).map((g) => g.name);
  assert.deepEqual(orphans, [], 'Miss this and a new gate silently never runs for Codex');
  const stale = Object.keys(CODEX_NA).filter((n) => !GATES.some((g) => g.name === n));
  assert.deepEqual(stale, []);
  for (const [name, why] of Object.entries(CODEX_NA)) assert.ok(why.trim().length > 10, `${name}: N/A without a reason`);
});

test('session instructions reference shared source without reading transcript', async () => {
  const result = await handle(JSON.stringify({ ...payload(), hook_event_name: 'SessionStart', transcript_path: '/does-not-exist' }), env);
  assert.equal(result.verdict.kind, 'context');
  assert.match(JSON.stringify(result.verdict), /runtimes\/WORKFLOW.md/);
});

test('one patch covering two repositories checks both, without dedup dropping the second', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'TEST-brain-multi-'));
  try {
    const first = join(dir, 'one'); const second = join(dir, 'two');
    for (const r of [first, second]) { mkdirSync(r); execFileSync('git', ['init', '-q', r]); }
    writeFileSync(join(first, 'first.json'), '{}');
    writeFileSync(join(second, 'second.json'), '{broken');
    const p = { ...payload('apply_patch', patch(`*** Add File: ${first}/first.json`, '+{}', `*** Add File: ${second}/second.json`, '+{broken')),
      hook_event_name: 'PostToolUse', cwd: first, tool_use_id: 'same-patch' };
    const result = await handle(JSON.stringify(p), { ...env, BRAIN_CODEX_STATE_DIR: join(dir, 'state') });
    assert.equal(result.verdict.kind, 'context');
    assert.match(JSON.stringify(result.verdict), /second.json/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('real changed-tree Stop fails on invalid JSON, then clears after repair; state is isolated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'TEST-brain-'));
  try {
    const r = join(dir, 'repo'); mkdirSync(r);
    execFileSync('git', ['init', '-q', r]);
    const stateDir = join(dir, 'state');
    const ownEnv = { ...env, BRAIN_CODEX_STATE_DIR: stateDir, CLAUDE_SKIP_CONTOUR_SUITE: '1' };
    const p = { hook_event_name: 'Stop', session_id: 'TEST-stop', cwd: r };
    writeFileSync(join(r, 'bad.json'), '{ broken');
    const bad = await handle(JSON.stringify(p), ownEnv);
    assert.equal(bad.verdict.kind, 'block');
    const repeated = await handle(JSON.stringify({ ...p, stop_hook_active: true }), ownEnv);
    assert.notEqual(repeated.verdict.kind, 'block');
    writeFileSync(join(r, 'bad.json'), '{}');
    const fixed = await handle(JSON.stringify(p), ownEnv);
    assert.equal(fixed.verdict.kind, 'silent');
    assert.ok(existsSync(join(stateDir, 'harness.db')));
    assert.ok(!existsSync(join(dir, '.claude')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('every other shell form of the patch command is refused: applypatch, a semicolon cd, a pipe', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'TEST-brain-applypatch-'));
  try {
    const body = patch('*** Add File: harness/owner/pre-push-exceptions.json', '+{}');
    for (const command of [`applypatch <<'EOF'\n${body}\nEOF`, `cd ${dir}; apply_patch <<'EOF'\n${body}\nEOF`, `cat p.txt | apply_patch`, `bash -c "applypatch < p.txt"`]) {
      const r = await handle(JSON.stringify(payload('Bash', command, {}, dir)), env);
      assert.equal(r.verdict.kind, 'deny', `${command.split('\n')[0]}: Miss this and the patch writes past every write gate`);
    }
    const heredoc = await handle(JSON.stringify(payload('Bash', `cd ${dir} && applypatch <<'EOF'\n${body}\nEOF`, {}, dir)), env);
    assert.equal(heredoc.verdict.kind, 'deny');
    assert.match(JSON.stringify(heredoc.verdict), /owner-files/, 'the parsed heredoc form reaches the write gates');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the patch hook runs no checkout code: .claude/check.sh and the project TypeScript stay off outside the client sandbox', async () => {
  const { SANDBOX_SKIPS } = await import('./core.ts');
  assert.deepEqual(SANDBOX_SKIPS, { CLAUDE_HARNESS_SANDBOXED: '1' });
  const { CHECKERS } = await import('../harness/src/checks/registry.ts');
  assert.deepEqual(CHECKERS.filter((c) => c.runsCheckoutCode).map((c) => c.name).sort(), ['contour-suite', 'project-check', 'tsc-project']);
});
