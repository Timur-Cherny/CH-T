// Recount of Claude transcript usage by model response — the rule the telemetry gate writes as harness-telemetry-5 —
// over a window of last writes, for periods whose journal events still carry the per-line sum (harness-telemetry-4,
// claude-telemetry/2). Sources, reading and the response key are the gate's own (sources, readTail, messageUsage,
// responseLabel from src/telemetry.ts); a response counts once, at its per-field maximum.
// --journal checks the last journal event of every session against the recount: a harness-telemetry-5 event that
// differs is a finding (the rollback trigger of the fix), an older event shows its inflation over the recount.
// --session <label> drills one session down to its responses. Output: JSON lines that name sessions only by their
// sha256 label — no path and no transcript text. Exit: 0 clean, 1 findings, 2 empty, partial or nothing compared,
// 64 usage. Not compared: a transcript changed after its last event, and one born a day or more before the seed —
// the seed may have started it at its end, and its event then leaves out what came before.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isMainModule } from '../src/is-main.ts';
import { State, resolveStateDir } from '../src/state.ts';
import { ADAPTER, SEED_ACTIVE_MS, messageUsage, readTail, responseLabel, roots, sourceId, sources, type Usage } from '../src/telemetry.ts';

export interface Outcome { rc: number; stdout: string; stderr: string }
export interface Options { env: NodeJS.ProcessEnv; now: () => number }

type Executor = 'local-agent' | 'corp-claude';
const EXECUTORS: readonly Executor[] = ['local-agent', 'corp-claude'];
const USAGE = 'использование: telemetry-recount.ts --since <ISO> [--until <ISO>] [--journal] [--session <session:метка>]\n';

interface Args { since: number; until: number; journal: boolean; session: string | null }
interface Transcript { executor: Executor; path: string; label: string; mtimeMs: number; birthMs: number }
interface Response { name: string; lines: number; max: Usage; last: Usage }
interface Recount { responses: Map<string, Response>; lineSum: Usage; usageLines: number; byKind: Record<'message' | 'request' | 'uuid' | 'none', number> }
interface JournalEvent { adapter: string; executor: Executor; ts: number; usage: Usage }

const zero = (): Usage => ({ input_tokens: 0, cache_write: 0, cache_read: 0, output_tokens: 0 });
const add = (a: Usage, b: Usage): void => { a.input_tokens += b.input_tokens; a.cache_write += b.cache_write; a.cache_read += b.cache_read; a.output_tokens += b.output_tokens; };
const larger = (a: Usage, b: Usage): Usage => ({ input_tokens: Math.max(a.input_tokens, b.input_tokens), cache_write: Math.max(a.cache_write, b.cache_write), cache_read: Math.max(a.cache_read, b.cache_read), output_tokens: Math.max(a.output_tokens, b.output_tokens) });
const same = (a: Usage, b: Usage): boolean => a.input_tokens === b.input_tokens && a.cache_write === b.cache_write && a.cache_read === b.cache_read && a.output_tokens === b.output_tokens;
const figures = (u: Usage) => ({ uncached_input: u.input_tokens + u.cache_write, cache_read: u.cache_read, output: u.output_tokens });
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const ratio = (a: number, b: number): number | null => (b > 0 ? +(a / b).toFixed(3) : null);

function parse(argv: string[], now: number): Args | string {
  const a: Args = { since: Number.NaN, until: now, journal: false, session: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--journal') { a.journal = true; continue; }
    if (flag !== '--since' && flag !== '--until' && flag !== '--session') return `неизвестный аргумент «${flag}»`;
    const value = argv[++i];
    if (value === undefined) return `${flag} требует значение`;
    if (flag === '--session') { a.session = value; continue; }
    const t = Date.parse(value);
    if (!Number.isFinite(t)) return `${flag}: не дата ISO — «${value}»`;
    if (flag === '--since') a.since = t; else a.until = t;
  }
  if (!Number.isFinite(a.since)) return '--since обязателен';
  if (a.since >= a.until) return '--since должен быть раньше --until';
  return a;
}

/** Claude transcripts of the gate's own sources whose last write falls in [since, until). */
function transcripts(env: NodeJS.ProcessEnv, a: Args, now: number): { list: Transcript[]; complete: boolean } | null {
  const r = roots(env);
  if (!r) return null;
  const found = sources(r, Math.max(0, now - a.since), now);
  const list: Transcript[] = [];
  for (const s of found.list) {
    if (s.mode !== 'message') continue;
    let st;
    try { st = statSync(s.path); } catch { continue; }
    if (st.mtimeMs < a.since || st.mtimeMs >= a.until) continue;
    list.push({ executor: s.executor as Executor, path: s.path, label: sourceId(s.path, 'session'), mtimeMs: st.mtimeMs, birthMs: st.birthtimeMs });
  }
  return { list, complete: found.complete };
}

function recount(lines: string[]): Recount {
  const r: Recount = { responses: new Map(), lineSum: zero(), usageLines: 0, byKind: { message: 0, request: 0, uuid: 0, none: 0 } };
  lines.forEach((line, i) => {
    const m = messageUsage(line);
    if (!m) return;
    r.usageLines++;
    add(r.lineSum, m.usage);
    r.byKind[(m.id?.slice(0, m.id.indexOf(':')) ?? 'none') as keyof Recount['byKind']]++;
    const key = responseLabel(line, m);
    const seen = r.responses.get(key);
    if (seen) { seen.lines++; seen.max = larger(seen.max, m.usage); seen.last = m.usage; }
    else r.responses.set(key, { name: m.id ?? `line:${i + 1}`, lines: 1, max: { ...m.usage }, last: m.usage });
  });
  return r;
}
function total(r: Recount): Usage { const t = zero(); for (const x of r.responses.values()) add(t, x.max); return t; }

/** Last event per session in file order, over both journals; a pre-label session (a bare file name) is kept apart. */
function lastEvents(stateDir: string): { labeled: Map<string, JournalEvent>; bare: Map<string, JournalEvent> } {
  const labeled = new Map<string, JournalEvent>(); const bare = new Map<string, JournalEvent>();
  for (const f of ['personal.jsonl', 'corp.jsonl']) {
    let text: string;
    try { text = readFileSync(join(stateDir, f), 'utf8'); } catch { continue; }
    for (const l of text.split('\n')) {
      let o: Record<string, unknown>;
      try { o = JSON.parse(l) as Record<string, unknown>; } catch { continue; }
      if (typeof o !== 'object' || o === null || typeof o.session !== 'string' || typeof o.adapter !== 'string' || !EXECUTORS.includes(o.executor as Executor)) continue;
      const ts = Date.parse(String(o.ts));
      if (!Number.isFinite(ts) || o.event === 'task-report') continue;
      const e: JournalEvent = { adapter: o.adapter, executor: o.executor as Executor, ts, usage: { input_tokens: count(o.input_tokens), cache_write: count(o.cache_write ?? o.cache_creation_input_tokens), cache_read: count(o.cache_read ?? o.cache_read_input_tokens), output_tokens: count(o.output_tokens) } };
      if (o.session.startsWith('session:')) labeled.set(o.session, e);
      else if (o.session.endsWith('.jsonl')) bare.set(o.session, e);
    }
  }
  return { labeled, bare };
}

function seededAt(stateDir: string): number | null {
  let db;
  try { db = State.readOnly(stateDir); } catch { return null; }
  if (!db) return null;
  try {
    const row = db.prepare("SELECT value FROM markers WHERE key = 'telemetry.seeded'").get() as { value: string } | undefined;
    const t = row ? Date.parse(row.value) : Number.NaN;
    return Number.isFinite(t) ? t : null;
  } catch { return null; } finally { db.close(); }
}

const done = (lines: unknown[], status: string, reason: string, rc: number): Outcome =>
  ({ rc, stdout: [...lines, { status, reason }].map((l) => JSON.stringify(l)).join('\n') + '\n', stderr: '' });

function drill(t: Transcript, lines: string[] | null, events: Map<string, JournalEvent>): Outcome {
  if (!lines) return done([], 'incomplete', 'транскрипт сессии не читается', 2);
  const r = recount(lines);
  const rows: unknown[] = [...r.responses.values()].map((x) => ({ session: t.label, response: x.name, lines: x.lines, ...figures(x.max), last_line_differs: !same(x.max, x.last) }));
  const e = events.get(t.label);
  if (e) rows.push({ session: t.label, journal_last: { adapter: e.adapter, ts: new Date(e.ts).toISOString(), ...figures(e.usage) }, recount: figures(total(r)), changed_after_event: t.mtimeMs >= e.ts });
  return done(rows, 'ok', `ответов: ${r.responses.size}`, 0);
}

export function run(argv: string[], opts: Options): Outcome {
  const now = opts.now();
  const a = parse(argv, now);
  if (typeof a === 'string') return { rc: 64, stdout: '', stderr: `telemetry-recount: ${a}\n${USAGE}` };
  const found = transcripts(opts.env, a, now);
  if (!found) return done([], 'incomplete', 'HOME не задан — корни транскриптов неизвестны', 2);
  let stateDir: string | null = null;
  try { stateDir = resolveStateDir(opts.env); } catch { stateDir = null; }
  const journal = stateDir ? lastEvents(stateDir) : { labeled: new Map<string, JournalEvent>(), bare: new Map<string, JournalEvent>() };
  if (a.session !== null) {
    const t = found.list.find((x) => x.label === a.session);
    if (!t) return done([], 'empty', `в окне нет транскрипта с меткой ${a.session}`, 2);
    return drill(t, readTail(t.path, 0)?.lines ?? null, journal.labeled);
  }
  const seedEdge = stateDir ? seededAt(stateDir) : null;
  const out: unknown[] = [];
  let unreadable = 0; let compared = 0; const mismatched: string[] = [];
  for (const executor of EXECUTORS) {
    const mine = found.list.filter((t) => t.executor === executor);
    const sum = { transcripts: mine.length, unreadable: 0, responses: 0, usage_lines: 0, lines_with_message_id: 0, lines_without_message_id: 0, without_message_id_by: { requestId: 0, uuid: 0, none: 0 }, uncached_input: 0, cache_read: 0, output: 0, responses_last_line_differs: 0 };
    const check = { sessions: mine.length, compared: 0, changed_after_event: 0, without_event: 0, born_before_seed: 0, unreadable: 0, journal_sessions_without_transcript: 0, journal_sessions_unmatchable: 0 };
    const byAdapter = new Map<string, { compared: number; mismatches: number; line_sum_matches: number; journal: Usage; recount: Usage }>();
    const labels = new Set(mine.map((t) => t.label));
    for (const t of mine) {
      const lines = readTail(t.path, 0)?.lines ?? null;
      if (!lines) { sum.unreadable++; check.unreadable++; continue; }
      const r = recount(lines);
      const exact = total(r);
      const f = figures(exact);
      sum.responses += r.responses.size; sum.usage_lines += r.usageLines;
      sum.lines_with_message_id += r.byKind.message; sum.lines_without_message_id += r.usageLines - r.byKind.message;
      sum.without_message_id_by.requestId += r.byKind.request; sum.without_message_id_by.uuid += r.byKind.uuid; sum.without_message_id_by.none += r.byKind.none;
      sum.uncached_input += f.uncached_input; sum.cache_read += f.cache_read; sum.output += f.output;
      for (const x of r.responses.values()) if (!same(x.max, x.last)) sum.responses_last_line_differs++;
      if (!a.journal) continue;
      const e = journal.labeled.get(t.label);
      if (!e) { check.without_event++; continue; }
      if (t.mtimeMs >= e.ts) { check.changed_after_event++; continue; }
      if (seedEdge !== null && t.birthMs > 0 && t.birthMs < seedEdge - SEED_ACTIVE_MS) { check.born_before_seed++; continue; }
      check.compared++; compared++;
      const b = byAdapter.get(e.adapter) ?? { compared: 0, mismatches: 0, line_sum_matches: 0, journal: zero(), recount: zero() };
      b.compared++;
      if (e.adapter === ADAPTER) { if (!same(e.usage, exact)) { b.mismatches++; mismatched.push(t.label); } }
      else { if (same(e.usage, r.lineSum)) b.line_sum_matches++; add(b.journal, e.usage); add(b.recount, exact); }
      byAdapter.set(e.adapter, b);
    }
    unreadable += sum.unreadable;
    out.push({ executor, ...sum });
    if (!a.journal) continue;
    const inWindow = (e: JournalEvent): boolean => e.executor === executor && e.ts >= a.since && e.ts < a.until;
    for (const [label, e] of journal.labeled) if (inWindow(e) && !labels.has(label)) check.journal_sessions_without_transcript++;
    for (const e of journal.bare.values()) if (inWindow(e)) check.journal_sessions_unmatchable++;
    const by: Record<string, unknown> = {};
    for (const [adapter, b] of byAdapter) {
      by[adapter] = adapter === ADAPTER ? { compared: b.compared, mismatches: b.mismatches }
        : { compared: b.compared, line_sum_matches: b.line_sum_matches, inflation: { uncached_input: ratio(figures(b.journal).uncached_input, figures(b.recount).uncached_input), output: ratio(b.journal.output_tokens, b.recount.output_tokens) } };
    }
    out.push({ executor, journal: { ...check, by_adapter: by, mismatched_sessions: mismatched.filter((l) => labels.has(l)) } });
  }
  if (found.list.length === 0) return done(out, 'empty', 'в окне нет ни одного транскрипта Claude — пустой пересчёт не чистый', 2);
  if (mismatched.length) return done(out, 'findings', `событие ${ADAPTER} не совпало с пересчётом: ${mismatched.length}`, 1);
  if (!found.complete || unreadable) return done(out, 'incomplete', `обход неполный или транскрипт не читается (${unreadable}) — итог частичный`, 2);
  if (a.journal && compared === 0) return done(out, 'nothing-compared', 'ни одна сессия не сверена с журналом', 2);
  return done(out, 'ok', a.journal ? `сверено сессий: ${compared}` : `транскриптов: ${found.list.length}`, 0);
}

if (isMainModule(import.meta.url)) {
  const out = run(process.argv.slice(2), { env: process.env, now: Date.now });
  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  process.exit(out.rc);
}
