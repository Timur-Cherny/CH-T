// INVARIANT I1/R7: отсутствие рантайма = unknown (ask на pre, тишина недопустима как «pass»);
// рантайм харнесса пинуется отдельно от рантайма проекта; префильтр pre-bash не запускает Node без слова-триггера.
// Молча ломалось: v3 бежал под `node` из PATH проекта (default nvm 22, CI node:18) — .ts там не стартует.
// REGRESSION INC-FRICTION-AGENT-WINDOW-PARENT-EDITS: the prefilter cut every agent command without a trigger word before
// Node, so sed -i, heredocs and scripts left no friction trace; such a call now runs Node in observe mode, where a crash
// or a missing runtime never reaches the tool and only a gate declaring `observe` (agent-revert) delivers a verdict.
// REGRESSION 02.10 (equivalence classes): ANSI-C quoting and a command word built from expansions never reached Node —
// the gate denied them, the shim cut them first. A program a shell reads from an argument or a pipe likewise.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sandbox, runHook, fakeNode, bashPayload, payload, HARNESS_ROOT, NODE_BIN } from './_env.ts';

describe('bin/hook', () => {
  const sb = sandbox();
  after(() => sb.cleanup());

  it('answers ask with a reason on pre-events when no Node >= 24 exists — a missing runtime is missing data, not a pass', () => {
    const r = runHook('pre-agent', payload('PreToolUse', { tool_name: 'Agent', tool_input: {} }), sb);
    assert.equal(r.rc, 0);
    const j = r.json as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
    assert.equal(j.hookSpecificOutput.permissionDecision, 'ask');
    assert.match(j.hookSpecificOutput.permissionDecisionReason, /install\.sh|CLAUDE_HARNESS_NODE/);
  });

  it('turns the same missing runtime into additionalContext when CLAUDE_HARNESS_UNKNOWN=note — the headless escape hatch is explicit, not silent', () => {
    const r = runHook('pre-agent', payload('PreToolUse', { tool_name: 'Agent', tool_input: {} }), sb, { CLAUDE_HARNESS_UNKNOWN: 'note' });
    const j = r.json as { hookSpecificOutput: { additionalContext?: string; permissionDecision?: string } };
    assert.equal(j.hookSpecificOutput.permissionDecision, undefined);
    assert.match(j.hookSpecificOutput.additionalContext ?? '', /Node >= 24/);
  });

  it('stays silent with rc 0 on post-events without a runtime and says it once per session on session-start', () => {
    const post = runHook('post', payload('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }), sb);
    assert.deepEqual([post.rc, post.stdout, post.stderr], [0, '', '']);
    const first = runHook('session-start', payload('SessionStart'), sb, { CLAUDE_HARNESS_SESSION: 's1' });
    assert.match((first.json as { systemMessage: string }).systemMessage, /Node >= 24/);
    const second = runHook('session-start', payload('SessionStart'), sb, { CLAUDE_HARNESS_SESSION: 's1' });
    assert.equal(second.stdout, '');
  });

  it('rejects a PATH node below 24 — the project runtime (nvm default 22, CI node:18) never becomes the harness runtime', () => {
    const bin = join(sb.dir, 'bin22'); fakeNode(bin, '22.17.1');
    const r = runHook('pre-agent', payload('PreToolUse', { tool_name: 'Agent', tool_input: {} }), sb, {}, { path: `${bin}:/usr/bin:/bin` });
    assert.equal((r.json as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision, 'ask');
  });

  // REGRESSION 25.09 (P1): a missing runtime answered ask in every mode; in an unattended mode ask runs the tool, so
  // the barrier was open exactly where no human sees the question. The mode comes from the payload, not from
  // CLAUDE_HARNESS_UNKNOWN, so a fresh unattended session is closed without any env set.
  const decision = (r: ReturnType<typeof runHook>): string => (r.json as { hookSpecificOutput?: { permissionDecision?: string } })?.hookSpecificOutput?.permissionDecision ?? 'none';
  it('fails closed on a missing runtime in unattended modes (deny), asks only where a human is watching', () => {
    for (const mode of ['auto', 'bypassPermissions', 'dontAsk']) {
      assert.equal(decision(runHook('pre-bash', bashPayload('git push', { permission_mode: mode }), sb)), 'deny', mode);
      assert.equal(decision(runHook('pre-agent', payload('PreToolUse', { tool_name: 'Agent', tool_input: {}, permission_mode: mode }), sb)), 'deny', mode);
    }
    for (const mode of ['default', 'acceptEdits', 'plan']) {
      assert.equal(decision(runHook('pre-bash', bashPayload('git push', { permission_mode: mode }), sb)), 'ask', mode);
    }
    assert.equal((runHook('pre-bash', bashPayload('git push', { permission_mode: 'auto' }), sb, { CLAUDE_HARNESS_UNKNOWN: 'note' }).json as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext !== undefined, true);
  });

  it('fails closed when the gate runtime crashes with an exit code other than 0/2 (P1)', () => {
    const bin = join(sb.dir, 'crashbin'); const rec = join(sb.dir, 'crash-env.txt');
    const node = fakeNode(bin, '24.20.0');
    // A runtime that satisfies -v but exits 1 on the real run — an import-time error, a bad NODE_OPTIONS, an OOM.
    writeFileSync(node, `#!/bin/sh\nif [ "$1" = "-v" ]; then echo v24.20.0; exit 0; fi\nprintf '%s' "\${NODE_OPTIONS:-CLEARED}" > '${rec}'\ncat >/dev/null\necho 'TypeError: boom' >&2\nexit 1\n`);
    assert.equal(decision(runHook('pre-bash', bashPayload('git push', { permission_mode: 'auto' }), sb, { CLAUDE_HARNESS_NODE: node })), 'deny');
    assert.equal(decision(runHook('pre-bash', bashPayload('git push', { permission_mode: 'default' }), sb, { CLAUDE_HARNESS_NODE: node })), 'ask');
    assert.equal(readFileSync(rec, 'utf8'), 'CLEARED', 'NODE_OPTIONS must be cleared before the harness runtime runs — it is an injection seam');
  });

  it('passes a real deny (node rc 2) and a real allow (rc 0) straight through — the crash contract does not touch them', () => {
    const bin = join(sb.dir, 'rcbin'); const node = fakeNode(bin, '24.20.0');
    writeFileSync(node, `#!/bin/sh\nif [ "$1" = "-v" ]; then echo v24.20.0; exit 0; fi\ncat >/dev/null\ncase "$*" in *pre-bash*) echo 'deny reason' >&2; exit 2 ;; *) exit 0 ;; esac\n`);
    const denied = runHook('pre-bash', bashPayload('git push', { permission_mode: 'auto' }), sb, { CLAUDE_HARNESS_NODE: node });
    assert.equal(denied.rc, 2);
    assert.match(denied.stderr, /deny reason/);
    assert.equal(runHook('pre-agent', payload('PreToolUse', { tool_name: 'Agent', tool_input: {}, permission_mode: 'auto' }), sb, { CLAUDE_HARNESS_NODE: node }).rc, 0);
  });

  // REGRESSION 25.09 (P2): the prefilter grepped the raw command, so quote/backslash insertion that the shell strips
  // (g''it, gl""ab, kube\ctl) slid past it and never reached the router — a denylist in front of the allowlist gate.
  // It now matches a copy with quotes and backslashes removed; the router still sees the original payload.
  const reachesNode = (command: string): boolean => {
    const rec = join(sb.dir, `reach-${Math.random().toString(36).slice(2)}.txt`);
    const node = fakeNode(join(sb.dir, `rn-${Math.random().toString(36).slice(2)}`), '24.20.0', rec);
    runHook('pre-bash', bashPayload(command), sb, { CLAUDE_HARNESS_NODE: node });
    return existsSync(rec);
  };
  it('reaches the router on quote/backslash-obfuscated trigger words, and skips a command with no trigger at all', () => {
    for (const c of [`g''it push origin HEAD:product/main`, `gl""ab release create v1`, `kube\\ctl get secret db -o yaml`, `ps''ql -c "SET statement_timeout = 0"`]) {
      assert.equal(reachesNode(c), true, c);
    }
    for (const c of ['ls -la', 'echo hello world', 'cat README.md']) {
      assert.equal(reachesNode(c), false, c);
    }
  });

  it('reaches the router on ANSI-C quoting, a command word from expansions, eval and a shell fed its program', () => {
    for (const c of ["$'\\x67it' push origin HEAD:product/main", "g$'\\x69't tag v9", 'a=gi; b=t; $a$b push origin HEAD:product/main', 'eval "$X"',
      'sh -c "$X"', "echo 'git push origin HEAD:product/main' | sh", 'git config alias.yeet "$V"']) {
      assert.equal(reachesNode(c), true, c);
    }
    for (const c of ['echo $HOME', 'ls -la "$DIR"', 'cat a | grep b']) assert.equal(reachesNode(c), false, c);
  });

  it('uses CLAUDE_HARNESS_NODE first and hands it src/main.ts with the event name', () => {
    const rec = join(sb.dir, 'rec-env.txt'); const p = fakeNode(join(sb.dir, 'pin'), '24.99.0', rec);
    runHook('pre-agent', payload('PreToolUse', { tool_name: 'Agent', tool_input: {} }), sb, { CLAUDE_HARNESS_NODE: p });
    const lines = readFileSync(rec, 'utf8').trim().split('\n');
    assert.equal(lines[0], 'v24.99.0');
    assert.ok(lines.includes(join(HARNESS_ROOT, 'src', 'main.ts')), lines.join(' '));
    assert.equal(lines.at(-1), 'pre-agent');
  });

  it('picks v24.20.0 over v24.9.0 under ~/.nvm — numeric minor comparison, not lexicographic', () => {
    const rec = join(sb.dir, 'rec-nvm.txt');
    for (const v of ['24.9.0', '24.20.0', '18.20.5']) fakeNode(join(sb.home, '.nvm', 'versions', 'node', `v${v}`, 'bin'), v, rec);
    runHook('pre-agent', payload('PreToolUse', { tool_name: 'Agent', tool_input: {} }), sb);
    assert.equal(readFileSync(rec, 'utf8').split('\n')[0], 'v24.20.0');
  });

  it('carries CLAUDE_HARNESS_TS from harness.env into the child — without it the structural checks answer unknown', () => {
    const sb2 = sandbox('harness-shim-ts-');
    try {
      const bin = join(sb2.dir, 'bin');
      const node = fakeNode(bin, '24.20.0');
      const seen = join(sb2.dir, 'seen-ts.txt');
      writeFileSync(node, `#!/bin/sh\nif [ "$1" = "-v" ]; then echo v24.20.0; exit 0; fi\nprintf '%s' "$\{CLAUDE_HARNESS_TS:-NONE}" > '${seen}'\ncat >/dev/null\nexit 0\n`);
      mkdirSync(join(sb2.home, '.claude', 'env'), { recursive: true });
      writeFileSync(join(sb2.home, '.claude', 'env', 'harness.env'), `CLAUDE_HARNESS_NODE=${node}\nCLAUDE_HARNESS_TS=/pinned/typescript.js\n`);
      runHook('post', payload('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }), sb2, {});
      assert.equal(readFileSync(seen, 'utf8'), '/pinned/typescript.js', 'пин TypeScript не доехал до роутера');
    } finally { sb2.cleanup(); }
  });

  it('reads ~/.claude/env/harness.env written by install.sh when no env override is set', () => {
    const sb2 = sandbox(); const rec = join(sb2.dir, 'rec.txt'); const p = fakeNode(join(sb2.dir, 'envnode'), '24.50.0', rec);
    mkdirSync(join(sb2.home, '.claude', 'env'), { recursive: true });
    writeFileSync(join(sb2.home, '.claude', 'env', 'harness.env'), `CLAUDE_HARNESS_NODE=${p}\n`);
    runHook('post', payload('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }), sb2);
    assert.equal(readFileSync(rec, 'utf8').split('\n')[0], 'v24.50.0');
    sb2.cleanup();
  });

  it('does not start Node for a pre-bash command without trigger words, and does for `kubectl exec pod -- psql`', () => {
    const rec = join(sb.dir, 'rec-pre.txt'); const p = fakeNode(join(sb.dir, 'prenode'), '24.20.0', rec);
    runHook('pre-bash', bashPayload('ls -la && echo hi'), sb, { CLAUDE_HARNESS_NODE: p });
    assert.equal(existsSync(rec), false, 'Node запущен без слова-триггера');
    runHook('pre-bash', bashPayload("kubectl exec pod-x -- psql -c 'select 1'"), sb, { CLAUDE_HARNESS_NODE: p });
    assert.equal(existsSync(rec), true, 'Node не запущен при psql внутри команды');
  });

  it('runs Node for an agent pre-bash without trigger words in observe mode: the router verdict under HARNESS_OBSERVE=1 reaches the tool, a crash or a missing runtime does not', () => {
    const agentBash = (command: string) => payload('PreToolUse', { tool_name: 'Bash', tool_input: { command }, tool_use_id: 'toolu_obs', agent_id: 'agent-obs', permission_mode: 'auto' });
    const rec = join(sb.dir, 'rec-observe.txt'); const p = fakeNode(join(sb.dir, 'obsnode'), '24.20.0', rec);
    const seen = runHook('pre-bash', agentBash('sed -i s/a/b/ x.py'), sb, { CLAUDE_HARNESS_NODE: p });
    assert.equal(existsSync(rec), true, 'Node не запущен для pre-bash агента');
    assert.deepEqual([seen.rc, seen.stdout], [0, '']);
    const bin = join(sb.dir, 'obsdeny'); const deny = fakeNode(bin, '24.20.0');
    writeFileSync(deny, `#!/bin/sh\nif [ "$1" = "-v" ]; then echo v24.20.0; exit 0; fi\ncat >/dev/null\n[ "$HARNESS_OBSERVE" = 1 ] || exit 0\necho 'agent-revert: deny reason' >&2\nexit 2\n`);
    const observed = runHook('pre-bash', agentBash('git checkout -- x.py'), sb, { CLAUDE_HARNESS_NODE: deny });
    assert.deepEqual([observed.rc, observed.stderr.trim()], [2, 'agent-revert: deny reason'], 'the observe-mode verdict did not reach the tool, or HARNESS_OBSERVE was not passed');
    const crash = join(sb.dir, 'obscrash'); const c = fakeNode(crash, '24.20.0');
    writeFileSync(c, `#!/bin/sh\nif [ "$1" = "-v" ]; then echo v24.20.0; exit 0; fi\ncat >/dev/null\nexit 1\n`);
    const crashed = runHook('pre-bash', agentBash('sed -i s/a/b/ x.py'), sb, { CLAUDE_HARNESS_NODE: c });
    assert.deepEqual([crashed.rc, crashed.stdout], [0, '']);
    const missing = runHook('pre-bash', agentBash('sed -i s/a/b/ x.py'), sb, { CLAUDE_HARNESS_NODE: join(sb.dir, 'no-such-node') }, { path: '/usr/bin:/bin' });
    assert.deepEqual([missing.rc, missing.stdout], [0, '']);
    const always = join(sb.dir, 'alwaysdeny'); const real = fakeNode(always, '24.20.0');
    writeFileSync(real, `#!/bin/sh\nif [ "$1" = "-v" ]; then echo v24.20.0; exit 0; fi\ncat >/dev/null\n[ -z "$HARNESS_OBSERVE" ] || exit 0\necho 'deny reason' >&2\nexit 2\n`);
    assert.equal(runHook('pre-bash', payload('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'git push' }, agent_id: 'agent-obs', permission_mode: 'auto' }), sb, { CLAUDE_HARNESS_NODE: real }).rc, 2, 'a trigger word keeps the real barrier, outside the observe mode');
  });

  it('exports NODE_COMPILE_CACHE under CLAUDE_STATE_DIR and HARNESS_ROOT as the physical harness path', () => {
    const rec = join(sb.dir, 'rec-envvars.txt');
    const bin = join(sb.dir, 'envprobe'); mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'node'), `#!/bin/sh\n[ "$1" = "-v" ] && { echo v24.20.0; exit 0; }\nprintf '%s\\n%s\\n' "$NODE_COMPILE_CACHE" "$HARNESS_ROOT" > '${rec}'\ncat >/dev/null\n`, { mode: 0o755 });
    runHook('post', payload('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }), sb, { CLAUDE_HARNESS_NODE: join(bin, 'node') });
    const [cache, root] = readFileSync(rec, 'utf8').trim().split('\n');
    assert.equal(cache, join(sb.stateDir, 'compile-cache'));
    assert.equal(root, HARNESS_ROOT);
  });
});

// REGRESSION 25.09: .claude/bin/hook handed every event to the user-level harness as soon as ~/.claude/harness existed.
// install.sh creates that link and binds nothing — and the auto-Node step of a cloud SessionStart runs install.sh — so
// from the next event on the barrier was off for the rest of the session. The shim defers only the events that
// ~/.claude/settings.json binds to harness/bin/hook.
describe('.claude/bin/hook — the repo-level entry', () => {
  const sb = sandbox('harness-repo-shim-');
  after(() => sb.cleanup());
  const shim = join(HARNESS_ROOT, '..', '.claude', 'bin', 'hook');
  const userSettings = join(sb.home, '.claude', 'settings.json');
  mkdirSync(join(sb.home, '.claude'), { recursive: true });
  symlinkSync(HARNESS_ROOT, join(sb.home, '.claude', 'harness'));
  const rec = join(sb.dir, 'reached.txt');
  const fake = fakeNode(join(sb.dir, 'n24'), '24.20.0', rec);
  const run = (event: string, body: unknown, node = fake) => spawnSync('sh', [shim, event], {
    input: JSON.stringify(body), encoding: 'utf8', timeout: 20000,
    env: { PATH: '/usr/bin:/bin', HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, CLAUDE_HARNESS_CONFIG: join(sb.home, '.claude', 'harness.config.json'), CLAUDE_HARNESS_NODE: node },
  });
  const reached = (): boolean => { const hit = existsSync(rec); rmSync(rec, { force: true }); return hit; };
  const agent = payload('PreToolUse', { tool_name: 'Agent', tool_input: { description: 'x', prompt: 'y', subagent_type: 'general-purpose', model: 'haiku' } });

  it('runs the barrier itself when the user-level link exists but ~/.claude/settings.json binds nothing', () => {
    run('pre-agent', agent);
    assert.equal(reached(), true, 'no user settings at all — the cloud case after auto-Node');
    writeFileSync(userSettings, '{ "model": "opus" }\n');
    run('pre-agent', agent);
    assert.equal(reached(), true, 'own settings without the hooks block — install step 3 skipped');
  });

  it('defers exactly the events the user-level settings bind, so each event runs once and none is dropped', () => {
    const bind = (ev: string) => ({ hooks: [{ type: 'command', command: `"$HOME"/.claude/harness/bin/hook ${ev}` }] });
    writeFileSync(userSettings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', ...bind('pre-bash') }], PostToolUse: [bind('post')] } }, null, 2));
    run('pre-bash', bashPayload('git push'));
    assert.equal(reached(), false, 'pre-bash is bound at user level');
    run('pre-agent', agent);
    assert.equal(reached(), true, 'pre-agent is not bound at user level');
    run('post', payload('PostToolUse'));
    assert.equal(reached(), false, 'post is bound at user level');
    run('post-batch', payload('PostToolBatch'));
    assert.equal(reached(), true, 'a `post` binding does not cover post-batch');
  });

  it('denies an explicit-model Agent call through the repo-level entry with the real router', () => {
    rmSync(userSettings, { force: true });
    const r = run('pre-agent', agent, NODE_BIN);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /model-gate/);
  });
});
