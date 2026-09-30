// INVARIANT I8: контракт выхода живёт в одной функции; I1: unknown никогда не схлопывается в silent.
// Молча ломалось: `readme-inventory --check || exit 1` первым в check.sh глушил остальные проверки (класс К2).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { merge, render } from '../src/emit.ts';
import type { Verdict } from '../src/types.ts';

describe('render', () => {
  it('maps deny to rc 2 with the reason on stderr and nothing on stdout', () => {
    const r = render({ kind: 'deny', reason: 'явная модель', gate: 'model-gate' }, 'pre-agent');
    assert.deepEqual(r, { rc: 2, stdout: '', stderr: 'model-gate: явная модель\n' });
  });
  it('maps ask to rc 0 and a PreToolUse permissionDecision with the gate name in the reason', () => {
    const r = render({ kind: 'ask', reason: 'парсер недоступен', gate: 'pg' }, 'pre-bash');
    assert.equal(r.rc, 0);
    assert.deepEqual(JSON.parse(r.stdout), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'pg: парсер недоступен' } });
  });
  it('maps block to the Stop decision object', () => {
    assert.deepEqual(JSON.parse(render({ kind: 'block', reason: '2 файла не проверены', gate: 'sweep' }, 'stop').stdout), { decision: 'block', reason: 'sweep: 2 файла не проверены' });
  });
  it('maps context to additionalContext under the event name and silent to two empty streams', () => {
    assert.deepEqual(JSON.parse(render({ kind: 'context', text: 'x', gate: 'g' }, 'post').stdout), { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'x' } });
    assert.deepEqual(render({ kind: 'silent' }, 'post'), { rc: 0, stdout: '', stderr: '' });
  });
  // REGRESSION 24.09: additionalContext on SubagentStop gave the subagent one more turn (68 of 68 in a week), and its
  // reply replaced the report the parent received.
  it('hands no note to the subagent on agent-stop: context goes to the human, an unknown too, block stays deliberate', () => {
    const c = render({ kind: 'context', text: 'x', gate: 'g' }, 'agent-stop');
    assert.equal(c.rc, 0); assert.deepEqual(JSON.parse(c.stdout), { systemMessage: 'x' });
    const u = render(merge([{ kind: 'unknown', reason: 'нет данных', gate: 'g' }], 'agent-stop'), 'agent-stop');
    assert.match((JSON.parse(u.stdout) as { systemMessage: string }).systemMessage, /unknown\(g\): нет данных/, 'unknown on agent-stop is never silent (I1)');
    assert.deepEqual(JSON.parse(render({ kind: 'block', reason: 'r', gate: 'g' }, 'agent-stop').stdout), { decision: 'block', reason: 'g: r' });
    assert.deepEqual(JSON.parse(render({ kind: 'context', text: 'x', gate: 'g' }, 'agent-start').stdout), { hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: 'x' } });
  });
});

describe('merge', () => {
  const deny: Verdict = { kind: 'deny', reason: 'a', gate: 'A' };
  const ask: Verdict = { kind: 'ask', reason: 'b', gate: 'B' };
  const ctx: Verdict = { kind: 'context', text: 'c', gate: 'C' };
  it('returns the strictest verdict: deny beats ask beats context beats silent', () => {
    assert.equal(merge([ctx, ask, { kind: 'silent' }, deny], 'pre-bash').kind, 'deny');
    assert.equal(merge([ctx, { kind: 'silent' }, ask], 'pre-bash').kind, 'ask');
    assert.equal(merge([{ kind: 'silent' }, ctx], 'post').kind, 'context');
    assert.equal(merge([], 'post').kind, 'silent');
  });
  it('keeps every message when two gates deny in one event — a second failure is never hidden by the first', () => {
    const m = merge([deny, { kind: 'deny', reason: 'z', gate: 'Z' }], 'pre-bash');
    assert.equal(m.kind, 'deny');
    assert.match((m as { reason: string }).reason, /a[\s\S]*z/);
  });
  it('lifts unknown to ask on pre-events and to a yellow context line on post/stop — never to silent', () => {
    const u: Verdict = { kind: 'unknown', reason: 'нет TS', gate: 'ts' };
    assert.equal(merge([u], 'pre-bash').kind, 'ask');
    assert.equal(merge([u], 'pre-write').kind, 'ask');
    assert.equal(merge([u], 'post').kind, 'context');
    assert.equal(merge([u], 'stop').kind, 'context');
    assert.match((merge([u], 'post') as { text: string }).text, /unknown\(ts\): нет TS/);
  });

  // REGRESSION 22.09: in bypassPermissions a hook ask ran the command without a prompt (probe on a bare `git push`),
  // so every «not proven» of a gate was a silent pass in the modes the owner actually works in.
  it('turns unknown into deny on pre-events in unattended modes and keeps ask where a human sees the prompt (both sides)', () => {
    const u: Verdict = { kind: 'unknown', reason: 'цель push не определена', gate: 'pre-push-guard' };
    for (const mode of ['auto', 'bypassPermissions', 'dontAsk'] as const) {
      const v = merge([u], 'pre-bash', {}, mode);
      assert.equal(v.kind, 'deny', mode); assert.match((v as { reason: string }).reason, /CLAUDE_HARNESS_UNKNOWN=ask/);
    }
    for (const mode of ['default', 'acceptEdits', 'plan'] as const) assert.equal(merge([u], 'pre-bash', {}, mode).kind, 'ask', mode);
    assert.equal(merge([u], 'post', {}, 'bypassPermissions').kind, 'context', 'post-events never block on unknown');
    assert.equal(merge([u], 'pre-bash', { CLAUDE_HARNESS_UNKNOWN: 'ask' }, 'bypassPermissions').kind, 'ask', 'the human override');
    assert.equal(merge([u], 'pre-bash', { CLAUDE_HARNESS_UNKNOWN: 'note' }, 'bypassPermissions').kind, 'context', 'replays observe, never block');
  });
  it('honours CLAUDE_HARNESS_UNKNOWN=note by lifting unknown to context even on pre-events', () => {
    const u: Verdict = { kind: 'unknown', reason: 'нет TS', gate: 'ts' };
    assert.equal(merge([u], 'pre-bash', { CLAUDE_HARNESS_UNKNOWN: 'note' }).kind, 'context');
  });
  it('honours CLAUDE_HARNESS_UNKNOWN=deny by lifting unknown to deny on pre-events only — a hard stop for sessions without a human', () => {
    const u: Verdict = { kind: 'unknown', reason: 'нет TS', gate: 'ts' };
    assert.equal(merge([u], 'pre-bash', { CLAUDE_HARNESS_UNKNOWN: 'deny' }).kind, 'deny');
    assert.equal(merge([u], 'post', { CLAUDE_HARNESS_UNKNOWN: 'deny' }).kind, 'context');
  });
});
