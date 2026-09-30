// Сверка состояния рабочего дерева (класс К4): истина о правке — дерево, не имя инструмента.
// На каждом пишущем событии: git status по корням сессии → sha256 изменённых файлов → сравнение с
// verified → дешёвые проверки тут же (дедлайн), дорогие — задача воркеру, результат — следующим
// событием. Окно уязвимости — одно событие вместо сессии (v3: только Stop, hooks/tree-sweep.sh).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { spawn } from 'node:child_process'; // единственное исключение: detached-воркер (см. spawnWorker)
import { fileURLToPath } from 'node:url';
import type { GateContext, HookPayload, PostToolBatchPayload, ToolCall } from './types.ts';
import type { ChangedFile, CheckContext, Checker, CheckResult } from './checks/types.ts';
import { CHECKERS } from './checks/registry.ts';
import { State } from './state.ts';
import { generation } from './contour.ts';
import { diffNames, gitCommonDir, gitDirMtime, head, headLogMtime, status, toplevel } from './git.ts';
import { callIntent } from './commit-evidence.ts';
import { tokenize } from './parsers/shell.ts';
import { type Snapshot, changedSince } from './window.ts';
import { held, type JobHold } from './jobs/hold.ts';

export const MAX_FILES = 200;
export const MAX_HASH_BYTES = 4 * 1024 * 1024;
export const SYNC_DEADLINE_MS = 1500;
/** Hard ceiling of one Bash call: the post of the call that made a commit lands at most this long after it. */
export const MAX_CALL_MS = 600_000;
/** HEAD moves are compared in reflog seconds and filesystem milliseconds. */
export const MOVE_SLACK_MS = 1000;
/** The hook reads the clock after its own cold start (up to ~2 s measured): the window opens this much earlier. */
export const HOOK_LAG_MS = 5000;
const WRITING_TOOLS = new Set(['Bash', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit', 'Workflow']);

export interface Finding { repo: string; path: string; digest: string; checker: string; level: 'fail' | 'unknown'; message: string }
export interface SweepOutcome {
  roots: string[]; changed: number; checked: number; skippedVerified: number;
  findings: Finding[]; pending: number; deferred: number; truncated: boolean; unknownReasons: string[];
  files: ChangedFile[]; filesAt: number;
}
export interface SweepOptions { maxFiles?: number; syncDeadlineMs?: number; spawnWorker?: boolean; checkerFilter?: (name: string) => boolean }

export function digestOf(absPath: string): string {
  const st = statSync(absPath);
  if (st.size > MAX_HASH_BYTES) return `large:${st.size}`;
  return createHash('sha256').update(readFileSync(absPath)).digest('hex').slice(0, 16);
}

/** Корень репозитория для cwd с кэшем по mtime .git (−6–7 мс на событие). */
export function repoOf(state: State, dir: string): string | null {
  const row = state.db.prepare('SELECT repo, git_mtime FROM cwd_top WHERE cwd = ?').get(dir) as { repo: string; git_mtime: number } | undefined;
  if (row && existsSync(row.repo) && gitDirMtime(row.repo) === row.git_mtime) return row.repo;
  const top = toplevel(dir);
  if (top) state.db.prepare('INSERT INTO cwd_top(cwd, repo, git_mtime) VALUES(?,?,?) ON CONFLICT(cwd) DO UPDATE SET repo = excluded.repo, git_mtime = excluded.git_mtime').run(dir, top, gitDirMtime(top));
  return top;
}

function pathsFromToolCall(call: ToolCall, cwd: string): string[] {
  const out: string[] = [];
  const inp = call.tool_input ?? {};
  for (const k of ['file_path', 'notebook_path', 'path']) if (typeof inp[k] === 'string') out.push(resolve(cwd, inp[k] as string));
  if (call.tool_name === 'Bash' && typeof inp.command === 'string') {
    const parse = tokenize(inp.command);
    for (const seg of parse.segments) {
      for (let i = 0; i < seg.argv.length; i++) {
        const t = seg.argv[i];
        if (isAbsolute(t)) out.push(t);
        if ((t === 'cd' || t === '-C') && seg.argv[i + 1] && !seg.argv[i + 1].startsWith('-')) out.push(resolve(cwd, seg.argv[i + 1]));
      }
    }
  }
  return out;
}

// Каталог упомянут, а не является объектом работы. Список зависит от того, ОТКУДА взят путь.
// Живой случай 05.09: `~/.nvm/versions/node/v24.20.0/bin/node` в команде зарегистрировал репозиторий nvm корнем сессии.
// Путь из токенов Bash — упоминание: сверх MANAGED отсекаются системные каталоги и собственный конфиг (MENTIONED).
// cwd сессии и file_path пишущего инструмента — не упоминание, а место работы: исключается только MANAGED.
// Временный каталог не отсекается ни там, ни там: в контейнере и рабочее дерево, и вторая репозитория, названная
// в команде, законно лежат под /tmp, а от мусорного корня защищает правило «слабый корень — только с изменениями».
const MANAGED = ['/.nvm/', '/.pyenv/', '/.rbenv/', '/.cargo/', '/.rustup/', '/.cache/', '/node_modules/'];
const MENTIONED = [...MANAGED, '/Library/', '/usr/', '/.claude/'];
function inDirs(p: string, dirs: readonly string[]): boolean { const h = process.env.HOME ?? ''; const rel = h && p.startsWith(h) ? p.slice(h.length) : p; return dirs.some((d) => (rel + '/').includes(d)); }
const EVIDENCE = MENTIONED.filter((d) => d !== '/.claude/');
/** `evidence`: a path a Bash call names as the place a commit may be made — like a mention, except a worktree under
 * `<repo>/.claude/` is a place of work; only the own config under `$HOME/.claude/` stays out. */
export function isToolPath(p: string, strength: 'strong' | 'weak' | 'evidence' = 'weak'): boolean {
  if (strength !== 'evidence') return inDirs(p, strength === 'weak' ? MENTIONED : MANAGED);
  const h = process.env.HOME ?? '';
  return inDirs(p, EVIDENCE) || (!!h && (p + '/').startsWith(`${h}/.claude/`));
}

/** Roots whose HEAD moved while this call ran, with what the call was to that move (see commit-evidence.ts): proof —
 * a HEAD-moving git verb ran there and the window is exact; presence — anything else that could have moved it. A call
 * that went somewhere unseen (`cd "$VAR"` with no value here) stands present in every root the session already knew. */
function headMovesOf(state: State, sessionId: string, proof: Set<string>, presence: Set<string>, known: boolean, exact: boolean, started: number, now: number): Array<{ repo: string; named: boolean; common: string | null }> {
  const all = new Set([...proof, ...presence]);
  if (known) for (const row of state.db.prepare('SELECT repo FROM session_roots WHERE session_id = ?').all(sessionId) as { repo: string }[]) all.add(row.repo);
  const out: Array<{ repo: string; named: boolean; common: string | null }> = [];
  for (const repo of all) {
    const m = headLogMtime(repo);
    if (m !== null && m >= started - MOVE_SLACK_MS && m <= now + MOVE_SLACK_MS) out.push({ repo, named: exact && proof.has(repo), common: gitCommonDir(repo) });
  }
  return out;
}

/** Session roots: cwd ∪ tool paths ∪ absolute paths and cd/-C in Bash tokens ∪ roots already known (on stop only).
 * A root taken from Bash tokens (neither cwd nor file_path) is registered only if it has changes NOW:
 * naming another repo in an argument is not an edit in it. */
export function collectRoots(ctx: GateContext, state: State, opts: { all?: boolean } = {}): string[] {
  const p = ctx.payload as HookPayload & Partial<ToolCall> & Partial<PostToolBatchPayload>;
  const strong = new Set<string>([p.cwd]);
  const weak = new Set<string>();
  const calls: ToolCall[] = p.hook_event_name === 'PostToolBatch' ? (p.tool_calls ?? []) : (p.tool_name ? [{ tool_name: p.tool_name, tool_input: p.tool_input ?? {} }] : []);
  for (const c of calls) {
    if (!(WRITING_TOOLS.has(c.tool_name) || c.tool_name.startsWith('mcp__'))) continue;
    for (const x of pathsFromToolCall(c, p.cwd)) (c.tool_name === 'Bash' ? weak : strong).add(x);
  }
  const roots = new Set<string>();
  const resolveRoot = (c: string, strength: 'strong' | 'weak' | 'evidence'): string | null => {
    if (isToolPath(c, strength)) return null;
    let dir = c;
    try { if (!statSync(dir).isDirectory()) dir = dirname(dir); } catch { return null; }
    return repoOf(state, dir);
  };
  for (const c of strong) { const r = resolveRoot(c, 'strong'); if (r) roots.add(r); }
  for (const c of weak) {
    const r = resolveRoot(c, 'weak');
    if (!r || roots.has(r)) continue;
    const known = state.db.prepare('SELECT 1 FROM session_roots WHERE session_id = ? AND repo = ?').get(p.session_id, r);
    if (known || (status(r) ?? []).length > 0) roots.add(r);
  }
  const now = ctx.now();
  const duration = (p as { duration_ms?: unknown }).duration_ms;
  const exact = typeof duration === 'number' && duration >= 0 && duration <= MAX_CALL_MS;
  const started = now - HOOK_LAG_MS - (typeof duration === 'number' && duration >= 0 ? duration : MAX_CALL_MS);
  const proof = new Set<string>(); const presence = new Set<string>(); let known = false;
  for (const c of calls) {
    if (c.tool_name !== 'Bash' || typeof c.tool_input?.command !== 'string') continue;
    const intent = callIntent(c.tool_input.command, p.cwd, ctx.env);
    for (const d of intent.proof) proof.add(d);
    for (const d of intent.presence) presence.add(d);
    known ||= intent.opaque;
  }
  const rootsOf = (dirs: Set<string>): Set<string> => new Set([...dirs].map((d) => resolveRoot(d, 'evidence')).filter((r): r is string => !!r));
  const moved = proof.size || presence.size || known ? headMovesOf(state, p.session_id, rootsOf(proof), rootsOf(presence), known, exact, started, now) : [];
  state.tx(() => {
    for (const r of roots) state.db.prepare('INSERT OR IGNORE INTO session_roots(session_id, repo, first_seen) VALUES(?,?,?)').run(p.session_id, r, now);
    for (const r of roots) state.db.prepare('INSERT OR IGNORE INTO repos(repo, registered_at) VALUES(?,?)').run(r, now);
    for (const m of moved) state.db.prepare('INSERT OR IGNORE INTO head_moves(repo, session_id, started_at, ended_at, named, common) VALUES(?,?,?,?,?,?)').run(m.repo, p.session_id, started, now, m.named ? 1 : 0, m.common);
  });
  if (opts.all) for (const row of state.db.prepare('SELECT repo FROM session_roots WHERE session_id = ?').all(p.session_id) as { repo: string }[]) if (existsSync(row.repo)) roots.add(row.repo);
  return [...roots];
}

export function changedFiles(state: State, repo: string, maxFiles: number): { files: ChangedFile[]; truncated: boolean; unknownReason?: string } {
  const entries = status(repo);
  if (entries === null) return { files: [], truncated: false, unknownReason: `git status не выполнился в ${repo}` };
  const paths = new Map<string, ChangedFile['status']>();
  for (const e of entries) { if (e.xy.includes('D') && !e.xy.includes('M') && !e.xy.includes('A')) continue; paths.set(e.path, (e.xy.trim()[0] ?? 'M') as ChangedFile['status']); }
  // Сдвиг HEAD (правка + commit одним вызовом): файлы коммитов между last_head и HEAD тоже изменены.
  const h = head(repo);
  const row = state.db.prepare('SELECT last_head FROM repos WHERE repo = ?').get(repo) as { last_head: string | null } | undefined;
  if (h && row?.last_head && row.last_head !== h) for (const p of diffNames(repo, row.last_head, h)) if (!paths.has(p)) paths.set(p, 'M');
  if (h) state.db.prepare('UPDATE repos SET last_head = ? WHERE repo = ?').run(h, repo);
  const all = [...paths.entries()];
  const truncated = all.length > maxFiles;
  const files: ChangedFile[] = [];
  for (const [p, st] of all.slice(0, maxFiles)) {
    const abs = join(repo, p);
    try { if (!statSync(abs).isFile()) continue; files.push({ repo, path: p, absPath: abs, digest: digestOf(abs), status: st }); } catch { /* исчез между status и stat */ }
  }
  return { files, truncated };
}

function setDigest(files: ChangedFile[]): string {
  return createHash('sha256').update(files.map((f) => `${f.path}:${f.digest}`).sort().join('\n')).digest('hex').slice(0, 16);
}

const ONE_VERIFIED = 'SELECT digest, checker_gen, verdict, timed_out_after_ms FROM verified WHERE repo = ? AND path = ? AND checker = ?';

interface VerifiedRow { digest: string; checker_gen: string; verdict: string; timed_out_after_ms: number | null }

/** undefined — no verdict for this content yet; null — settled; 0 or n — ran out of time (see openBudget). */
function openOf(v: VerifiedRow | undefined, f: ChangedFile, gen: string): number | null | undefined {
  if (!v || v.digest !== f.digest || v.checker_gen !== gen) return undefined;
  return v.verdict === 'unknown' ? v.timed_out_after_ms : null;
}

/** `timed_out_after_ms`: NULL — settled; 0 — time ran out before the check started; n — it ran n ms and was cut off. */
function openBudget(r: CheckResult, budgetMs: number): number | null {
  if (r.verdict !== 'unknown' || !r.transient) return null;
  if (r.transient === 'unstarted') return 0;
  return Number.isFinite(budgetMs) ? Math.max(1, Math.ceil(budgetMs)) : Number.MAX_SAFE_INTEGER;
}

/** Single writer of verified/findings, one transaction per result. Returns the finding only when it is news:
 * a transient unknown neither replaces a settled verdict of the same content nor is reported twice in a row,
 * a pass removes the finding of that content, and a changed verdict is owed to every session again. */
export function recordResult(state: State, f: ChangedFile, checker: string, gen: string, r: CheckResult, now: number, budgetMs = 0): Finding | null {
  if (r.verdict === 'pass') { const held = digestSafe(f.absPath); if (held && held !== f.digest) return null; }
  const open = openBudget(r, budgetMs);
  return state.tx(() => {
    const was = openOf(state.db.prepare(ONE_VERIFIED).get(f.repo, f.path, checker) as VerifiedRow | undefined, f, gen);
    if (was === null && open !== null) return null;
    state.db.prepare(`INSERT INTO verified(repo, path, checker, digest, verdict, checker_gen, missing_reason, at, timed_out_after_ms) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(repo, path, checker) DO UPDATE SET digest = excluded.digest, verdict = excluded.verdict, checker_gen = excluded.checker_gen, missing_reason = excluded.missing_reason, at = excluded.at, timed_out_after_ms = excluded.timed_out_after_ms`)
      .run(f.repo, f.path, checker, f.digest, r.verdict, gen, r.missing_reason ?? null, now, open);
    const stale = state.db.prepare('SELECT id, level, message FROM findings WHERE repo = ? AND path = ? AND digest = ? AND checker = ?').get(f.repo, f.path, f.digest, checker) as { id: number; level: string; message: string } | undefined;
    if (r.verdict === 'pass') {
      for (const old of state.db.prepare('SELECT id FROM findings WHERE repo = ? AND path = ? AND checker = ?').all(f.repo, f.path, checker) as Array<{ id: number }>) oweAgain(state, old.id);
      if (stale) state.db.prepare('DELETE FROM findings WHERE id = ?').run(stale.id);
      return null;
    }
    const message = (r.verdict === 'fail' ? (r.message ?? 'провал без сообщения') : (r.missing_reason ?? 'причина не названа')).slice(0, 4096);
    state.db.prepare('INSERT INTO findings(repo, path, digest, checker, level, message, created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(repo, path, digest, checker) DO UPDATE SET level = excluded.level, message = excluded.message').run(f.repo, f.path, f.digest, checker, r.verdict, message, now);
    const again = typeof was === 'number' && open !== null;
    if (stale && !again && (stale.level !== r.verdict || stale.message !== message)) oweAgain(state, stale.id);
    return again ? null : { repo: f.repo, path: f.path, digest: f.digest, checker, level: r.verdict, message };
  });
}

export function spawnWorker(root: string, jobId: string, env: NodeJS.ProcessEnv, stateDir: string): void {
  const worker = join(root, 'src', 'jobs', 'worker.ts');
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', worker, jobId], {
    detached: true, stdio: 'ignore',
    env: { ...env, CLAUDE_STATE_DIR: stateDir, HARNESS_ROOT: root, NODE_COMPILE_CACHE: env.NODE_COMPILE_CACHE ?? join(stateDir, 'compile-cache') },
  });
  child.unref();
}

interface Pending { c: Checker; f: ChangedFile; open: number | undefined }

/** checker, path and digest of every file in a job someone holds: the job checks them, a second job must not. */
function inflightFiles(state: State, repo: string, now: number): Set<string> {
  const out = new Set<string>();
  const jobs = state.db.prepare("SELECT job_id, kind, status, pid, started_at FROM jobs WHERE repo = ? AND status IN ('claimed','running')").all(repo) as Array<JobHold & { job_id: string; kind: string }>;
  for (const j of jobs) {
    if (!held(j, now)) continue;
    for (const f of state.db.prepare('SELECT path, digest FROM job_files WHERE job_id = ?').all(j.job_id) as Array<{ path: string; digest: string }>) out.add(`${j.kind}\0${f.path}\0${f.digest}`);
  }
  return out;
}

/** The generation a verdict of `c` on a file of `repo` is settled under: the checker code (`gen`) and, for a checker
 * whose verdict reads more than the file, the generation of those inputs — as the run reported it, or as it is now. */
export function verdictGeneration(gen: string, c: Checker, repo: string, reported?: string): string {
  return c.inputGeneration ? `${gen}:${reported ?? c.inputGeneration(repo)}` : gen;
}

/** A verdict that ran out of time is not verified: its pair stays pending and runs again once the budget on offer is
 * at least twice the largest one this checker already failed to finish with in this repo — so doomed launches double
 * their way out instead of repeating. Pairs that never started run before pairs that already burned a budget. */
export async function sweep(ctx: GateContext, state: State, opts: SweepOptions = {}): Promise<SweepOutcome> {
  const maxFiles = opts.maxFiles ?? MAX_FILES;
  const deadline = ctx.now() + (opts.syncDeadlineMs ?? SYNC_DEADLINE_MS);
  const gen = generation(ctx.root);
  const roots = collectRoots(ctx, state, { all: ctx.event === 'stop' });
  const out: SweepOutcome = { roots, changed: 0, checked: 0, skippedVerified: 0, findings: [], pending: 0, deferred: 0, truncated: false, unknownReasons: [], files: [], filesAt: ctx.now() };
  const checkers = CHECKERS.filter((c) => ctx.env[c.killSwitch] !== '1' && (opts.checkerFilter?.(c.name) ?? true));
  for (const repo of roots) {
    const { files, truncated, unknownReason } = changedFiles(state, repo, maxFiles);
    if (unknownReason) out.unknownReasons.push(unknownReason);
    out.truncated ||= truncated;
    out.changed += files.length;
    out.files.push(...files);
    state.db.prepare('UPDATE repos SET last_sweep_at = ? WHERE repo = ?').run(ctx.now(), repo);
    const workerSets = new Map<string, ChangedFile[]>();
    const rows = new Map<string, VerifiedRow>();
    for (const v of state.db.prepare('SELECT path, checker, digest, checker_gen, verdict, timed_out_after_ms FROM verified WHERE repo = ?').all(repo) as Array<VerifiedRow & { path: string; checker: string }>) rows.set(`${v.checker}\0${v.path}`, v);
    const gens = new Map<string, string>();
    const genOf = (c: Checker): string => { let g = gens.get(c.name); if (g === undefined) { g = verdictGeneration(gen, c, repo); gens.set(c.name, g); } return g; };
    const bench = new Map<string, number>();
    const inflight = inflightFiles(state, repo, ctx.now());
    const unstarted: Pending[] = []; const cutOff: Pending[] = [];
    for (const c of checkers) {
      for (const f of files) {
        if (!c.applies(f)) continue;
        const open = openOf(rows.get(`${c.name}\0${f.path}`), f, genOf(c));
        if (open === null) { out.skippedVerified++; continue; }
        if (c.tier === 'worker' && open) { out.deferred++; continue; }
        if (c.tier === 'worker') { if (!inflight.has(`${c.name}\0${f.path}\0${f.digest}`)) (workerSets.get(c.name) ?? workerSets.set(c.name, []).get(c.name)!).push(f); continue; }
        if (open) bench.set(c.name, Math.max(bench.get(c.name) ?? 0, open));
        (open ? cutOff : unstarted).push({ c, f, open });
      }
    }
    for (const { c, f, open } of [...unstarted, ...cutOff]) {
      const left = deadline - ctx.now();
      const cctx: CheckContext = { env: ctx.env, stateDir: ctx.stateDir, now: ctx.now, deadlineMs: left };
      const budget = left <= 0 ? 0 : (c.budgetMs?.(cctx) ?? left);
      const held = left <= 0 ? 'дедлайн синхронного яруса исчерпан' : budget < 2 * (bench.get(c.name) ?? 0) ? `${c.name} отложен: на другом файле проверка не уложилась в бюджет синхронного яруса` : null;
      if (held) {
        out.deferred++;
        const fnd = open === undefined ? recordResult(state, f, c.name, genOf(c), { verdict: 'unknown', missing_reason: held, transient: 'unstarted' }, ctx.now()) : null;
        if (fnd) out.findings.push(fnd);
        continue;
      }
      if (openOf(state.db.prepare(ONE_VERIFIED).get(repo, f.path, c.name) as VerifiedRow | undefined, f, genOf(c)) === null) { out.skippedVerified++; continue; }
      let r: CheckResult;
      try { r = await c.run(f, cctx); }
      catch (e) { r = { verdict: 'unknown', missing_reason: `${c.name}: ${(e as Error).message.split('\n')[0]}` }; }
      out.checked++;
      if (r.verdict === 'unknown' && r.transient === 'timeout') bench.set(c.name, Math.max(bench.get(c.name) ?? 0, budget));
      const fnd = recordResult(state, f, c.name, verdictGeneration(gen, c, repo, r.generation), r, ctx.now(), budget);
      if (fnd) out.findings.push(fnd);
    }
    for (const [kind, set] of workerSets) {
      const jobId = createHash('sha256').update(`${repo}|${kind}|${setDigest(set)}|${gens.get(kind) ?? gen}`).digest('hex').slice(0, 24);
      const skips = Object.keys(ctx.env).filter((k) => k.startsWith('CLAUDE_SKIP_') && ctx.env[k] === '1');
      // A job with this id nobody holds left the pair open — it finished another generation or dropped a verdict, no
      // worker started, or its worker died: run it again.
      const claimed = state.tx(() => {
        let won = Number(state.db.prepare('INSERT OR IGNORE INTO jobs(job_id, repo, kind, status, owner_session, skips, started_at) VALUES(?,?,?,?,?,?,?)').run(jobId, repo, kind, 'claimed', ctx.payload.session_id, JSON.stringify(skips), ctx.now()).changes) === 1;
        const row = won ? undefined : state.db.prepare('SELECT status, pid, started_at FROM jobs WHERE job_id = ?').get(jobId) as JobHold | undefined;
        if (row && !held(row, ctx.now())) won = Number(state.db.prepare("UPDATE jobs SET status = 'claimed', pid = NULL, owner_session = ?, skips = ?, started_at = ?, finished_at = NULL, rc = NULL WHERE job_id = ?").run(ctx.payload.session_id, JSON.stringify(skips), ctx.now(), jobId).changes) === 1;
        if (won) { state.db.prepare('DELETE FROM job_files WHERE job_id = ?').run(jobId); for (const f of set) state.db.prepare('INSERT OR IGNORE INTO job_files(job_id, repo, path, digest) VALUES(?,?,?,?)').run(jobId, repo, f.path, f.digest); }
        return won;
      });
      if (claimed && (opts.spawnWorker ?? true)) spawnWorker(ctx.root, jobId, ctx.env, ctx.stateDir);
    }
    out.pending += (state.db.prepare("SELECT count(*) c FROM jobs WHERE repo = ? AND status IN ('claimed','running')").get(repo) as { c: number }).c;
  }
  return out;
}

const LEDGERS = ['deliveries', 'agent_deliveries'] as const;

/** A changed verdict is owed to every reader again, and so is every older break of a file that has since passed:
 * its return is a new regression. Both the root ledger and the ledger of every subagent. */
function oweAgain(state: State, findingId: number): void {
  for (const t of LEDGERS) state.db.prepare(`DELETE FROM ${t} WHERE finding_id = ?`).run(findingId);
}

/** Who reads a sweep result: the root session (agentId '') or one of its subagents, with the window it is told about —
 * null for the root, and for a subagent with no open window (it hears only what its own event checked). `since`: the
 * window start; in a root the snapshot never held, a finding recorded after it counts as the subagent's. */
export interface Reader { sessionId: string; agentId: string; window: Snapshot | null; since: number | null }
export function rootReader(sessionId: string): Reader { return { sessionId, agentId: '', window: null, since: null }; }

/** Findings on the CURRENT digests of the roots not yet delivered to this reader: the root ledger `deliveries`, one
 * ledger per subagent in `agent_deliveries` — telling a subagent never spends a finding owed to the root, and a subagent
 * hears only about files changed within its window. A file back to clean drops its deliveries for every reader of the
 * session, so the next break, even to the same content, is told again. A check run in this event is told even if seen
 * before and is marked by the digest it ran on. */
export interface Delivery { found: Finding[]; omitted: number; fromBacklog: number; owedLater: boolean }
export function deliver(state: State, reader: Reader, roots: string[], now: number, fresh: Finding[] = [], current: ChangedFile[] = [], opts: { filesAt?: number; budget?: number } = {}): Delivery {
  const { sessionId, agentId, window, since } = reader;
  const root = agentId === '';
  const known = (repo: string): boolean => window !== null && window[repo] !== undefined;
  const inWindow = (repo: string, path: string): boolean => known(repo) && changedSince(window!, repo, path, join(repo, path));
  const forgetUpTo = opts.filesAt ?? Infinity;
  let left = opts.budget ?? Infinity;
  const skipped = new Set<string>();
  const keyOf = (repo: string, path: string, digest: string, checker: string): string => `${repo}|${path}|${digest}|${checker}`;
  const fits = (x: Finding): boolean => { const cost = findingLine(x).length + 1; if (cost > left) { skipped.add(keyOf(x.repo, x.path, x.digest, x.checker)); return false; } left -= cost; return true; };
  const out: Finding[] = [];
  let fromBacklog = 0;
  const mark = (id: number): void => {
    if (root) state.db.prepare('INSERT OR IGNORE INTO deliveries(finding_id, session_id, at) VALUES(?,?,?)').run(id, sessionId, now);
    else state.db.prepare('INSERT OR IGNORE INTO agent_deliveries(finding_id, session_id, agent_id, at) VALUES(?,?,?,?)').run(id, sessionId, agentId, now);
  };
  state.tx(() => {
    for (const repo of roots) {
      // A delivery is forgotten once its file left the content the finding was made on, so a return to that same broken
      // content is reported again; forgetting by path alone let «break X → fix → break X» pass silently.
      const digestNow = new Map(current.filter((x) => x.repo === repo).map((x) => [x.path, x.digest]));
      for (const t of LEDGERS) {
        const rows = state.db.prepare(`SELECT DISTINCT d.finding_id, f.path, f.digest FROM ${t} d JOIN findings f ON f.id = d.finding_id WHERE d.session_id = ? AND f.repo = ? AND d.at <= ?`).all(sessionId, repo, forgetUpTo) as Array<{ finding_id: number; path: string; digest: string }>;
        for (const r of rows) if (digestNow.get(r.path) !== r.digest) state.db.prepare(`DELETE FROM ${t} WHERE finding_id = ? AND session_id = ? AND at <= ?`).run(r.finding_id, sessionId, forgetUpTo);
      }
    }
    for (const x of fresh) {
      if (!(root || window === null || !known(x.repo) || inWindow(x.repo, x.path)) || !fits(x)) continue;
      const row = state.db.prepare('SELECT id FROM findings WHERE repo = ? AND path = ? AND digest = ? AND checker = ?').get(x.repo, x.path, x.digest, x.checker) as { id: number } | undefined;
      if (row) mark(row.id);
      out.push(x);
    }
    if (!root && window === null) return;
    const unseen = root
      ? state.db.prepare('SELECT f.id, f.path, f.digest, f.checker, f.level, f.message, f.created_at FROM findings f WHERE f.repo = ? AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.finding_id = f.id AND d.session_id = ?) ORDER BY f.id')
      : state.db.prepare('SELECT f.id, f.path, f.digest, f.checker, f.level, f.message, f.created_at FROM findings f WHERE f.repo = ? AND NOT EXISTS (SELECT 1 FROM agent_deliveries d WHERE d.finding_id = f.id AND d.session_id = ? AND d.agent_id = ?) ORDER BY f.id');
    const shown = new Set(out.map((x) => keyOf(x.repo, x.path, x.digest, x.checker)));
    for (const repo of roots) {
      const rows = (root ? unseen.all(repo, sessionId) : unseen.all(repo, sessionId, agentId)) as Array<{ id: number; path: string; digest: string; checker: string; level: 'fail' | 'unknown'; message: string; created_at: number }>;
      const currentDigest = new Map(current.filter((x) => x.repo === repo).map((x) => [x.path, x.digest]));
      for (const r of rows) {
        const theirs = root || (known(repo) ? inWindow(repo, r.path) : since !== null && r.created_at >= since);
        if (currentDigest.get(r.path) !== r.digest || !theirs || shown.has(keyOf(repo, r.path, r.digest, r.checker))) continue;
        const x: Finding = { repo, path: r.path, digest: r.digest, checker: r.checker, level: r.level, message: r.message };
        if (!fits(x)) continue;
        mark(r.id);
        out.push(x);
        fromBacklog++;
      }
    }
  });
  return { found: out, omitted: skipped.size, fromBacklog, owedLater: root || window !== null };
}

export function signature(findings: Finding[]): string {
  return createHash('sha256').update(findings.map((f) => `${f.repo}|${f.path}|${f.checker}|${f.level}|${f.message}`).sort().join('\n')).digest('hex').slice(0, 16);
}

/** Characters of finding lines one report may carry: deliver() marks only what fits, the rest is told next event. */
export const REPORT_CHARS = 8000;
function digestSafe(abs: string): string { try { return digestOf(abs); } catch { return ''; } }
export function findingLine(x: Finding): string { return `- ${x.path} [${x.checker}] ${x.level}: ${x.message.split('\n').slice(0, 4).join(' | ')}`; }

export function formatFindings(f: Finding[], out: SweepOutcome, omitted = 0, owedLater = true): string {
  const head = `harness sweep: изменено ${out.changed}, проверено сейчас ${out.checked}, уже подтверждено ${out.skippedVerified}, в фоне ${out.pending}${out.deferred ? `, отложено ${out.deferred}` : ''}${out.truncated ? `, список обрезан до ${MAX_FILES}` : ''}`;
  const more = omitted ? [`- ещё ${omitted}: не уместились в отчёт${owedLater ? '; по незакоммиченным файлам — на следующем событии' : ''}`] : [];
  const unk = out.unknownReasons.map((r) => `- unknown: ${r}`);
  return [head, ...f.map(findingLine), ...more, ...unk].join('\n').slice(0, REPORT_CHARS + 1500);
}

export const WORKER_PATH = fileURLToPath(new URL('./jobs/worker.ts', import.meta.url));
