// Состояние контура — одна база node:sqlite на машину, общая для всех сессий (I6).
// Порядок PRAGMA обязателен: busy_timeout ПЕРВЫМ (иначе на свежей базе 13/16 параллельных
// открытий получают «database is locked»), потом WAL, потом synchronous=NORMAL. Сам перевод
// журнала busy_timeout не покрывает — его ждёт ensureWal, см. комментарий там.
// Ключи таблиц — локальные пути: это состояние на машине владельца, не телеметрия (I3 — про события).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, renameSync, existsSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export const SCHEMA_VERSION = 4;

/** Бюджет ожидания смены журнала: не меньше этого, даже когда вызывающий дал крошечный busy_timeout. */
const WAL_MIN_BUDGET_MS = 1000;
const WAL_MAX_BACKOFF_MS = 32;
const WAL_JITTER_MS = 4;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions(session_id TEXT PRIMARY KEY, cwd TEXT, permission_mode TEXT, started_at INTEGER, last_event_at INTEGER, ended_at INTEGER, runtime TEXT);
CREATE TABLE IF NOT EXISTS session_roots(session_id TEXT, repo TEXT, first_seen INTEGER, PRIMARY KEY(session_id, repo));
CREATE TABLE IF NOT EXISTS repos(repo TEXT PRIMARY KEY, registered_at INTEGER, last_head TEXT, last_sweep_at INTEGER, sweep_slow INTEGER DEFAULT 0, slow_streak INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS session_heads(session_id TEXT, repo TEXT, last_head TEXT, at INTEGER, PRIMARY KEY(session_id, repo));
CREATE TABLE IF NOT EXISTS cwd_top(cwd TEXT PRIMARY KEY, repo TEXT, git_mtime INTEGER);
CREATE TABLE IF NOT EXISTS verified(repo TEXT, path TEXT, checker TEXT, digest TEXT, verdict TEXT CHECK(verdict IN ('pass','fail','unknown')), checker_gen TEXT, missing_reason TEXT, at INTEGER, timed_out_after_ms INTEGER, PRIMARY KEY(repo, path, checker));
CREATE TABLE IF NOT EXISTS check_memo(project TEXT, set_digest TEXT, result TEXT, at INTEGER, PRIMARY KEY(project, set_digest));
CREATE TABLE IF NOT EXISTS jobs(job_id TEXT PRIMARY KEY, repo TEXT, kind TEXT, status TEXT CHECK(status IN ('claimed','running','done','failed','stale')), pid INTEGER, owner_session TEXT, skips TEXT, started_at INTEGER, finished_at INTEGER, rc INTEGER, summary TEXT);
CREATE TABLE IF NOT EXISTS job_files(job_id TEXT, repo TEXT, path TEXT, digest TEXT, PRIMARY KEY(job_id, repo, path));
CREATE TABLE IF NOT EXISTS findings(id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT, path TEXT, digest TEXT, checker TEXT, level TEXT CHECK(level IN ('fail','unknown')), message TEXT, created_at INTEGER, UNIQUE(repo, path, digest, checker));
CREATE TABLE IF NOT EXISTS deliveries(finding_id INTEGER, session_id TEXT, at INTEGER, PRIMARY KEY(finding_id, session_id));
CREATE TABLE IF NOT EXISTS agent_deliveries(finding_id INTEGER, session_id TEXT, agent_id TEXT, at INTEGER, PRIMARY KEY(finding_id, session_id, agent_id));
CREATE TABLE IF NOT EXISTS stop_blocks(session_id TEXT, signature TEXT, blocked_at INTEGER, PRIMARY KEY(session_id, signature));
CREATE TABLE IF NOT EXISTS claims(session_id TEXT, event TEXT, tool_use_id TEXT, at INTEGER, PRIMARY KEY(session_id, event, tool_use_id));
CREATE TABLE IF NOT EXISTS agent_window(session_id TEXT, agent_id TEXT, agent_type TEXT, started_at INTEGER, stopped_at INTEGER, snapshot TEXT, PRIMARY KEY(session_id, agent_id));
CREATE TABLE IF NOT EXISTS agent_files(session_id TEXT, agent_id TEXT, run_started INTEGER, agent_type TEXT, repo TEXT, path TEXT, digest TEXT, checkers TEXT, at INTEGER, PRIMARY KEY(session_id, agent_id, run_started, repo, path));
CREATE INDEX IF NOT EXISTS agent_files_content ON agent_files(repo, path, digest);
CREATE TABLE IF NOT EXISTS agent_checks(session_id TEXT, agent_id TEXT, run_started INTEGER, repo TEXT, path TEXT, checker TEXT, verdict TEXT, at INTEGER, PRIMARY KEY(session_id, agent_id, run_started, repo, path, checker));
CREATE TABLE IF NOT EXISTS contour(generation TEXT PRIMARY KEY, result TEXT, verified_at INTEGER);
CREATE TABLE IF NOT EXISTS freshness(repo TEXT PRIMARY KEY, fetched_at INTEGER, head_before TEXT, head_after TEXT);
CREATE TABLE IF NOT EXISTS journal_index(journal TEXT, key TEXT, PRIMARY KEY(journal, key));
CREATE TABLE IF NOT EXISTS head_moves(repo TEXT, session_id TEXT, started_at INTEGER, ended_at INTEGER, named INTEGER, common TEXT, PRIMARY KEY(repo, session_id, ended_at));
CREATE TABLE IF NOT EXISTS pending_commits(repo TEXT, hash TEXT, due_at INTEGER, kind TEXT CHECK(kind IN ('made','adopt')), moved_at INTEGER, common TEXT, PRIMARY KEY(repo, hash));
CREATE TABLE IF NOT EXISTS telemetry_offsets(transcript_hash TEXT PRIMARY KEY, offset INTEGER);
CREATE TABLE IF NOT EXISTS markers(key TEXT PRIMARY KEY, value TEXT, at INTEGER);
`;

// Единственное место, где читается CLAUDE_STATE_DIR. Пустая строка — «переменной нет», как её
// уже читают bin/hook и install.sh (`:-`) и python-хуки (`or`). Результат обязан быть АБСОЛЮТНЫМ:
// относительный привязал бы состояние к cwd, а cwd у сессии, воркера и хука разные — база и кэш
// расслоились бы, и «уже подтверждено» считалось бы заново.
// Пути нет — бросаем: вызывающий обязан отдать unknown с причиной, не тишину (I1).
export function resolveStateDir(env: NodeJS.ProcessEnv): string {
  const given = env.CLAUDE_STATE_DIR?.trim();
  if (given) {
    if (!isAbsolute(given)) throw new Error(`CLAUDE_STATE_DIR должен быть абсолютным путём, получено «${given}»`);
    return given;
  }
  const home = env.HOME?.trim();
  if (!home || !isAbsolute(home)) throw new Error(`каталог состояния неизвестен: CLAUDE_STATE_DIR пуст, HOME «${env.HOME ?? ''}» не абсолютен`);
  return join(home, '.claude', 'exec-telemetry');
}

export class State {
  readonly db: DatabaseSync;
  readonly path: string;
  /** Каталог, в котором лежит эта база. Источник истины для всего, что пишется рядом с ней. */
  readonly dir: string;

  private constructor(db: DatabaseSync, path: string, dir: string) { this.db = db; this.path = path; this.dir = dir; }

  /** A corrupt store goes aside and everything becomes unverified (more checks, never fewer). The file moves together
   * with its -wal/-shm before the failed handle is closed: closing unlinks `<path>-wal` by name, and left behind the pair
   * would be replayed into the new store under the old name. Another process may have moved the corrupt file aside and
   * created a healthy store first: only the file this process failed on (same inode) moves, never the new one. */
  static open(stateDir: string, opts: { busyTimeoutMs?: number } = {}): State {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const path = join(stateDir, 'harness.db');
    const held: { db?: DatabaseSync } = {};
    const ino = inode(path);
    let db: DatabaseSync;
    try {
      db = openWithPragmas(path, opts.busyTimeoutMs ?? 3000, held);
      db.exec(SCHEMA);
      const ver = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      if (ver < SCHEMA_VERSION) { migrate(db); db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`); }
      else if (ver > SCHEMA_VERSION) { /* новая база под старым кодом: читаем, что знаем — миграции только вперёд-совместимые */ }
    } catch (err) {
      const corrupt = existsSync(path) && isCorruption(err) && inode(path) === ino;
      if (corrupt) {
        const aside = `${path}.corrupt-${Date.now()}-${process.pid}`;
        for (const sfx of ['', '-wal', '-shm']) if (existsSync(path + sfx)) renameSync(path + sfx, aside + sfx);
      }
      try { held.db?.close(); } catch { held.db = undefined; }
      if (!corrupt && isCorruption(err) && existsSync(path) && inode(path) !== ino) return State.open(stateDir, opts);
      if (!corrupt) throw err;
      db = openWithPragmas(path, opts.busyTimeoutMs ?? 3000);
      db.exec(SCHEMA);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
    return new State(db, path, stateDir);
  }

  /** A handle that can neither create, migrate nor rotate the store: for readers bound to write nothing. Null — no store yet. */
  static readOnly(stateDir: string, busyTimeoutMs = 3000): DatabaseSync | null {
    const path = join(stateDir, 'harness.db');
    if (!existsSync(path)) return null;
    const db = new DatabaseSync(path, { readOnly: true });
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    return db;
  }

  /** Read-modify-write только внутри BEGIN IMMEDIATE: писатели сериализуются замком, не удачей. */
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { try { this.db.exec('ROLLBACK'); } catch { /* уже откатилось */ } throw e; }
  }

  marker(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM markers WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }
  setMarker(key: string, value: string, at = Date.now()): void {
    this.db.prepare('INSERT INTO markers(key, value, at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, at = excluded.at').run(key, value, at);
  }

  /** Атомарный claim: true — этот процесс первый; false — событие уже взято другим хуком того же события. */
  claim(sessionId: string, event: string, toolUseId: string, at = Date.now()): boolean {
    const r = this.db.prepare('INSERT OR IGNORE INTO claims(session_id, event, tool_use_id, at) VALUES(?,?,?,?)').run(sessionId, event, toolUseId, at);
    return Number(r.changes) === 1;
  }

  close(): void { this.db.close(); }
}

/** `holder` gets the handle before the first statement, so a caller can close a handle whose pragmas threw. */
function openWithPragmas(path: string, busyTimeoutMs: number, holder?: { db?: DatabaseSync }): DatabaseSync {
  const db = new DatabaseSync(path);
  if (holder) holder.db = db;
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  ensureWal(db, busyTimeoutMs);
  db.exec('PRAGMA synchronous = NORMAL');
  return db;
}

/** Синхронная пауза: процесс хука однопоточный, ждать всё равно нечем. */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isBusy(err: unknown): boolean {
  return /database is locked|SQLITE_BUSY/i.test(err instanceof Error ? err.message : String(err));
}

/**
 * Смена журнала — единственный шаг открытия, который `busy_timeout` НЕ покрывает: при чужой
 * транзакции SQLite отказывает сразу, не вызывая busy-handler (28 мс при busy_timeout 3000 мс).
 * Значение персистентно: на переведённой базе PRAGMA не выполняется и ретрай не тратится.
 */
function ensureWal(db: DatabaseSync, busyTimeoutMs: number): void {
  const journalMode = (): string => (db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
  const deadline = Date.now() + Math.max(busyTimeoutMs, WAL_MIN_BUDGET_MS);
  for (let attempt = 0; ; attempt++) {
    if (journalMode().toLowerCase() === 'wal') return;
    try {
      db.exec('PRAGMA journal_mode = WAL');
      return;
    } catch (err) {
      if (!isBusy(err) || Date.now() >= deadline) throw err;
      sleepMs(Math.min(2 ** attempt, WAL_MAX_BACKOFF_MS) + Math.random() * WAL_JITTER_MS);
    }
  }
}

/** Columns added after v1. Idempotent: every process that opens an older base runs it, and only one ALTER can win. */
/** Columns a table gained after it first shipped. Each ALTER is idempotent: an opener that lost the race gets «duplicate column». */
const ADDED_COLUMNS: Array<[table: string, column: string, type: string]> = [
  ['verified', 'timed_out_after_ms', 'INTEGER'],
  ['head_moves', 'named', 'INTEGER'],
  ['head_moves', 'common', 'TEXT'],
  ['pending_commits', 'kind', 'TEXT'],
  ['pending_commits', 'moved_at', 'INTEGER'],
  ['pending_commits', 'common', 'TEXT'],
];

function migrate(db: DatabaseSync): void {
  for (const [table, column, type] of ADDED_COLUMNS) {
    if ((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === column)) continue;
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`); }
    catch (err) { if (!/duplicate column name/i.test(err instanceof Error ? err.message : String(err))) throw err; }
  }
}

function inode(path: string): number | null { try { return statSync(path).ino; } catch { return null; } }

function isCorruption(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /malformed|not a database|corrupt/i.test(m);
}
