// REGRESSION harness-telemetry-4: the journal summed every line of a Claude transcript, and no tool could recount an
// older period — /ai-usage rebuilt the formula by hand, and the rollback trigger of the fix could not be checked.
// INVARIANT: the recount of a transcript equals the harness-telemetry-5 total the gate writes for the same bytes (sum
// over responses, per-field maximum); every usage line is either attributed to a message.id or counted as without
// one; every recounted session is compared, changed after its event or without one; an empty or partial run never
// exits 0, and the output names sessions only by their sha256 label.
import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sandbox, payload, HARNESS_ROOT, NODE_BIN, type Sandbox } from '../_env.ts';
import { decide, sourceId } from '../../src/telemetry.ts';
import { State } from '../../src/state.ts';

const SCRIPT = join(HARNESS_ROOT, 'scripts', 'telemetry-recount.ts');
const HOUR = 3600_000;

interface Tokens { input: number; write: number; read: number; output: number }
const A: Tokens = { input: 2, write: 3456, read: 20000, output: 362 };
const B: Tokens = { input: 3, write: 100, read: 5000, output: 50 };
const ZERO: Tokens = { input: 0, write: 0, read: 0, output: 0 };
const usage = (t: Tokens) => ({ input_tokens: t.input, cache_creation_input_tokens: t.write, cache_read_input_tokens: t.read, output_tokens: t.output });
/** A line in the shape Claude Code logs: one per content block, message.id and usage repeated, output partial until the last block. */
const line = (id: string | null, block: number, t: Tokens, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'assistant', uuid: `${id ?? 'x'}-${block}`, requestId: id ? `req_${id}` : undefined, ...extra, message: { ...(id ? { id } : {}), content: [{ type: 'text', text: 'SECRET_TRANSCRIPT_TEXT' }], usage: usage(t) } }) + '\n';
const response = (id: string, t: Tokens, blocks = 3): string[] => Array.from({ length: blocks }, (_, i) => line(id, i, i < blocks - 1 ? { ...t, output: 16 } : t));

interface Run { rc: number | null; out: Record<string, unknown>[]; stdout: string; stderr: string }
function recount(sb: Sandbox, ...args: string[]): Run {
  const r = spawnSync(NODE_BIN, ['--disable-warning=ExperimentalWarning', SCRIPT, ...args], {
    encoding: 'utf8', timeout: 60000, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir },
  });
  const out: Record<string, unknown>[] = [];
  for (const l of (r.stdout ?? '').split('\n').filter(Boolean)) { try { out.push(JSON.parse(l) as Record<string, unknown>); } catch { /* not a record */ } }
  return { rc: r.status, out, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
const since = (): string => new Date(Date.now() - HOUR).toISOString();
const ofExecutor = (r: Run, executor: string): Record<string, unknown> | undefined => r.out.find((o) => o.executor === executor && !('journal' in o));
const journalOf = (r: Run, executor: string): Record<string, unknown> | undefined => (r.out.find((o) => o.executor === executor && 'journal' in o)?.journal as Record<string, unknown> | undefined);
const status = (r: Run): Record<string, unknown> | undefined => r.out.find((o) => 'status' in o);

interface Fx { local: string; second: string; root: string; corp: string }
function layout(t: TestContext): { sb: Sandbox; fx: Fx } {
  const sb = sandbox('harness-recount-'); t.after(() => sb.cleanup());
  const fx: Fx = {
    local: join(sb.home, '.claude', 'projects', 'proj', 'sess', 'subagents', 'agent-a.jsonl'),
    second: join(sb.home, '.claude', 'projects', 'proj', 'sess', 'subagents', 'agent-b.jsonl'),
    root: join(sb.home, '.claude', 'projects', 'proj', 'sess.jsonl'),
    corp: join(sb.home, '.claude-corp', 'projects', 'proj', 'corp-session.jsonl'),
  };
  for (const p of Object.values(fx)) mkdirSync(dirname(p), { recursive: true });
  return { sb, fx };
}
const put = (p: string, lines: string[]): void => { for (const l of lines) appendFileSync(p, l); };
const age = (p: string, msAgo: number): void => { const s = (Date.now() - msAgo) / 1000; utimesSync(p, s, s); };
function gate(sb: Sandbox): void {
  const v = decide({ event: 'stop', payload: payload('Stop') as never, env: { HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir }, root: HARNESS_ROOT, stateDir: sb.stateDir, now: Date.now });
  assert.equal(v.kind, 'silent');
}
function journal(sb: Sandbox, file: 'personal.jsonl' | 'corp.jsonl', event: Record<string, unknown>): void {
  mkdirSync(sb.stateDir, { recursive: true });
  appendFileSync(join(sb.stateDir, file), JSON.stringify(event) + '\n');
}

describe('scripts/telemetry-recount', () => {
  it('counts a response logged as three lines once and a replayed one once — the sum over responses, each at its per-field maximum', (t) => {
    const { sb, fx } = layout(t);
    put(fx.local, [...response('msg_A', A), ...response('msg_B', B, 1), line('msg_A', 2, A), line('msg_A', 2, ZERO)]);
    const r = recount(sb, '--since', since());
    assert.equal(r.rc, 0, r.stderr + r.stdout);
    const local = ofExecutor(r, 'local-agent');
    assert.deepEqual(
      local && [local.transcripts, local.responses, local.usage_lines, local.uncached_input, local.cache_read, local.output],
      [1, 2, 6, A.input + A.write + B.input + B.write, A.read + B.read, A.output + B.output],
      'Miss this and the recount repeats the per-line doubling it exists to undo',
    );
    assert.equal(local?.responses_last_line_differs, 1, 'the zeroed replay is the last line of msg_A — the last-line method would erase it, and that must be visible');
  });
  it('shows every usage line without message.id as a number — grouped by requestId, by uuid, or unidentified — and the parts add up to the whole', (t) => {
    const { sb, fx } = layout(t);
    const strip = (l: string, drop: 'id' | 'id+request'): string => {
      const j = JSON.parse(l) as { message: Record<string, unknown> } & Record<string, unknown>;
      delete j.message.id; if (drop === 'id+request') delete j.requestId;
      return JSON.stringify(j) + '\n';
    };
    put(fx.local, [
      ...response('msg_C', A),
      ...response('msg_D', A).map((l) => strip(l, 'id')),
      strip(line('msg_E', 0, B), 'id+request'),
      JSON.stringify({ message: { usage: usage(B) } }) + '\n',
    ]);
    const local = ofExecutor(recount(sb, '--since', since()), 'local-agent');
    assert.deepEqual(local && [local.usage_lines, local.lines_with_message_id, local.lines_without_message_id, local.without_message_id_by], [8, 3, 5, { requestId: 3, uuid: 1, none: 1 }]);
    assert.equal(local?.responses, 4, 'msg_C, the requestId group, the uuid line and the bare line');
  });
  it('recounts subagent transcripts as local-agent and every corp transcript as corp-claude, and skips a root session of the local contour', (t) => {
    const { sb, fx } = layout(t);
    put(fx.local, response('msg_F', A)); put(fx.root, response('msg_G', B)); put(fx.corp, response('msg_H', B));
    const r = recount(sb, '--since', since());
    assert.deepEqual([ofExecutor(r, 'local-agent')?.transcripts, ofExecutor(r, 'corp-claude')?.transcripts, ofExecutor(r, 'corp-claude')?.output], [1, 1, B.output]);
  });
  it('takes a transcript into the window by its last write: before --since or at --until and later it is out', (t) => {
    const { sb, fx } = layout(t);
    put(fx.local, response('msg_I', A)); put(fx.second, response('msg_J', B));
    age(fx.local, 3 * HOUR); age(fx.second, 30 * 60_000);
    const r = recount(sb, '--since', new Date(Date.now() - 2 * HOUR).toISOString(), '--until', new Date(Date.now() - 10 * 60_000).toISOString());
    assert.deepEqual([ofExecutor(r, 'local-agent')?.transcripts, ofExecutor(r, 'local-agent')?.output], [1, B.output]);
    const later = recount(sb, '--since', new Date(Date.now() - 2 * HOUR).toISOString(), '--until', new Date(Date.now() - 40 * 60_000).toISOString());
    assert.equal(ofExecutor(later, 'local-agent')?.transcripts, 0);
  });
  it('exits non-zero and says so when the window holds no transcript — an empty recount is not a clean one', (t) => {
    const { sb } = layout(t);
    const r = recount(sb, '--since', since());
    assert.equal(r.rc, 2);
    assert.equal(status(r)?.status, 'empty');
  });
  it('rejects a call without --since, with a date it cannot read or with an unknown flag — exit 64 and the usage on stderr', (t) => {
    const { sb } = layout(t);
    for (const args of [[], ['--since', 'yesterday'], ['--since', since(), '--bogus']]) {
      const r = recount(sb, ...args);
      assert.equal(r.rc, 64, `${args.join(' ')} → ${r.stderr}`);
      assert.match(r.stderr, /--since/);
    }
  });
  it('agrees with every harness-telemetry-5 event the gate wrote and names a -5 event that differs as a finding — exit 1', (t) => {
    const { sb, fx } = layout(t);
    for (const p of [fx.local, fx.second]) writeFileSync(p, '');
    gate(sb);
    put(fx.local, [...response('msg_K', A), line('msg_K', 2, ZERO), line('msg_Z', 0, B).trimEnd()]); put(fx.second, response('msg_L', B));
    for (const p of [fx.local, fx.second]) age(p, 60_000);
    gate(sb);
    const clean = recount(sb, '--since', since(), '--journal');
    assert.equal(clean.rc, 0, clean.stdout + clean.stderr);
    assert.deepEqual(journalOf(clean, 'local-agent')?.by_adapter, { 'harness-telemetry-5': { compared: 2, mismatches: 0 } }, 'Miss this and the recount disagrees with the gate on the very bytes the gate read');
    journal(sb, 'personal.jsonl', { ts: new Date().toISOString(), adapter: 'harness-telemetry-5', executor: 'local-agent', event: 'agent-transcript', session: sourceId(fx.second, 'session'), input_tokens: 99, cache_write: 0, cache_read: 0, output_tokens: 1 });
    const bad = recount(sb, '--since', since(), '--journal');
    assert.equal(bad.rc, 1, 'a -5 total that the transcript does not reproduce is the rollback trigger');
    assert.deepEqual(journalOf(bad, 'local-agent')?.mismatched_sessions, [sourceId(fx.second, 'session')]);
    assert.equal(status(bad)?.status, 'findings');
  });
  it('shows the line-sum inflation of harness-telemetry-4 and claude-telemetry/2 events and confirms they are the line sum', (t) => {
    const { sb, fx } = layout(t);
    const lines = response('msg_M', A);
    put(fx.local, lines); put(fx.second, response('msg_N', B, 2));
    for (const p of [fx.local, fx.second]) age(p, 60_000);
    const ts = new Date().toISOString();
    journal(sb, 'personal.jsonl', { ts, adapter: 'harness-telemetry-4', executor: 'local-agent', event: 'agent-transcript', session: sourceId(fx.local, 'session'), input_tokens: 3 * A.input, cache_write: 3 * A.write, cache_read: 3 * A.read, output_tokens: 16 + 16 + A.output });
    journal(sb, 'personal.jsonl', { ts, adapter: 'claude-telemetry/2', executor: 'local-agent', session: sourceId(fx.second, 'session'), input_tokens: 2 * B.input, cache_creation_input_tokens: 2 * B.write, cache_read_input_tokens: 2 * B.read, output_tokens: 16 + B.output, cumulative: true });
    const j = journalOf(recount(sb, '--since', since(), '--journal'), 'local-agent');
    assert.deepEqual(j?.by_adapter, {
      'harness-telemetry-4': { compared: 1, line_sum_matches: 1, inflation: { uncached_input: 3, output: +((16 + 16 + A.output) / A.output).toFixed(3) } },
      'claude-telemetry/2': { compared: 1, line_sum_matches: 1, inflation: { uncached_input: 2, output: +((16 + B.output) / B.output).toFixed(3) } },
    });
  });
  it('accounts for every session: compared, changed after its last event or without one, plus journal sessions it cannot place', (t) => {
    const { sb, fx } = layout(t);
    for (const p of [fx.local, fx.second]) writeFileSync(p, '');
    gate(sb);
    put(fx.local, response('msg_O', A)); age(fx.local, 60_000);
    gate(sb);
    put(fx.local, response('msg_P', B, 1));
    put(fx.second, response('msg_Q', B));
    const deleted = join(sb.home, '.claude', 'projects', 'proj', 'sess', 'subagents', 'agent-gone.jsonl');
    journal(sb, 'personal.jsonl', { ts: new Date().toISOString(), adapter: 'harness-telemetry-5', executor: 'local-agent', event: 'agent-transcript', session: sourceId(deleted, 'session'), input_tokens: 1, cache_write: 0, cache_read: 0, output_tokens: 1 });
    journal(sb, 'personal.jsonl', { ts: new Date().toISOString(), adapter: 'claude-telemetry/2', executor: 'local-agent', session: 'agent-legacy.jsonl', input_tokens: 1, output_tokens: 1 });
    const r = recount(sb, '--since', since(), '--journal');
    const j = journalOf(r, 'local-agent');
    assert.deepEqual(j && [j.sessions, j.compared, j.changed_after_event, j.without_event, j.journal_sessions_without_transcript, j.journal_sessions_unmatchable], [2, 0, 1, 1, 1, 1]);
    assert.equal(r.rc, 2, 'a journal check that compared nothing is not a pass');
    assert.equal(status(r)?.status, 'nothing-compared');
  });
  it('does not compare a transcript born a day or more before the seed — the seed may have started it at its end', (t) => {
    const { sb, fx } = layout(t);
    put(fx.local, response('msg_T', A));
    age(fx.local, 3 * 24 * HOUR);
    if (statSync(fx.local).birthtimeMs > Date.now() - 2 * 24 * HOUR) return t.skip('this file system does not move the birth time back with the modification time');
    const st = State.open(sb.stateDir);
    try { st.setMarker('telemetry.seeded', new Date(Date.now() - HOUR).toISOString()); } finally { st.close(); }
    journal(sb, 'personal.jsonl', { ts: new Date().toISOString(), adapter: 'harness-telemetry-5', executor: 'local-agent', event: 'agent-transcript', session: sourceId(fx.local, 'session'), input_tokens: 0, cache_write: 0, cache_read: 0, output_tokens: 1 });
    const r = recount(sb, '--since', new Date(Date.now() - 4 * 24 * HOUR).toISOString(), '--journal');
    const j = journalOf(r, 'local-agent');
    assert.deepEqual(j && [j.born_before_seed, j.compared, j.mismatched_sessions], [1, 0, []], 'Miss this and a seeded-at-its-end transcript fires the rollback trigger for history the gate never counted');
  });
  it('drills a session label down to the responses of its transcript and prints no path or transcript text anywhere', (t) => {
    const { sb, fx } = layout(t);
    put(fx.local, [...response('msg_R', A), ...response('msg_S', B, 1)]);
    const label = sourceId(fx.local, 'session');
    const r = recount(sb, '--since', since(), '--session', label);
    assert.equal(r.rc, 0, r.stderr);
    const rows = r.out.filter((o) => o.session === label && 'response' in o);
    assert.deepEqual(rows.map((o) => [o.response, o.lines, o.output]), [['message:msg_R', 3, A.output], ['message:msg_S', 1, B.output]]);
    for (const run of [r, recount(sb, '--since', since()), recount(sb, '--since', since(), '--journal')]) {
      assert.equal(run.stdout.includes(sb.dir) || run.stdout.includes('SECRET_TRANSCRIPT_TEXT') || run.stderr.includes(sb.dir), false, 'the output names sessions by label only');
    }
    const unknown = recount(sb, '--since', since(), '--session', 'session:0000000000');
    assert.equal(unknown.rc, 2);
  });
});
