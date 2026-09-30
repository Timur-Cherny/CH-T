// Телеметрия исполнителей на событии Stop — порт hooks/telemetry.py + hooks/capture-ai-usage.sh.
// Только метаданные (I3): токены, длительность файла, факт появления отчёта. В событие и в состояние
// уходит sha256-метка пути, не путь; тело отчёта не открывается; имя отчёта — только хешем.
// Три свойства оригинала сохранены:
//   * цена не зависит от длины сессии — побайтовый офсет в telemetry_offsets, читается только хвост;
//   * параллельные сессии не двоят событий — чтение офсетов, разбор хвоста, сдвиг офсетов и запись
//     журнала идут внутри одной BEGIN IMMEDIATE-транзакции: второй Stop уже видит сдвинутый офсет;
//   * контуры раздельны — <stateDir>/personal.jsonl (codex, local-agent) и <stateDir>/corp.jsonl (corp-claude).
// Накопительная семантика: токены в событии — накопитель по сессии; потребитель берёт ПОСЛЕДНЕЕ
// событие на `session`, сумма событий завышает расход в разы.
// A Claude transcript logs one model response as several lines (one per content block) that share message.id and
// repeat its usage, and a history replay can copy a response again far later in the file. The accumulator is the
// sum over responses, each taken once at its per-field maximum (telemetry_messages, under sha256 labels); a stored
// total the map does not reproduce is recounted from byte zero once the file grows.
// Первый запуск — посев: офсеты ставятся на конец файлов старше 24 ч, история не сгребается, иначе
// один Stop выплюнул бы событие по каждой сессии за всё время.
// Регэкспов по содержимому нет: строка транскрипта разбирается JSON.parse; подстрочный префильтр
// только отсекает строки без ключа usage до разбора. Корни обхода — из env с дефолтами:
// CODEX_HOME (~/.codex), CLAUDE_CORP_HOME (~/.claude-corp), CLAUDE_CONFIG_DIR (~/.claude).
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync, type Dirent } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { register } from './gates/registry.ts';
import { State } from './state.ts';
import { appendJsonl } from './journal.ts';
import type { GateContext, Verdict } from './types.ts';

export const NAME = 'telemetry';
export const KILL_SWITCH = 'CLAUDE_SKIP_AI_USAGE';
export const ADAPTER = 'harness-telemetry-5'; // no «/»: the journal whitelist takes a slash for a path
export const SEED_ACTIVE_MS = 24 * 3600_000;
const DEFAULT_HORIZON_DAYS = 7;
const LOCK_WAIT_MS = 5000; // как в python: 5 с на замок, дальше — не собираем

// Own tables on top of State.db: per-file accumulator with its seen-in-this-pass mark, and the per-response map of
// Claude transcripts; offsets live in telemetry_offsets.
const LOCAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS telemetry_files(key TEXT PRIMARY KEY, kind TEXT CHECK(kind IN ('transcript','report')), seen_at INTEGER, usage_seen INTEGER DEFAULT 0, input_tokens INTEGER DEFAULT 0, cache_write INTEGER DEFAULT 0, cache_read INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, mtime REAL);
CREATE TABLE IF NOT EXISTS telemetry_messages(key TEXT NOT NULL, msg TEXT NOT NULL, input_tokens INTEGER NOT NULL, cache_write INTEGER NOT NULL, cache_read INTEGER NOT NULL, output_tokens INTEGER NOT NULL, PRIMARY KEY(key, msg)) WITHOUT ROWID;
`;

export interface Usage { input_tokens: number; cache_write: number; cache_read: number; output_tokens: number }
export interface MessageUsage { id: string | null; usage: Usage }
export interface Roots { codex: string; corp: string; claude: string }
export interface Tail { lines: string[]; offset: number }
export interface Listing { files: string[]; complete: boolean }

type Executor = 'codex' | 'corp-claude' | 'local-agent';
type Contour = 'personal' | 'corp';
export interface Source { path: string; executor: Executor; event: 'session-transcript' | 'agent-transcript'; contour: Contour; mode: 'last' | 'message' }
interface FileRow { usage_seen: number; input_tokens: number; cache_write: number; cache_read: number; output_tokens: number; mtime: number | null }

const ZERO: Usage = { input_tokens: 0, cache_write: 0, cache_read: 0, output_tokens: 0 };
const sameUsage = (a: Usage, b: Usage): boolean =>
  a.input_tokens === b.input_tokens && a.cache_write === b.cache_write && a.cache_read === b.cache_read && a.output_tokens === b.output_tokens;

export function roots(env: NodeJS.ProcessEnv): Roots | null {
  if (!env.HOME) return null;
  return {
    codex: env.CODEX_HOME ?? join(env.HOME, '.codex'),
    corp: env.CLAUDE_CORP_HOME ?? join(env.HOME, '.claude-corp'),
    claude: env.CLAUDE_CONFIG_DIR ?? join(env.HOME, '.claude'),
  };
}

/** Opaque sha256 label: neither the state nor the journal keeps a path, a name, a response id or line text. */
export function sourceId(path: string, prefix = 'source'): string {
  return `${prefix}:${createHash('sha256').update(path, 'utf8').digest('hex').slice(0, 20)}`;
}

/** Хвост файла с офсета. Файл усох — его подменили, читаем с нуля. Хвост без «\n» — незавершённая запись, офсет не двигаем. */
export function readTail(path: string, offset: number): Tail | null {
  let fd: number;
  try { fd = openSync(path, 'r'); } catch { return null; }
  try {
    const size = fstatSync(fd).size;
    const off = offset > size ? 0 : offset;
    if (size === off) return { lines: [], offset: off };
    const buf = Buffer.alloc(size - off);
    let got = 0;
    while (got < buf.length) { const n = readSync(fd, buf, got, buf.length - got, off + got); if (n === 0) break; got += n; }
    const chunk = buf.subarray(0, got);
    const cut = chunk.lastIndexOf(0x0a);
    if (cut < 0) return { lines: [], offset: off };
    return { lines: chunk.subarray(0, cut).toString('utf8').split('\n'), offset: off + cut + 1 };
  } catch { return null; } finally { closeSync(fd); }
}

/** A token count is a non-negative safe integer; anything else counts as zero rather than poisoning the sums of every transcript. */
const num = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0);
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (typeof v === 'object' && v !== null ? (v as Obj) : null);

/** Codex: payload.info.total_token_usage — значение уже накопительное по сессии. */
export function codexUsage(line: string): Usage | null {
  if (!line.includes('"total_token_usage"')) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { return null; }
  const u = obj(obj(obj(obj(parsed)?.payload)?.info)?.total_token_usage);
  if (!u) return null;
  return { input_tokens: num(u.input_tokens), cache_write: 0, cache_read: num(u.cached_input_tokens), output_tokens: num(u.output_tokens) };
}

const tagged = (v: unknown, tag: string): string | null => (typeof v === 'string' && v !== '' ? `${tag}:${v}` : null);

/** Claude transcript line: message.usage and the model response it belongs to — message.id, else requestId (one per
 *  response), else the line's uuid (a history replay keeps it); null when the line carries none of them. */
export function messageUsage(line: string): MessageUsage | null {
  if (!line.includes('"usage"')) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { return null; }
  const top = obj(parsed);
  const m = obj(top?.message);
  const u = obj(m?.usage);
  if (!top || !m || !u) return null;
  const id = tagged(m.id, 'message') ?? tagged(top.requestId, 'request') ?? tagged(top.uuid, 'uuid');
  return { id, usage: { input_tokens: num(u.input_tokens), cache_write: num(u.cache_creation_input_tokens), cache_read: num(u.cache_read_input_tokens), output_tokens: num(u.output_tokens) } };
}

/** Label of the response a usage line belongs to: its identity, else the line itself — a byte-identical copy is a replay. */
export function responseLabel(line: string, m: MessageUsage): string {
  return m.id === null ? sourceId(line, 'line') : sourceId(m.id, 'response');
}

/** A stored total the response map does not reproduce — a harness-telemetry-4 line sum or a foreign write — is recounted
 *  from byte zero, and only for a Claude transcript that grew: Codex keeps no map, and a quiet file keeps its row. */
export function recountNeeded(mode: 'last' | 'message', grew: boolean, stored: Usage, mapped: () => Usage): boolean {
  return mode === 'message' && grew && !sameUsage(stored, mapped());
}

/** Gone, not unreadable: the entry vanished, stopped being a directory, or is a link that can never resolve. */
const gone = (e: unknown): boolean => ['ENOENT', 'ENOTDIR', 'ELOOP'].includes((e as NodeJS.ErrnoException | null)?.code ?? '');

/** .jsonl files under the root within the horizon (state for thousands of dead transcripts is not worth keeping). A
 *  directory or file that exists but cannot be read makes the listing incomplete rather than empty: its transcripts are
 *  not gone. A symlinked directory is not entered — a link back to an ancestor would list one transcript under endless paths. */
export function walk(root: string, horizonMs: number, now: number): Listing {
  const files: string[] = [];
  let complete = true;
  const dirs = [root];
  for (let dir = dirs.pop(); dir !== undefined; dir = dirs.pop()) {
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch (e) { complete &&= gone(e); continue; }
    for (const d of entries) {
      const p = join(dir, d.name);
      if (d.isDirectory()) { dirs.push(p); continue; }
      if (!d.name.endsWith('.jsonl')) continue;
      try { const st = statSync(p); if (st.isFile() && st.mtimeMs >= now - horizonMs) files.push(p); } catch (e) { complete &&= gone(e); }
    }
  }
  return { files, complete };
}

export function sources(r: Roots, horizonMs: number, now: number): { list: Source[]; complete: boolean } {
  const codex = walk(join(r.codex, 'sessions'), horizonMs, now);
  const corp = walk(join(r.corp, 'projects'), horizonMs, now);
  const claude = walk(join(r.claude, 'projects'), horizonMs, now);
  const list: Source[] = [];
  for (const path of codex.files) list.push({ path, executor: 'codex', event: 'session-transcript', contour: 'personal', mode: 'last' });
  for (const path of corp.files) list.push({ path, executor: 'corp-claude', event: 'session-transcript', contour: 'corp', mode: 'message' });
  for (const path of claude.files) {
    if (!path.split(sep).includes('subagents')) continue;
    list.push({ path, executor: 'local-agent', event: 'agent-transcript', contour: 'personal', mode: 'message' });
  }
  return { list, complete: codex.complete && corp.complete && claude.complete };
}

function reports(r: Roots): Listing {
  const done = join(r.corp, 'tasks', 'done');
  try { return { files: readdirSync(done).filter((f) => f.startsWith('REPORT_') && f.endsWith('.md')).map((f) => join(done, f)), complete: true }; }
  catch (e) { return { files: [], complete: gone(e) }; }
}

function lifetimeS(path: string): number | null {
  try { const st = statSync(path); const born = st.birthtimeMs || st.mtimeMs; return Math.max(0, Math.round((st.mtimeMs - born) / 1000)); } catch { return null; }
}

function getOffset(st: State, key: string): number | null {
  const r = st.db.prepare('SELECT offset FROM telemetry_offsets WHERE transcript_hash = ?').get(key) as { offset: number } | undefined;
  return r?.offset ?? null;
}
function setOffset(st: State, key: string, offset: number): void {
  st.db.prepare('INSERT INTO telemetry_offsets(transcript_hash, offset) VALUES(?,?) ON CONFLICT(transcript_hash) DO UPDATE SET offset = excluded.offset').run(key, offset);
}
function getFile(st: State, key: string): FileRow | null {
  return (st.db.prepare('SELECT usage_seen, input_tokens, cache_write, cache_read, output_tokens, mtime FROM telemetry_files WHERE key = ?').get(key) as FileRow | undefined) ?? null;
}
function saveFile(st: State, key: string, kind: 'transcript' | 'report', now: number, usageSeen: number, acc: Usage, mtime: number | null): void {
  st.db.prepare(`INSERT INTO telemetry_files(key, kind, seen_at, usage_seen, input_tokens, cache_write, cache_read, output_tokens, mtime) VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET seen_at = excluded.seen_at, usage_seen = excluded.usage_seen, input_tokens = excluded.input_tokens, cache_write = excluded.cache_write, cache_read = excluded.cache_read, output_tokens = excluded.output_tokens, mtime = excluded.mtime`)
    .run(key, kind, now, usageSeen, acc.input_tokens, acc.cache_write, acc.cache_read, acc.output_tokens, mtime);
}

interface ResponseMap { put(key: string, msg: string, u: Usage): void; total(key: string): Usage; clear(key: string): void }

/** One row per (transcript, response): each field keeps its maximum over the response's lines, so reading the same bytes again changes nothing. */
function responseMap(st: State): ResponseMap {
  const put = st.db.prepare(`INSERT INTO telemetry_messages(key, msg, input_tokens, cache_write, cache_read, output_tokens) VALUES(?,?,?,?,?,?)
    ON CONFLICT(key, msg) DO UPDATE SET input_tokens = max(input_tokens, excluded.input_tokens), cache_write = max(cache_write, excluded.cache_write), cache_read = max(cache_read, excluded.cache_read), output_tokens = max(output_tokens, excluded.output_tokens)`);
  const total = st.db.prepare('SELECT total(input_tokens) input_tokens, total(cache_write) cache_write, total(cache_read) cache_read, total(output_tokens) output_tokens FROM telemetry_messages WHERE key = ?');
  const clear = st.db.prepare('DELETE FROM telemetry_messages WHERE key = ?');
  return {
    put: (key, msg, u) => { put.run(key, msg, u.input_tokens, u.cache_write, u.cache_read, u.output_tokens); },
    total: (key) => total.get(key) as unknown as Usage,
    clear: (key) => { clear.run(key); },
  };
}

/** Файл ушёл за горизонт — офсет и накопитель уходят вместе: вернувшийся файл читается целиком, и total сходится. */
function prune(st: State, now: number): void {
  st.db.prepare("DELETE FROM telemetry_offsets WHERE transcript_hash IN (SELECT key FROM telemetry_files WHERE kind = 'transcript' AND seen_at < ?)").run(now);
  st.db.prepare('DELETE FROM telemetry_files WHERE seen_at < ?').run(now);
  st.db.prepare('DELETE FROM telemetry_messages WHERE key NOT IN (SELECT key FROM telemetry_files)').run();
}

function seed(st: State, r: Roots, horizonMs: number, now: number): void {
  st.db.exec('DELETE FROM telemetry_messages');
  for (const s of sources(r, horizonMs, now).list) {
    let size: number, mtime: number;
    try { const f = statSync(s.path); size = f.size; mtime = f.mtimeMs; } catch { continue; }
    const key = sourceId(s.path);
    // Тронутый за сутки файл — живая сессия, считаем с начала, иначе её расход занижен навсегда.
    setOffset(st, key, mtime >= now - SEED_ACTIVE_MS ? 0 : size);
    saveFile(st, key, 'transcript', now, 0, ZERO, null);
  }
  for (const p of reports(r).files) {
    try { saveFile(st, sourceId(p, 'report-state'), 'report', now, 0, ZERO, statSync(p).mtimeMs); } catch { /* исчез */ }
  }
  st.setMarker('telemetry.seeded', new Date(now).toISOString(), now);
}

function collect(st: State, r: Roots, horizonMs: number, now: number, stateDir: string): void {
  const ts = new Date(now).toISOString();
  const out: Record<Contour, Record<string, unknown>[]> = { personal: [], corp: [] };
  const map = responseMap(st);
  const found = sources(r, horizonMs, now);
  const listed = reports(r);
  let complete = found.complete && listed.complete;
  for (const s of found.list) {
    const key = sourceId(s.path);
    const row = getFile(st, key);
    let acc: Usage = row ? { input_tokens: row.input_tokens, cache_write: row.cache_write, cache_read: row.cache_read, output_tokens: row.output_tokens } : { ...ZERO };
    let usageSeen = row?.usage_seen ?? 0;
    let tail = readTail(s.path, getOffset(st, key) ?? 0);
    let recounted = false;
    if (tail && recountNeeded(s.mode, tail.lines.length > 0, acc, () => map.total(key))) {
      tail = readTail(s.path, 0);
      if (tail) { map.clear(key); recounted = true; }
    }
    if (!tail) { saveFile(st, key, 'transcript', now, usageSeen, acc, null); continue; }
    let touched = false;
    for (const line of tail.lines) {
      if (s.mode === 'last') {
        const u = codexUsage(line);
        if (!u) continue;
        touched = true; usageSeen = 1; acc = u;
      } else {
        const m = messageUsage(line);
        if (!m) continue;
        touched = true; usageSeen = 1;
        map.put(key, responseLabel(line, m), m.usage);
      }
    }
    if (s.mode === 'message' && (touched || recounted)) acc = map.total(key);
    setOffset(st, key, tail.offset);
    saveFile(st, key, 'transcript', now, usageSeen, acc, null);
    // codex: любые новые строки при известном usage (как в оригинале — длительность обновляется); claude: только новое usage и ненулевой накопитель
    const emit = s.mode === 'last' ? usageSeen === 1 && tail.lines.length > 0 : touched && Object.values(acc).some((v) => v > 0);
    if (!emit) continue;
    out[s.contour].push({ ts, adapter: ADAPTER, executor: s.executor, event: s.event, session: sourceId(s.path, 'session'), duration_s: lifetimeS(s.path), ...acc });
  }
  // Отчёты корпа: только факт появления/обновления файла; тело не читается, имя — хешем.
  for (const p of listed.files) {
    let mtime: number;
    try { mtime = statSync(p).mtimeMs; } catch (e) { complete &&= gone(e); continue; }
    const key = sourceId(p, 'report-state');
    const row = getFile(st, key);
    saveFile(st, key, 'report', now, 0, ZERO, mtime);
    if (row && row.mtime === mtime) continue;
    out.corp.push({ ts, adapter: ADAPTER, executor: 'corp-claude', event: 'task-report', session: `report:${createHash('sha256').update(basename(p), 'utf8').digest('hex').slice(0, 16)}` });
  }
  // A state row keeps only a path hash and cannot be traced to its tree, so a pass that failed to read any tree prunes nothing.
  if (complete) prune(st, now);
  // Журнал пишется до COMMIT: отказ белого списка откатывает офсеты, и хвост будет перечитан следующим Stop.
  for (const e of out.personal) appendJsonl(join(stateDir, 'personal.jsonl'), 'telemetry', e);
  for (const e of out.corp) appendJsonl(join(stateDir, 'corp.jsonl'), 'telemetry', e);
}

/** Права как в оригинале: каталог 700, журналы 600 — чинятся и для файлов, оставшихся от python-версии. */
function protect(stateDir: string): void {
  try { chmodSync(stateDir, 0o700); } catch { /* не наш каталог — не наша забота */ }
  for (const f of ['personal.jsonl', 'corp.jsonl']) { const p = join(stateDir, f); if (existsSync(p)) { try { chmodSync(p, 0o600); } catch { /* уже занято */ } } }
}

function horizonMs(env: NodeJS.ProcessEnv): number {
  const d = Number(env.TELEMETRY_HORIZON_DAYS);
  return (Number.isFinite(d) && d > 0 ? d : DEFAULT_HORIZON_DAYS) * 86400_000;
}

export function decide(ctx: GateContext): Verdict {
  const r = roots(ctx.env);
  if (!r) return { kind: 'unknown', reason: 'HOME не задан — корни транскриптов неизвестны', gate: NAME };
  const st = State.open(ctx.stateDir, { busyTimeoutMs: LOCK_WAIT_MS });
  try {
    st.db.exec(LOCAL_SCHEMA);
    protect(ctx.stateDir);
    st.tx(() => {
      // The clock is read under the lock: a Stop that waited for it must not stamp its events before those it waited for.
      const now = ctx.now();
      if (st.marker('telemetry.seeded') === null) seed(st, r, horizonMs(ctx.env), now);
      else collect(st, r, horizonMs(ctx.env), now, ctx.stateDir);
    });
  } finally { st.close(); }
  return { kind: 'silent' };
}

register({ name: NAME, events: ['stop'], killSwitch: KILL_SWITCH, run: decide });
