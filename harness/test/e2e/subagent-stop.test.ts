// Acceptance of INC-SUBAGENT-STOP-CONTEXT-REPLACES-REPORT on a live claude -p: a subagent in a directory outside git
// (friction has no roots there) stops exactly once and the root answers with its own result. On the 24.09 probe the
// harness without the fix gave the same scenario 36 SubagentStop events, 4 agent starts and $0.25 instead of $0.03.
// --restricted drops user and project settings, so only this harness answers the hooks. Runs with HARNESS_E2E=1 only.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, HARNESS_ROOT, NODE_BIN } from '../_env.ts';

const E2E = process.env.HARNESS_E2E === '1';

describe('headless subagent stop', { skip: !E2E && 'HARNESS_E2E=1 to run (costs tokens)' }, () => {
  it('lets a subagent stop once and hands the root its own answer', () => {
    const sb = sandbox('harness-e2e-substop-');
    const work = join(sb.dir, 'work'); mkdirSync(work);
    const log = join(sb.dir, 'events.log'); const tap = join(sb.dir, 'tap.sh');
    writeFileSync(tap, `#!/bin/sh\ncat | grep -o '"hook_event_name": *"[A-Za-z]*"' >> '${log}'\n`); chmodSync(tap, 0o755);
    const hook = (event: string, timeout: number) => [{ type: 'command', command: tap }, { type: 'command', command: `${HARNESS_ROOT}/bin/hook ${event}`, timeout }];
    const settings = join(sb.dir, 'settings.json');
    writeFileSync(settings, JSON.stringify({ hooks: {
      SubagentStart: [{ hooks: hook('agent-start', 15) }], SubagentStop: [{ hooks: hook('agent-stop', 30) }], Stop: [{ hooks: hook('stop', 180) }],
      PostToolUse: [{ matcher: 'Bash|Agent', hooks: hook('post', 60) }],
    } }));
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_HARNESS_NODE: NODE_BIN, CLAUDE_STATE_DIR: sb.stateDir };
    delete env.CLAUDECODE;
    const prompt = "Call the Agent tool once with subagent_type general-purpose and run_in_background false. Tell the subagent: run the bash command 'echo probe-ok' and reply with its output only. After the Agent tool returns, reply with the single word DONE.";
    const r = spawnSync('claude', ['-p', prompt, '--restricted', '--tools', 'Bash,Agent', '--settings', settings, '--allowedTools', 'Bash,Agent', '--max-turns', '8', '--output-format', 'json', '--model', 'claude-haiku-4-5-20251001'],
      { cwd: work, env, encoding: 'utf8', input: '', timeout: 300000 });
    assert.equal(r.status, 0, r.stderr.slice(0, 500));
    const events = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
    const count = (name: string): number => events.filter((e) => e.includes(`"${name}"`)).length;
    const out = JSON.parse(r.stdout) as { result: string; num_turns: number };
    console.log(JSON.stringify({ starts: count('SubagentStart'), stops: count('SubagentStop'), turns: out.num_turns, result: out.result.slice(0, 80) }));
    assert.equal(count('SubagentStart'), 1, 'the root had to start the agent again');
    assert.equal(count('SubagentStop'), 1, 'the harness gave the subagent another turn at its stop');
    assert.match(out.result, /DONE/);
    sb.cleanup();
  });
});
