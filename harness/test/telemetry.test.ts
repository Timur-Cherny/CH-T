// INVARIANT I3/I6: в personal.jsonl/corp.jsonl уходят только токены, длительности и sha256-метки;
// ни байта промпта, отчёта или имени файла — ни в журнале, ни в harness.db. Параллельные Stop-хуки
// не двоят события: офсет читается и сдвигается под одним замком. Контуры раздельны.
// REGRESSION: python-оригинал хранил накопитель в state.json без замка на чтение-запись; здесь
// накопительная семантика та же (потребитель берёт ПОСЛЕДНЕЕ событие на session), но офсеты и
// накопитель живут в одной транзакции с записью журнала.
// REGRESSION harness-telemetry-4: Claude Code logs one model response as several lines (one per content block) that
// share message.id and repeat its usage; the accumulator summed every line, so uncached input came out doubled.
// INVARIANT: a Claude transcript's accumulator is the sum over its responses, each taken once at its per-field
// maximum — however the lines are split between Stop reads and however often the same bytes are read again.
import { describe, it, after, before, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { decide, readTail, codexUsage, messageUsage, recountNeeded, sourceId, walk, NAME, KILL_SWITCH, type Usage } from '../src/telemetry.ts';
import { GATES } from '../src/gates/registry.ts';
import { WHITELIST } from '../src/journal.ts';
import { State } from '../src/state.ts';
import { route } from '../src/main.ts';
import { sandbox, payload, NODE_BIN, HARNESS_ROOT, onlyGate, type Sandbox } from './_env.ts';
import type { GateContext } from '../src/types.ts';

const CODEX_LINE = (input: number, cached: number, output: number) =>
  JSON.stringify({ payload: { info: { total_token_usage: { total_tokens: input + output, input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0 } } }, private: 'SECRET_CODEX_BODY' }) + '\n';
const MSG_LINE = (input: number, write: number, read: number, output: number, secret: string) =>
  JSON.stringify({ message: { usage: { input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: output }, content: secret } }) + '\n';

interface Tokens { input: number; write: number; read: number; output: number }
const RESPONSE: Tokens = { input: 2, write: 3456, read: 20000, output: 362 };
const SMALL: Tokens = { input: 3, write: 100, read: 5000, output: 50 };
const TINY: Tokens = { input: 1, write: 10, read: 1000, output: 20 };
// The shape Claude Code logs: one line per content block, message.id and usage repeated on each line,
// output_tokens partial until the block that carries stop_reason.
const RESPONSE_LINE = (id: string, block: number, t: Tokens, stop: string | null, secret = 'SECRET_RESPONSE_BODY') =>
  JSON.stringify({
    parentUuid: null, isSidechain: true, type: 'assistant', apiBlockIndex: block, requestId: `req_${id}`, uuid: `${id}-${block}`, timestamp: '2026-09-24T10:00:00.000Z',
    message: {
      model: 'claude-opus-5-5', id, type: 'message', role: 'assistant', stop_reason: stop,
      content: [{ type: 'tool_use', id: `toolu_${id}_${block}`, name: 'Bash', input: { command: secret } }],
      usage: { input_tokens: t.input, cache_creation_input_tokens: t.write, cache_read_input_tokens: t.read, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: t.write }, output_tokens: t.output, service_tier: 'standard' },
    },
  }) + '\n';
const response = (id: string, final: Tokens, blocks = 3, secret?: string): string[] =>
  Array.from({ length: blocks }, (_, i) => (i < blocks - 1 ? RESPONSE_LINE(id, i, { ...final, output: 16 }, null, secret) : RESPONSE_LINE(id, i, final, 'tool_use', secret)));
const tokensOf = (e: Record<string, unknown> | undefined): unknown[] => [e?.input_tokens, e?.cache_write, e?.cache_read, e?.output_tokens];

interface Fx { codex: string; local: string; corp: string; done: string }
function layout(sb: Sandbox): Fx {
  const fx = {
    codex: join(sb.home, '.codex', 'sessions', '2026', 'session-codex.jsonl'),
    local: join(sb.home, '.claude', 'projects', 'project', 'subagents', 'agent-local.jsonl'),
    corp: join(sb.home, '.claude-corp', 'projects', 'project', 'session-corp.jsonl'),
    done: join(sb.home, '.claude-corp', 'tasks', 'done'),
  };
  for (const p of [fx.codex, fx.local, fx.corp]) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, ''); }
  mkdirSync(fx.done, { recursive: true });
  return fx;
}
function ctx(sb: Sandbox, env: Record<string, string | undefined> = {}, now = Date.now): GateContext {
  return { event: 'stop', payload: payload('Stop') as never, env: { HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, ...env }, root: HARNESS_ROOT, stateDir: sb.stateDir, now };
}
function events(sb: Sandbox, contour: 'personal' | 'corp'): Record<string, unknown>[] {
  const p = join(sb.stateDir, `${contour}.jsonl`);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}
function ageFile(p: string, hoursAgo: number): void { const t = (Date.now() - hoursAgo * 3600_000) / 1000; utimesSync(p, t, t); }
function offsetOf(sb: Sandbox, p: string): number | null {
  const st = State.open(sb.stateDir);
  try { const r = st.db.prepare('SELECT offset FROM telemetry_offsets WHERE transcript_hash = ?').get(sourceId(p)) as { offset: number } | undefined; return r?.offset ?? null; }
  finally { st.close(); }
}

describe('telemetry gate registration', () => {
  it('registers on the stop event under the kill-switch name of the bash original', () => {
    const g = GATES.find((x) => x.name === NAME);
    assert.ok(g, 'gate not registered');
    assert.deepEqual(g.events, ['stop']);
    assert.equal(g.killSwitch, 'CLAUDE_SKIP_AI_USAGE');
    assert.equal(KILL_SWITCH, 'CLAUDE_SKIP_AI_USAGE');
  });
});

describe('metadata-only contract (port of telemetry-metadata.test.sh)', () => {
  const sb = sandbox(); let fx: Fx;
  before(() => {
    fx = layout(sb);
    assert.equal(decide(ctx(sb)).kind, 'silent'); // seed run
    appendFileSync(fx.codex, CODEX_LINE(6, 2, 2));
    appendFileSync(fx.local, MSG_LINE(3, 1, 2, 4, 'SECRET_LOCAL_BODY'));
    appendFileSync(fx.corp, MSG_LINE(5, 1, 2, 3, 'SECRET_CORP_BODY'));
    writeFileSync(join(fx.done, 'REPORT_SECRET_NAME.md'), 'SECRET_REPORT_BODY\n');
    assert.equal(decide(ctx(sb)).kind, 'silent');
  });
  after(() => sb.cleanup());

  it('writes two personal and two corp events after the first collecting run (seed run writes none)', () => {
    assert.equal(events(sb, 'personal').length, 2);
    assert.equal(events(sb, 'corp').length, 2);
  });
  it('keeps Codex and the local agent in the personal contour', () => {
    const ex = events(sb, 'personal').map((e) => e.executor).sort();
    assert.deepEqual(ex, ['codex', 'local-agent']);
  });
  it('keeps the corp stream free of Codex and holds corp-claude only', () => {
    const ex = events(sb, 'corp').map((e) => e.executor);
    assert.equal(ex.filter((x) => x === 'codex').length, 0);
    assert.deepEqual([...new Set(ex)], ['corp-claude']);
  });
  it('maps token fields into the whitelist names — local agent 3/1/2/4, codex 6/-/2/2', () => {
    const local = events(sb, 'personal').find((e) => e.executor === 'local-agent')!;
    assert.deepEqual([local.input_tokens, local.cache_write, local.cache_read, local.output_tokens], [3, 1, 2, 4]);
    const codex = events(sb, 'personal').find((e) => e.executor === 'codex')!;
    assert.deepEqual([codex.input_tokens, codex.cache_write, codex.cache_read, codex.output_tokens], [6, 0, 2, 2]);
    assert.equal(local.event, 'agent-transcript'); assert.equal(codex.event, 'session-transcript');
  });
  it('emits a task-report event as an opaque hash — no report name, no report body, no report_id key outside the whitelist', () => {
    const rep = events(sb, 'corp').find((e) => e.event === 'task-report')!;
    assert.ok(rep, 'task-report event missing');
    assert.equal('report' in rep, false); assert.equal('report_id' in rep, false);
    assert.match(String(rep.session), /^report:[0-9a-f]{16}$/);
    assert.equal(JSON.stringify(rep).includes('SECRET'), false);
  });
  it('leaks no private content into the telemetry directory — journals AND harness.db are grepped byte-wise', () => {
    const re = /SECRET_(CODEX|LOCAL|CORP|REPORT|NAME)/;
    for (const f of readdirSync(sb.stateDir, { recursive: true, encoding: 'utf8' })) {
      const p = join(sb.stateDir, f);
      if (!statSync(p).isFile()) continue;
      assert.equal(re.test(readFileSync(p, 'latin1')), false, `private content in ${f}`);
    }
  });
  it('uses only WHITELIST.telemetry keys in every event of both contours', () => {
    for (const e of [...events(sb, 'personal'), ...events(sb, 'corp')]) for (const k of Object.keys(e)) assert.ok(WHITELIST.telemetry.has(k as never), k);
  });
  it('holds the telemetry dir at 700 and both journals at 600', () => {
    assert.equal(statSync(sb.stateDir).mode & 0o777, 0o700);
    assert.equal(statSync(join(sb.stateDir, 'personal.jsonl')).mode & 0o777, 0o600);
    assert.equal(statSync(join(sb.stateDir, 'corp.jsonl')).mode & 0o777, 0o600);
  });
  it('re-emits a task-report only when its mtime changes', () => {
    decide(ctx(sb));
    assert.equal(events(sb, 'corp').filter((e) => e.event === 'task-report').length, 1);
    ageFile(join(fx.done, 'REPORT_SECRET_NAME.md'), -1);
    decide(ctx(sb));
    assert.equal(events(sb, 'corp').filter((e) => e.event === 'task-report').length, 2);
  });
});

describe('seed run', () => {
  const sb = sandbox();
  after(() => sb.cleanup());
  it('sets the offset to the file end for a file older than 24h and to zero for a live one — history is never imported', () => {
    const fx = layout(sb);
    appendFileSync(fx.corp, MSG_LINE(100, 0, 0, 100, 'OLD_HISTORY'));
    ageFile(fx.corp, 48);
    assert.equal(decide(ctx(sb)).kind, 'silent');
    assert.equal(events(sb, 'corp').length, 0); assert.equal(events(sb, 'personal').length, 0);
    assert.equal(offsetOf(sb, fx.corp), statSync(fx.corp).size);
    assert.equal(offsetOf(sb, fx.local), 0);
    appendFileSync(fx.corp, MSG_LINE(5, 0, 0, 3, 'NEW'));
    decide(ctx(sb));
    const ev = events(sb, 'corp');
    assert.equal(ev.length, 1);
    assert.equal(ev[0].input_tokens, 5, 'history was imported into the accumulator');
  });
  it('keeps history out after a reseed as well — the response map is cleared together with the offsets', (t) => {
    const { sb, fx } = seeded(t);
    append(fx.corp, response('msg_01L', RESPONSE));
    decide(ctx(sb));
    ageFile(fx.corp, 48);
    const st = State.open(sb.stateDir);
    try { st.db.prepare("DELETE FROM markers WHERE key = 'telemetry.seeded'").run(); } finally { st.close(); }
    decide(ctx(sb));
    assert.equal(offsetOf(sb, fx.corp), statSync(fx.corp).size);
    append(fx.corp, response('msg_01M', SMALL, 1));
    decide(ctx(sb));
    assert.deepEqual(tokensOf(events(sb, 'corp').at(-1)), [3, 100, 5000, 50], 'Miss this and a reseed imports the whole history the seed exists to keep out');
  });
});

describe('cumulative semantics and tail reading', () => {
  const sb = sandbox(); let fx: Fx;
  before(() => { fx = layout(sb); decide(ctx(sb)); });
  after(() => sb.cleanup());

  it('emits the running total per session — the consumer takes the LAST event, the sum of events overstates', () => {
    appendFileSync(fx.local, MSG_LINE(3, 1, 2, 4, 'A'));
    decide(ctx(sb));
    appendFileSync(fx.local, MSG_LINE(7, 0, 1, 6, 'B'));
    decide(ctx(sb));
    const mine = events(sb, 'personal').filter((e) => e.executor === 'local-agent');
    assert.equal(mine.length, 2);
    assert.equal(mine[0].session, mine[1].session);
    assert.deepEqual([mine[1].input_tokens, mine[1].output_tokens], [10, 10]);
    assert.ok((mine[0].input_tokens as number) + (mine[1].input_tokens as number) > 10, 'the sum must overstate — that is why LAST is the rule');
  });
  it('advances the offset to the file end so the next run reads only the tail', () => {
    assert.equal(offsetOf(sb, fx.local), statSync(fx.local).size);
    const before = statSync(fx.local).size;
    appendFileSync(fx.local, MSG_LINE(1, 0, 0, 1, 'C'));
    const tail = readTail(fx.local, before)!;
    assert.equal(tail.lines.length, 1);
    assert.equal(tail.offset, statSync(fx.local).size);
  });
  it('does not advance past a tail without a newline and picks it up once completed', () => {
    const p = join(sb.dir, 'partial.jsonl');
    writeFileSync(p, MSG_LINE(1, 0, 0, 1, 'x') + '{"message":{"usage":{"input_tokens":9');
    const full = MSG_LINE(1, 0, 0, 1, 'x').length;
    const t1 = readTail(p, 0)!;
    assert.deepEqual([t1.lines.length, t1.offset], [1, full]);
    const t2 = readTail(p, full)!;
    assert.deepEqual([t2.lines.length, t2.offset], [0, full]);
    appendFileSync(p, ',"output_tokens":1}}}\n');
    const t3 = readTail(p, full)!;
    assert.equal(t3.lines.length, 1);
    assert.deepEqual(messageUsage(t3.lines[0]), { id: null, usage: { input_tokens: 9, cache_write: 0, cache_read: 0, output_tokens: 1 } });
  });
  it('re-reads from zero when the file shrank below the stored offset — a replaced transcript is not a negative tail', () => {
    const p = join(sb.dir, 'shrunk.jsonl');
    writeFileSync(p, MSG_LINE(2, 0, 0, 2, 'y'));
    const t = readTail(p, 10_000)!;
    assert.equal(t.lines.length, 1);
    assert.equal(t.offset, statSync(p).size);
  });
  it('skips a corrupt line without stopping the parse and still moves the offset past it', () => {
    appendFileSync(fx.corp, '{"message":{"usage":{broken\n');
    appendFileSync(fx.corp, MSG_LINE(2, 0, 0, 2, 'ok'));
    decide(ctx(sb));
    assert.equal(offsetOf(sb, fx.corp), statSync(fx.corp).size);
    const ev = events(sb, 'corp');
    assert.equal(ev.length, 1); assert.equal(ev[0].input_tokens, 2);
  });
  it('returns null from both line parsers for lines without a usage object and for non-JSON', () => {
    assert.equal(codexUsage('{"payload":{"info":{}}}'), null);
    assert.equal(codexUsage('not json "total_token_usage"'), null);
    assert.equal(messageUsage('{"message":{"content":"\\"usage\\" as text only"}}'), null);
    assert.equal(messageUsage('{"other":1}'), null);
    assert.deepEqual(codexUsage(CODEX_LINE(6, 2, 2).trim()), { input_tokens: 6, cache_write: 0, cache_read: 2, output_tokens: 2 });
  });
  it('returns null for a missing file rather than throwing', () => {
    assert.equal(readTail(join(sb.dir, 'nope.jsonl'), 0), null);
  });
});

function seeded(t: TestContext): { sb: Sandbox; fx: Fx } {
  const sb = sandbox(); t.after(() => sb.cleanup());
  const fx = layout(sb); decide(ctx(sb));
  return { sb, fx };
}
const localEvents = (sb: Sandbox): Record<string, unknown>[] => events(sb, 'personal').filter((e) => e.executor === 'local-agent');
function append(p: string, lines: string[]): void { for (const l of lines) appendFileSync(p, l); }
function mapRows(sb: Sandbox, p: string): number {
  const st = State.open(sb.stateDir);
  try {
    const table = st.db.prepare("SELECT count(*) c FROM sqlite_master WHERE type = 'table' AND name = 'telemetry_messages'").get() as { c: number };
    assert.equal(table.c, 1, 'the response map telemetry_messages does not exist');
    return (st.db.prepare('SELECT count(*) c FROM telemetry_messages WHERE key = ?').get(sourceId(p)) as { c: number }).c;
  } finally { st.close(); }
}
/** The state row exactly as harness-telemetry-4 left it after reading `p` to its end: every usage line summed. */
function legacyRow(sb: Sandbox, p: string, lines: string[]): number[] {
  const sum = [0, 0, 0, 0];
  for (const l of lines) {
    const u = (JSON.parse(l) as { message: { usage: Record<string, number> } }).message.usage;
    sum[0] += u.input_tokens; sum[1] += u.cache_creation_input_tokens; sum[2] += u.cache_read_input_tokens; sum[3] += u.output_tokens;
  }
  const st = State.open(sb.stateDir);
  try {
    assert.equal(Number(st.db.prepare('UPDATE telemetry_files SET usage_seen = 1, input_tokens = ?, cache_write = ?, cache_read = ?, output_tokens = ? WHERE key = ?').run(...sum, sourceId(p)).changes), 1);
    assert.equal(Number(st.db.prepare('UPDATE telemetry_offsets SET offset = ? WHERE transcript_hash = ?').run(statSync(p).size, sourceId(p)).changes), 1);
  } finally { st.close(); }
  return sum;
}
function storedTotal(sb: Sandbox, p: string): unknown[] {
  const st = State.open(sb.stateDir);
  try { return tokensOf(st.db.prepare('SELECT input_tokens, cache_write, cache_read, output_tokens FROM telemetry_files WHERE key = ?').get(sourceId(p)) as Record<string, number>); }
  finally { st.close(); }
}

describe('decide', () => {
  it('counts a response logged as three lines once — input and cache come from the response, output from its final line', (t) => {
    const { sb, fx } = seeded(t);
    append(fx.local, response('msg_01A', RESPONSE));
    decide(ctx(sb));
    assert.deepEqual(tokensOf(localEvents(sb).at(-1)), [2, 3456, 20000, 362], 'Miss this and a response is billed once per content block — uncached input doubles');
  });
  it('keeps two responses with identical usage apart — lines merge on message.id, never on equal numbers', (t) => {
    const { sb, fx } = seeded(t);
    append(fx.local, [...response('msg_01B', RESPONSE, 1), ...response('msg_01C', RESPONSE, 1)]);
    decide(ctx(sb));
    assert.deepEqual(tokensOf(localEvents(sb).at(-1)), [4, 6912, 40000, 724], 'two paid responses must both be counted');
  });
  it('replaces a response split between two Stop reads instead of adding it — the later read carries the final output', (t) => {
    const { sb, fx } = seeded(t);
    const lines = response('msg_01D', RESPONSE);
    append(fx.local, lines.slice(0, 2));
    decide(ctx(sb));
    append(fx.local, lines.slice(2));
    decide(ctx(sb));
    const [partial, final] = localEvents(sb);
    assert.deepEqual(tokensOf(final), [2, 3456, 20000, 362], 'a split response must end at its final numbers, not at partial plus final');
    assert.deepEqual(tokensOf(partial), [2, 3456, 20000, 16], 'the first read sees the response once, with the output streamed so far');
    assert.equal(partial.session, final.session);
  });
  const replayed = [
    ...response('msg_01E', RESPONSE), ...response('msg_01F', SMALL, 1),
    response('msg_01E', RESPONSE).at(-1)!, RESPONSE_LINE('msg_01E', 2, { input: 0, write: 0, read: 0, output: 0 }, 'tool_use'),
    ...response('msg_01G', TINY, 2),
  ];
  const replayedTotal = [2 + 3 + 1, 3456 + 100 + 10, 20000 + 5000 + 1000, 362 + 50 + 20];
  it('counts a replayed response once, even far later and with zeroed usage — each field keeps its maximum, not the last line', (t) => {
    const { sb, fx } = seeded(t);
    append(fx.local, replayed);
    decide(ctx(sb));
    assert.deepEqual(tokensOf(localEvents(sb).at(-1)), replayedTotal, 'a replay must not bill the response again, and a zeroed copy must not erase it');
  });
  it('gives the same total wherever one Stop read ends and the next begins', (t) => {
    for (let k = 1; k < replayed.length; k++) {
      const { sb, fx } = seeded(t);
      append(fx.local, replayed.slice(0, k));
      decide(ctx(sb));
      append(fx.local, replayed.slice(k));
      decide(ctx(sb));
      assert.deepEqual(tokensOf(localEvents(sb).at(-1)), replayedTotal, `split after line ${k} of ${replayed.length}`);
    }
  });
  it('groups a response without message.id by its requestId, and a line without either by its uuid, which a replay keeps', (t) => {
    const { sb, fx } = seeded(t);
    const strip = (l: string, keys: string[]): string => {
      const j = JSON.parse(l) as { message: Record<string, unknown> } & Record<string, unknown>;
      for (const k of keys) { if (k === 'id') delete j.message.id; else delete j[k]; }
      return JSON.stringify(j) + '\n';
    };
    const byRequest = response('msg_01Q', RESPONSE).map((l) => strip(l, ['id']));
    const [byUuid] = response('msg_01R', SMALL, 1).map((l) => strip(l, ['id', 'requestId']));
    const movedReplay = JSON.stringify({ ...(JSON.parse(byUuid) as Record<string, unknown>), slug: 'replayed', cwd: '/elsewhere' }) + '\n';
    append(fx.local, [...byRequest, byUuid, movedReplay]);
    decide(ctx(sb));
    assert.deepEqual(tokensOf(localEvents(sb).at(-1)), [5, 3556, 25000, 412], 'Miss this and a transcript format without message.id brings the per-line doubling back');
  });
  it('counts a usage line with no identity at all — no message.id, requestId or uuid — as a response of its own; only a byte-identical copy merges with it', (t) => {
    const { sb, fx } = seeded(t);
    const one = MSG_LINE(3, 1, 2, 4, 'NO_ID_ONE');
    append(fx.local, [one, MSG_LINE(3, 1, 2, 4, 'NO_ID_TWO'), one]);
    decide(ctx(sb));
    assert.deepEqual(tokensOf(localEvents(sb).at(-1)), [6, 2, 4, 8], 'Miss this and a transcript format without ids loses its usage or bills a replay twice');
  });
  it('recounts a transcript from byte zero once it grows when its stored total is the harness-telemetry-4 line sum — and stays silent until then', (t) => {
    const { sb, fx } = seeded(t);
    const lines = response('msg_01H', RESPONSE);
    append(fx.local, lines);
    const lineSum = legacyRow(sb, fx.local, lines);
    decide(ctx(sb));
    decide(ctx(sb));
    assert.equal(localEvents(sb).length, 0, 'a legacy row of a file that did not grow is left alone — no event repeats its total');
    assert.equal(offsetOf(sb, fx.local), statSync(fx.local).size, 'Miss this and prune drops the quiet row, and the next Stop re-reads and re-announces the file');
    assert.deepEqual(storedTotal(sb, fx.local), lineSum, 'Miss this and the quiet row loses its prefix: the next growth counts only the new responses');
    append(fx.local, response('msg_01I', SMALL, 1));
    decide(ctx(sb));
    assert.deepEqual(tokensOf(localEvents(sb).at(-1)), [5, 3556, 25000, 412], 'Miss this and agents alive at the deploy report the line sum under the new adapter');
  });
  it('stores the recounted total even when the recount finds no usage line — a replaced file does not keep its line sum', (t) => {
    const { sb, fx } = seeded(t);
    const lines = response('msg_01N', RESPONSE);
    append(fx.local, lines);
    legacyRow(sb, fx.local, lines);
    writeFileSync(fx.local, '{"type":"user","message":{"role":"user","content":"no usage here"}}\n'.repeat(80));
    decide(ctx(sb));
    assert.equal(localEvents(sb).length, 0);
    assert.deepEqual(storedTotal(sb, fx.local), [0, 0, 0, 0], 'Miss this and every later growth of the file re-reads it from byte zero again');
  });
  it('reads the clock under the state lock — events of one transcript carry ts in the order they are written', (t) => {
    const { sb, fx } = seeded(t);
    append(fx.local, response('msg_01S', RESPONSE));
    const probes: string[] = [];
    const lockHeld = (): string => {
      const other = new DatabaseSync(join(sb.stateDir, 'harness.db'));
      try { other.exec('PRAGMA busy_timeout = 0'); other.exec('BEGIN IMMEDIATE'); other.exec('ROLLBACK'); return 'unlocked'; }
      catch { return 'locked'; } finally { other.close(); }
    };
    decide(ctx(sb, {}, () => { probes.push(lockHeld()); return Date.now(); }));
    assert.deepEqual([...new Set(probes)], ['locked'], 'Miss this and a Stop that waited for the lock writes an older ts after a newer event — the latest ts carries a stale total');
  });
  it('keeps collecting every transcript when a line carries an absurd usage value — a token count is a non-negative safe integer', (t) => {
    const { sb, fx } = seeded(t);
    const poison = (n: number): string => JSON.stringify({ requestId: `req_poison_${n}`, message: { id: `msg_poison_${n}`, usage: { input_tokens: 5e18, cache_creation_input_tokens: -7, cache_read_input_tokens: 1.5, output_tokens: 2 ** 52 } } }) + '\n';
    append(fx.corp, [poison(1), poison(2)]);
    append(fx.local, [...response('msg_01T', RESPONSE, 1), ...response('msg_01U', RESPONSE, 1)]);
    assert.doesNotThrow(() => decide(ctx(sb)), 'Miss this and one poisoned transcript freezes the offsets of every file until it leaves the horizon');
    assert.deepEqual(tokensOf(localEvents(sb).at(-1)), [4, 6912, 40000, 724]);
    assert.deepEqual(tokensOf(events(sb, 'corp').at(-1)), [0, 0, 0, 2 ** 53], 'unsafe, negative and fractional counts are zero, and a total beyond 2^53 still sums');
  });
  it('stores responses under sha256 labels — no message.id and no line text reach harness.db', (t) => {
    const { sb, fx } = seeded(t);
    append(fx.local, [...response('msg_SECRET_ID_1', RESPONSE, 3, 'SECRET_TOOL_INPUT'), MSG_LINE(3, 1, 2, 4, 'SECRET_NO_ID_LINE')]);
    decide(ctx(sb));
    assert.equal(mapRows(sb, fx.local), 2, 'one response by its message.id, one by its line');
    for (const f of readdirSync(sb.stateDir, { recursive: true, encoding: 'utf8' })) {
      const p = join(sb.stateDir, f);
      if (!statSync(p).isFile()) continue;
      assert.equal(/SECRET_(ID|TOOL_INPUT|NO_ID_LINE)/.test(readFileSync(p, 'latin1')), false, `private content in ${f}`);
    }
  });
});

const AS_ROOT = process.getuid?.() === 0;
const ROOT_SKIP = 'running as root: a mode-000 directory stays readable, so there is nothing unreadable to test';
/** Runs `body` with `dir` at `mode` and always gives the mode back — a failed assertion must not leave the sandbox undeletable. */
function withMode(dir: string, mode: number, body: () => void): void {
  chmodSync(dir, mode);
  try { body(); } finally { chmodSync(dir, 0o755); }
}

describe('walk', () => {
  const HOUR = 3600_000;
  const listed = (w: { files?: string[]; complete?: boolean }): { files: string[]; complete: boolean | undefined } => ({ files: [...(w.files ?? [])].sort(), complete: w.complete });
  for (const [label, locked, mode] of [
    ['a directory that exists but cannot be listed', 'p3', 0o000],
    ['a file whose directory can be listed but not searched', join('p3', 'subagents'), 0o400],
  ] as const) {
    it(`lists the readable rest and reports the listing incomplete for ${label}`, (t) => {
      if (AS_ROOT) return t.skip(ROOT_SKIP);
      const sb = sandbox(); t.after(() => sb.cleanup());
      const root = join(sb.dir, 'root');
      const a = join(root, 'p1', 'subagents', 'a.jsonl'); const c = join(root, 'p3', 'subagents', 'c.jsonl');
      for (const p of [a, c]) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, '{}\n'); }
      withMode(join(root, locked), mode, () => {
        assert.deepEqual(listed(walk(root, HOUR, Date.now())), { files: [a], complete: false }, 'Miss this and the unreadable part hides the whole root, or reads as gone and gets pruned');
      });
      assert.deepEqual(listed(walk(root, HOUR, Date.now())), { files: [a, c], complete: true });
    });
  }
  it('reports a missing root and a removed directory as complete — gone is not unreadable', (t) => {
    const sb = sandbox(); t.after(() => sb.cleanup());
    assert.deepEqual(listed(walk(join(sb.dir, 'no-such-root'), HOUR, Date.now())), { files: [], complete: true });
    const a = join(sb.dir, 'root', 'p1', 'a.jsonl');
    mkdirSync(dirname(a), { recursive: true }); writeFileSync(a, '{}\n');
    rmSync(join(sb.dir, 'root', 'p1'), { recursive: true });
    assert.deepEqual(listed(walk(join(sb.dir, 'root'), HOUR, Date.now())), { files: [], complete: true });
  });
  it('treats a transcript link that can never resolve as gone — one broken link must not stop pruning for good', (t) => {
    const sb = sandbox(); t.after(() => sb.cleanup());
    const root = join(sb.dir, 'root'); mkdirSync(root, { recursive: true });
    symlinkSync(join(root, 'self.jsonl'), join(root, 'self.jsonl'));
    symlinkSync(join(root, 'missing-target'), join(root, 'dangling.jsonl'));
    assert.deepEqual(listed(walk(root, HOUR, Date.now())), { files: [], complete: true }, 'Miss this and a self-referencing link keeps every pass incomplete, so state is never pruned again');
  });
  it('does not follow a symlinked directory — a link back to an ancestor would list one transcript under endless paths', (t) => {
    const sb = sandbox(); t.after(() => sb.cleanup());
    const root = join(sb.dir, 'root'); const a = join(root, 'p1', 'subagents', 'a.jsonl');
    mkdirSync(dirname(a), { recursive: true }); writeFileSync(a, '{}\n');
    symlinkSync(root, join(root, 'p1', 'loop'));
    symlinkSync(a, join(root, 'p1', 'linked.jsonl'));
    assert.deepEqual(listed(walk(root, HOUR, Date.now())), { files: [join(root, 'p1', 'linked.jsonl'), a], complete: true }, 'a symlinked file is still listed, a symlinked directory is not entered');
  });
});

describe('decide — one unreadable directory', () => {
  it('keeps collecting the readable transcripts and keeps every offset, so nothing is re-announced once the directory is readable again', (t) => {
    if (AS_ROOT) return t.skip(ROOT_SKIP);
    const { sb, fx } = seeded(t);
    const projects = join(sb.home, '.claude', 'projects');
    const two = join(projects, 'project-two', 'session', 'subagents', 'agent-two.jsonl');
    const three = join(projects, 'project-three', 'session', 'subagents', 'agent-three.jsonl');
    for (const p of [two, three]) mkdirSync(dirname(p), { recursive: true });
    append(fx.local, response('msg_02A', RESPONSE)); append(two, response('msg_02B', SMALL, 1)); append(three, response('msg_02C', TINY, 2));
    decide(ctx(sb));
    assert.equal(localEvents(sb).length, 3);
    withMode(join(projects, 'project-three'), 0o000, () => {
      append(fx.local, response('msg_02D', SMALL, 1));
      decide(ctx(sb));
      assert.deepEqual(localEvents(sb).slice(3).map((e) => e.session), [sourceId(fx.local, 'session')], 'Miss this and one unreadable directory hides every transcript of its root');
    });
    for (const p of [fx.local, two, three]) assert.equal(offsetOf(sb, p), statSync(p).size, 'Miss this and the unreadable pass wipes the state of the whole root');
    decide(ctx(sb));
    assert.equal(localEvents(sb).length, 4, 'Miss this and every transcript of the root is re-read from byte zero and re-announced under a new ts');
  });
  it('still drops the state of a transcript whose directory was removed — gone is not unreadable', (t) => {
    const { sb } = seeded(t);
    const three = join(sb.home, '.claude', 'projects', 'project-three', 'session', 'subagents', 'agent-three.jsonl');
    mkdirSync(dirname(three), { recursive: true }); append(three, response('msg_02E', TINY, 2));
    decide(ctx(sb));
    assert.equal(offsetOf(sb, three), statSync(three).size);
    rmSync(join(sb.home, '.claude', 'projects', 'project-three'), { recursive: true });
    decide(ctx(sb));
    assert.equal(offsetOf(sb, three), null, 'Miss this and the state of every deleted transcript stays in harness.db for good');
  });
  for (const [label, mode] of [['cannot be listed', 0o000], ['can be listed but its reports cannot be stat-ed', 0o400]] as const) {
    it(`does not re-announce corp reports after a pass in which their directory ${label}`, (t) => {
      if (AS_ROOT) return t.skip(ROOT_SKIP);
      const { sb, fx } = seeded(t);
      const reports = (): number => events(sb, 'corp').filter((e) => e.event === 'task-report').length;
      writeFileSync(join(fx.done, 'REPORT_A.md'), 'x\n');
      decide(ctx(sb));
      assert.equal(reports(), 1);
      withMode(fx.done, mode, () => { decide(ctx(sb)); });
      decide(ctx(sb));
      assert.equal(reports(), 1, 'Miss this and every corp report is announced again under a new ts');
    });
  }
  it('keeps every other transcript exact when lines of an unexpected shape arrive — the line parsers never throw, so one file cannot abort the pass', (t) => {
    const { sb, fx } = seeded(t);
    const hostile = [
      '"usage"', '["usage"]', '{"usage":1}', '{"message":"usage"}', '{"message":{"usage":[]}}', '{"message":{"usage":"x"}}',
      '{"message":{"id":{"a":1},"usage":{"input_tokens":"5","output_tokens":null}},"requestId":[1],"uuid":7}',
      '{"message":{"usage":{"input_tokens":1e400,"output_tokens":-1,"cache_read_input_tokens":{"x":1}}}}',
      `{"message":{"usage":{${'"a":{'.repeat(5000)}${'}'.repeat(5000)}}}}`,
      '{"payload":{"info":{"total_token_usage":"x"}}}', '{"payload":{"info":{"total_token_usage":{"input_tokens":-1,"output_tokens":1e300}}}}',
    ].map((l) => l + '\n');
    append(fx.corp, hostile); append(fx.codex, hostile);
    append(fx.local, [...hostile, ...response('msg_02F', RESPONSE)]);
    assert.doesNotThrow(() => decide(ctx(sb)), 'Miss this and one line of a new transcript format stops collection for every file');
    assert.deepEqual(tokensOf(localEvents(sb).at(-1)), [2, 3456, 20000, 362]);
    for (const e of [...events(sb, 'personal'), ...events(sb, 'corp')]) {
      for (const v of tokensOf(e)) if (v !== undefined) assert.ok(Number.isSafeInteger(v) && (v as number) >= 0, JSON.stringify(e));
    }
  });
});

describe('messageUsage', () => {
  const one: Usage = { input_tokens: 1, cache_write: 0, cache_read: 0, output_tokens: 1 };
  it('names the response by message.id first, then requestId, then the line uuid, and by nothing when all three are absent or empty', () => {
    assert.deepEqual(messageUsage(RESPONSE_LINE('msg_01J', 0, RESPONSE, 'tool_use').trim()), { id: 'message:msg_01J', usage: { input_tokens: 2, cache_write: 3456, cache_read: 20000, output_tokens: 362 } });
    assert.deepEqual(messageUsage('{"requestId":"req_1","uuid":"u-1","message":{"usage":{"input_tokens":1,"output_tokens":1}}}'), { id: 'request:req_1', usage: one });
    assert.deepEqual(messageUsage('{"requestId":"","uuid":"u-1","message":{"id":"","usage":{"input_tokens":1,"output_tokens":1}}}'), { id: 'uuid:u-1', usage: one });
    assert.deepEqual(messageUsage('{"message":{"id":"","usage":{"input_tokens":1,"output_tokens":1}}}'), { id: null, usage: one });
    assert.deepEqual(messageUsage(MSG_LINE(3, 1, 2, 4, 'x').trim()), { id: null, usage: { input_tokens: 3, cache_write: 1, cache_read: 2, output_tokens: 4 } });
  });
});

describe('recountNeeded', () => {
  const lineSum: Usage = { input_tokens: 6, cache_write: 10368, cache_read: 60000, output_tokens: 394 };
  const exact: Usage = { input_tokens: 2, cache_write: 3456, cache_read: 20000, output_tokens: 362 };
  const nothing: Usage = { input_tokens: 0, cache_write: 0, cache_read: 0, output_tokens: 0 };
  for (const [expected, label, mode, grew, stored, mapped] of [
    [true, 'a grown Claude transcript whose stored total the response map does not reproduce', 'message', true, lineSum, nothing],
    [false, 'the same transcript while it does not grow — a quiet file keeps its row as it is', 'message', false, lineSum, nothing],
    [false, 'a grown Claude transcript whose stored total is the map total', 'message', true, exact, exact],
    [false, 'a grown Claude transcript with nothing stored and nothing mapped yet', 'message', true, nothing, nothing],
    [false, 'a grown Codex rollout — its last cumulative value has no map behind it, and a rollout reaches hundreds of MB', 'last', true, exact, nothing],
  ] as const) {
    it(`${expected ? 'recounts' : 'does not recount'} ${label}`, () => {
      assert.equal(recountNeeded(mode, grew, stored, () => mapped), expected);
    });
  }
});

describe('parallel sessions', () => {
  const sb = sandbox();
  after(() => sb.cleanup());
  it('produces exactly one event per transcript when 8 Stop hooks run at once — offsets move under one lock', () => {
    const fx = layout(sb); decide(ctx(sb));
    appendFileSync(fx.local, MSG_LINE(3, 1, 2, 4, 'P'));
    for (const l of response('msg_01P', RESPONSE)) appendFileSync(fx.local, l);
    appendFileSync(fx.codex, CODEX_LINE(6, 2, 2));
    const script = join(sb.dir, 'stop.ts');
    writeFileSync(script, `import { decide } from '${HARNESS_ROOT}/src/telemetry.ts';\nconst v = decide({ event: 'stop', payload: { session_id: 's', cwd: '/tmp', hook_event_name: 'Stop' } as never, env: { HOME: process.argv[2], CLAUDE_STATE_DIR: process.argv[3] }, root: '${HARNESS_ROOT}', stateDir: process.argv[3], now: Date.now });\nconsole.log(v.kind);`);
    const r = spawnSync('sh', ['-c', `for i in $(seq 1 8); do "${NODE_BIN}" --disable-warning=ExperimentalWarning "${script}" "${sb.home}" "${sb.stateDir}" & done; wait`], { encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal((r.stdout.match(/silent/g) ?? []).length, 8, r.stdout + r.stderr);
    const ev = events(sb, 'personal');
    assert.equal(ev.filter((e) => e.executor === 'local-agent').length, 1, JSON.stringify(ev));
    assert.equal(ev.filter((e) => e.executor === 'codex').length, 1, JSON.stringify(ev));
    assert.deepEqual(tokensOf(ev.find((e) => e.executor === 'local-agent')), [5, 3457, 20002, 366], 'eight racing Stops still count the three-line response once');
  });
});

describe('horizon', () => {
  const sb = sandbox();
  after(() => sb.cleanup());
  it('drops state rows of a transcript that left the horizon and ignores it while it stays there', () => {
    const fx = layout(sb); decide(ctx(sb));
    appendFileSync(fx.corp, MSG_LINE(5, 0, 0, 3, 'h'));
    decide(ctx(sb));
    assert.equal(events(sb, 'corp').length, 1);
    ageFile(fx.corp, 72);
    decide(ctx(sb, { TELEMETRY_HORIZON_DAYS: '1' }));
    assert.equal(offsetOf(sb, fx.corp), null, 'state row for a file beyond the horizon must be pruned');
    assert.equal(events(sb, 'corp').length, 1);
  });
  it('drops the response map together with the state row of a transcript that left the horizon', (t) => {
    const { sb: own, fx } = seeded(t);
    append(fx.corp, response('msg_01K', RESPONSE));
    decide(ctx(own));
    assert.equal(mapRows(own, fx.corp), 1, 'the three lines of one response are one map row');
    ageFile(fx.corp, 72);
    decide(ctx(own, { TELEMETRY_HORIZON_DAYS: '1' }));
    assert.equal(offsetOf(own, fx.corp), null);
    assert.equal(mapRows(own, fx.corp), 0, 'Miss this and the map of every finished transcript stays in harness.db for good');
  });
});

describe('unknown and kill-switch', () => {
  it('answers unknown with a reason when HOME is absent — roots cannot be resolved, silence would hide it', () => {
    const sb = sandbox();
    const v = decide(ctx(sb, { HOME: undefined }));
    assert.equal(v.kind, 'unknown');
    assert.match((v as { reason: string }).reason, /HOME/);
    sb.cleanup();
  });
  it('stays silent when none of the roots exist — an absent Codex or corp checkout is a normal machine', () => {
    const sb = sandbox();
    assert.equal(decide(ctx(sb)).kind, 'silent');
    assert.equal(decide(ctx(sb)).kind, 'silent');
    assert.equal(events(sb, 'personal').length + events(sb, 'corp').length, 0);
    sb.cleanup();
  });
  it('does nothing at all under CLAUDE_SKIP_AI_USAGE=1 through route(): silent verdict, no journals, no seed marker, no telemetry rows', async () => {
    const sb = sandbox(); const fx = layout(sb);
    appendFileSync(fx.codex, CODEX_LINE(6, 2, 2));
    const v = await route('stop', payload('Stop') as never, { HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, HARNESS_ROOT, ...onlyGate('telemetry'), [KILL_SWITCH]: '1' });
    assert.equal(v.kind, 'silent');
    // Другие гейты события stop могут открыть harness.db — проверяется след ИМЕННО этого гейта.
    assert.equal(readdirSync(sb.stateDir).some((f) => f.endsWith('.jsonl')), false, 'journal written under kill-switch');
    if (existsSync(join(sb.stateDir, 'harness.db'))) {
      const st = State.open(sb.stateDir);
      try {
        assert.equal(st.marker('telemetry.seeded'), null, 'seed marker written under kill-switch');
        assert.equal((st.db.prepare('SELECT count(*) c FROM telemetry_offsets').get() as { c: number }).c, 0);
        assert.equal((st.db.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name='telemetry_files'").get() as { c: number }).c, 0, 'own table created under kill-switch');
      } finally { st.close(); }
    }
    sb.cleanup();
  });
});
