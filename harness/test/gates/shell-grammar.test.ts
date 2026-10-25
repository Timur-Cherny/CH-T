// INVARIANT I1 at the event level: a command the grammar reads only up to a parse error is not silent while the unread
// tail names a word some pre-bash gate judges. Each gate builds its own model and sees only the parsed part, so one gap
// in the grammar before psql or git blinds all of them at once.
// REGRESSION 25.09: `if [[ -f a.sql ]]; then …; fi; psql -c "SET statement_timeout = 0"` passed every gate silently.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox, bashPayload, HARNESS_ROOT, onlyGate } from '../_env.ts';
import { judgeCommand, NAME, KILL } from '../../src/gates/shell-grammar.ts';
import { route } from '../../src/main.ts';
import type { HookPayload } from '../../src/types.ts';

const sb = sandbox('harness-grammar-');
after(() => sb.cleanup());
const env = { HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, HARNESS_ROOT };

describe(NAME, () => {
  it('answers unknown when the unparsed tail names a gate word, at the top level and inside a shell string', () => {
    for (const c of [
      'echo a ) psql -c "SELECT 1"',
      `bash -c 'echo a ) psql -c "SELECT 1"'`,
      'echo a ) git push origin HEAD',
      'echo "$(echo a ;; psql -c x)"',
    ]) assert.equal(judgeCommand(c).kind, 'unknown', c);
  });

  it('does not take text after a closed substitution for an unread tail: `"$(echo a ) psql"` is a string, bash runs no psql', () => {
    assert.equal(judgeCommand('echo "$(echo a ) psql -c x)"').kind, 'silent');
  });

  it('names the unread tail and the word it carries in the reason', () => {
    const v = judgeCommand('echo a ) psql -c "SELECT 1"');
    assert.equal(v.kind, 'unknown');
    assert.match((v as { reason: string }).reason, /psql/);
  });

  it('stays silent on a clean parse and on an unparsed tail without a gate word (both sides)', () => {
    for (const c of ['psql -c "SELECT 1"', 'echo a ) b c', 'if [[ -f a ]]; then echo y; fi', 'git status']) {
      assert.equal(judgeCommand(c).kind, 'silent', c);
    }
  });

  it('is the only owner of a parse error: data-boundary does not claim it, and the glued `[[ … ]];` is denied by pg-session with its own reason', async () => {
    const all = { ...env };
    const gap = await route('pre-bash', bashPayload('echo a ) psql -c "SELECT 1"', { permission_mode: 'default' }) as unknown as HookPayload, all);
    assert.equal(gap.kind, 'ask', JSON.stringify(gap));
    assert.match((gap as { reason: string }).reason, /shell-grammar/);
    assert.doesNotMatch((gap as { reason: string }).reason, /data-boundary/);
    const glued = await route('pre-bash', bashPayload('if [[ -f a.sql ]]; then echo y; fi; psql -c "SET statement_timeout = 0"', { permission_mode: 'default' }) as unknown as HookPayload, all);
    assert.equal(glued.kind, 'deny', JSON.stringify(glued));
    assert.equal((glued as { gate: string }).gate, 'pg-session');
    assert.match((glued as { reason: string }).reason, /statement_timeout/);
  });

  it('reaches the router: deny in auto mode, ask in default, nothing with its kill switch', async () => {
    const cmd = 'echo a ) psql -c "SET statement_timeout = 0"';
    const isolated = { ...env, ...onlyGate(NAME) };
    const auto = await route('pre-bash', bashPayload(cmd, { permission_mode: 'auto' }) as unknown as HookPayload, isolated);
    assert.equal(auto.kind, 'deny', JSON.stringify(auto));
    const manual = await route('pre-bash', bashPayload(cmd, { permission_mode: 'default' }) as unknown as HookPayload, isolated);
    assert.equal(manual.kind, 'ask', JSON.stringify(manual));
    const off = await route('pre-bash', bashPayload(cmd, { permission_mode: 'auto' }) as unknown as HookPayload, { ...isolated, [KILL]: '1' });
    assert.equal(off.kind, 'silent', JSON.stringify(off));
  });
});
