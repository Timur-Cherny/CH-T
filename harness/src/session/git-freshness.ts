// prompt: checkout freshness — a local HEAD shift since the last turn (another session/chip, no network), the result of
// the BACKGROUND fetch since last time (reported once per change), the mtime of the vault tracker.
// stop: the fingerprint seal after the session's own turn — its own commit is not passed off as foreign; notes for the
// owner about listed branches the background sync left alone (systemMessage, once per state).
// Repositories come from the site config: variables freshness.vaultVar and freshness.repoVars, read from the env or,
// when all are empty, from the shellPaths file through `sh` (spawnTool); no config — nothing is watched. An explicit
// path that is not a git repository → unknown with the reason; an unset variable → skipped.
//
// THE ONLY EXCEPTION FROM spawnTool IN THE CONTOUR: the background fetch runs as a detached process
// `spawn(process.execPath, [this file, '--fetch', root, stateDir, sync], { detached, stdio: 'ignore' }).unref()` —
// no turn waits for the network, the result is read on the next one. Inside the child `git fetch` (each remote on its
// own, so one dead host does not hide another's success) goes through spawnTool('git', …): with the local
// `git fetch . <remote>/<b>:<b>` below, the only write git verbs of the contour, git.ts does not offer them. They run in
// Node, not through the Bash tool, so the pre-bash gates (owner-actions) never see them.
// Sync (freshness.sync): after `<remote>` fetched, each listed local branch moves to <remote>/<branch> by a local
// non-forced fetch — git itself allows only a fast-forward, refuses a branch any worktree holds (the main checkout, a
// rebase or bisect in progress included) and updates the ref under its lock against the value it read. A branch ahead,
// diverged, held or refused stays as it is. No working tree, index or HEAD is ever touched. Open window: a `checkout`
// of the branch already reading it while the sync runs (harness/README.md, risks).
// State — own tables git_freshness and git_sync over State.db; the fetch throttle (600 s) is taken in a transaction
// so two concurrent sessions do not start two fetches.
import { spawn } from 'node:child_process';
import { basename, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { register } from '../gates/registry.ts';
import { State } from '../state.ts';
import { git, toplevel } from '../git.ts';
import { spawnTool } from '../platform.ts';
import { fileMtime } from './common.ts';
import { loadConfig } from '../config.ts';
import type { Gate, GateContext, Verdict } from '../types.ts';
import { isMainModule } from '../is-main.ts';

export const NAME = 'git-freshness';
export const KILL = 'CLAUDE_SKIP_GIT_FRESHNESS';
export const FETCH_EVERY_MS = 600_000;
const TRACKER_MARKER = 'git-freshness:tracker.mtime';

const TABLE = `CREATE TABLE IF NOT EXISTS git_freshness(repo TEXT PRIMARY KEY, head_seen TEXT, fetch_started_at INTEGER DEFAULT 0, behind TEXT DEFAULT '', behind_said TEXT DEFAULT '', updated_at INTEGER)`;
const SYNC_TABLE = `CREATE TABLE IF NOT EXISTS git_sync(repo TEXT NOT NULL, branch TEXT NOT NULL, state TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', said TEXT NOT NULL DEFAULT '', updated_at INTEGER, PRIMARY KEY(repo, branch))`;

export interface RepoSpec { source: string; path: string; explicit: boolean }
export interface SyncSpec { remote: string; branches: string[] }
export interface Deps { spawnFetch?: (root: string, stateDir: string, sync?: SyncSpec) => void }
export interface SyncOutcome {
  branch: string;
  outcome: 'ff' | 'same' | 'absent' | 'held' | 'ahead' | 'diverged' | 'raced' | 'failed';
  local?: string; mine?: number; theirs?: number; holder?: string; reason?: string;
}

function ensureTable(st: State): void { st.db.exec(TABLE); st.db.exec(SYNC_TABLE); }

/** Repository paths: env → the shellPaths file → the default vault. Explicitness decides what a missing directory means. */
export function resolveRepos(env: NodeJS.ProcessEnv): { specs: RepoSpec[]; vault: string | null } {
  const home = env.HOME ?? '';
  const cfg = loadConfig(env);
  const vaultVar = cfg.freshness.vaultVar;
  const names = [...(vaultVar ? [vaultVar] : []), ...cfg.freshness.repoVars];
  let vals: Record<string, string | undefined> = Object.fromEntries(names.map((k) => [k, env[k]]));
  if (names.length && names.every((k) => !vals[k]) && home && cfg.shellPaths) {
    const file = join(home, cfg.shellPaths.file);
    if (existsSync(file)) {
      const r = spawnTool('sh', ['-c', `unset ${names.join(' ')}; . "$0" >/dev/null 2>&1; printf '%s\\n' ${names.map((k) => `"$${k}"`).join(' ')}`, file], { timeoutMs: 3000 });
      if (r.rc === 0) { const out = r.stdout.split('\n'); vals = Object.fromEntries(names.map((k, i) => [k, out[i] || undefined])); }
    }
  }
  const specs: RepoSpec[] = [];
  let vault: string | null = null;
  if (vaultVar && vals[vaultVar]) { vault = vals[vaultVar]!; specs.push({ source: vaultVar, path: vault, explicit: true }); }
  else if (home && cfg.vaultRel) { vault = join(home, cfg.vaultRel); specs.push({ source: `${vaultVar ?? 'vault'}(default)`, path: vault, explicit: false }); }
  for (const k of cfg.freshness.repoVars) if (vals[k]) specs.push({ source: k, path: vals[k]!, explicit: true });
  return { specs, vault };
}

/** Корни без дублей (два env могут смотреть в один репозиторий) + проблемы явных путей. */
export function resolveRoots(env: NodeJS.ProcessEnv): { roots: string[]; problems: string[]; vault: string | null } {
  const { specs, vault } = resolveRepos(env);
  const roots: string[] = []; const problems: string[] = [];
  for (const s of specs) {
    const root = toplevel(s.path);
    if (root === null) { if (s.explicit) problems.push(`${s.source}: каталог исчез или не git-репозиторий`); continue; }
    if (!roots.includes(root)) roots.push(root);
  }
  return { roots, problems, vault };
}

interface Row { repo: string; head_seen: string | null; fetch_started_at: number; behind: string; behind_said: string }

function shortHead(root: string): string | null {
  const r = git(root, ['rev-parse', '--short', 'HEAD'], 3000);
  return r.rc === 0 ? r.stdout.trim() : null;
}

export function spawnFetchDetached(root: string, stateDir: string, sync?: SyncSpec): void {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', fileURLToPath(import.meta.url), '--fetch', root, stateDir, sync ? JSON.stringify(sync) : ''], {
    detached: true, stdio: 'ignore',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_HTTP_LOW_SPEED_LIMIT: '1000', GIT_HTTP_LOW_SPEED_TIME: '30' },
  });
  child.unref();
}

function revParse(root: string, ref: string): string | null {
  const r = git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], 3000);
  return r.rc === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/** refs/heads/<x> → path of the worktree holding it; null when git cannot say (then nothing is proven free). */
function worktreeHolders(root: string): Map<string, string> | null {
  const r = spawnTool('git', ['--no-optional-locks', 'worktree', 'list', '--porcelain'], { cwd: root, timeoutMs: 5000 });
  if (r.rc !== 0) return null;
  const held = new Map<string, string>();
  let path = '';
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice(9);
    else if (line.startsWith('branch ')) held.set(line.slice(7), path);
  }
  return held;
}

export function syncBranches(root: string, sync: SyncSpec, hooks: { beforeUpdate?: (branch: string) => void } = {}): SyncOutcome[] {
  return sync.branches.map((branch): SyncOutcome => {
    const ref = `refs/heads/${branch}`;
    const src = `refs/remotes/${sync.remote}/${branch}`;
    const local = revParse(root, ref);
    const remote = revParse(root, src);
    if (!local || !remote) return { branch, outcome: 'absent' };
    if (local === remote) return { branch, outcome: 'same', local };
    if (spawnTool('git', ['symbolic-ref', '-q', ref], { cwd: root, timeoutMs: 3000 }).rc === 0) return { branch, outcome: 'failed', local, reason: 'это символическая ссылка' };
    const lr = git(root, ['rev-list', '--left-right', '--count', `${local}...${remote}`], 5000);
    const [mine, theirs] = lr.rc === 0 ? lr.stdout.trim().split(/\s+/).map(Number) : [NaN, NaN];
    if (!Number.isFinite(mine) || !Number.isFinite(theirs)) return { branch, outcome: 'failed', local, reason: 'rev-list не ответил' };
    if (mine > 0) return { branch, outcome: theirs > 0 ? 'diverged' : 'ahead', local, mine, theirs };
    const holder = worktreeHolders(root)?.get(ref);
    if (holder !== undefined) return { branch, outcome: 'held', local, mine, theirs, holder };
    hooks.beforeUpdate?.(branch);
    // git itself refuses a non-fast-forward and a branch any worktree holds, a rebase or bisect in progress included.
    const u = spawnTool('git', ['fetch', '--quiet', '--no-write-fetch-head', '--no-auto-maintenance', '--no-recurse-submodules', '.', `${src}:${ref}`], { cwd: root, timeoutMs: 15_000, env: { ...process.env, GIT_REFLOG_ACTION: `git-freshness: fast-forward to ${sync.remote}/${branch}` } });
    if (u.rc === 0) return { branch, outcome: 'ff', local, mine, theirs };
    if (revParse(root, ref) !== local) return { branch, outcome: 'raced', local };
    const refused = /refusing to fetch into branch '[^']*' checked out at '([^']*)'/.exec(u.stderr);
    if (refused) return { branch, outcome: 'held', local, mine, theirs, holder: refused[1] };
    return { branch, outcome: 'failed', local, reason: u.stderr.trim().split('\n')[0] || `git fetch rc ${u.rc}` };
  });
}

function syncNote(name: string, remote: string, o: SyncOutcome): string {
  const up = `${remote}/${o.branch}`;
  if (o.outcome === 'held') return `${name}: ${o.branch} позади ${up} на ${o.theirs} — не перемотана: занята воркtree ${o.holder} (рабочее дерево не трогаю; там: git merge --ff-only ${up})`;
  if (o.outcome === 'ahead') return `${name}: ${o.branch} впереди ${up} на ${o.mine} (неотправленные коммиты или ремоут отмотан назад) — не трогаю`;
  if (o.outcome === 'failed') return `${name}: ${o.branch} не перемотана на ${up}: ${o.reason} — посмотреть руками`;
  return `${name}: ${o.branch} разошлась с ${up} (своих ${o.mine}, с ремоута ${o.theirs}) — не трогаю, решить владельцу`;
}

/** Child body: fetch every remote, sync the listed branches when their remote fetched, lag behind upstream → state. */
export function runFetch(root: string, stateDir: string, sync?: SyncSpec): string {
  process.env.GIT_TERMINAL_PROMPT = '0';
  process.env.GIT_NO_REPLACE_OBJECTS = '1';
  const listed = git(root, ['remote'], 3000);
  const remotes = listed.rc === 0 ? listed.stdout.split('\n').map((x) => x.trim()).filter(Boolean) : [];
  const fetched = new Set(remotes.filter((r) => spawnTool('git', ['fetch', '--quiet', '--', r], { cwd: root, timeoutMs: 180_000 }).rc === 0));
  const outcomes = sync && fetched.has(sync.remote) ? syncBranches(root, sync) : [];
  let behind = '';
  const up = git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], 3000);
  if (up.rc === 0 && up.stdout.trim()) {
    const upstream = up.stdout.trim();
    const n = git(root, ['rev-list', '--count', `HEAD..${upstream}`], 5000);
    const count = n.rc === 0 ? Number(n.stdout.trim()) : 0;
    if (count > 0) behind = `позади ${upstream} на ${count} коммит(ов) — стянуть до чтения`;
  }
  const st = State.open(stateDir);
  try {
    ensureTable(st);
    st.tx(() => {
      st.db.prepare('INSERT INTO git_freshness(repo, behind, updated_at) VALUES(?,?,?) ON CONFLICT(repo) DO UPDATE SET behind = excluded.behind, updated_at = excluded.updated_at').run(root, behind, Date.now());
      const put = st.db.prepare("INSERT INTO git_sync(repo, branch, state, note, updated_at) VALUES(?,?,?,?,?) ON CONFLICT(repo, branch) DO UPDATE SET state = excluded.state, note = excluded.note, said = CASE WHEN excluded.state = '' THEN '' ELSE said END, updated_at = excluded.updated_at");
      for (const o of outcomes) {
        if (o.outcome === 'raced') continue;
        const loud = o.outcome === 'held' || o.outcome === 'ahead' || o.outcome === 'diverged' || o.outcome === 'failed';
        put.run(root, o.branch, loud ? `${o.outcome}:${o.local}` : '', loud ? syncNote(basename(root), sync!.remote, o) : '', Date.now());
      }
    });
  } finally { st.close(); }
  return behind;
}

export function decide(ctx: GateContext, deps: Deps = {}): Verdict {
  if (!ctx.env.HOME) return { kind: 'unknown', reason: 'HOME не задан — пути репозиториев неизвестны', gate: NAME };
  return ctx.event === 'stop' ? seal(ctx) : check(ctx, deps.spawnFetch ?? spawnFetchDetached);
}

function check(ctx: GateContext, spawnFetch: NonNullable<Deps['spawnFetch']>): Verdict {
  const { roots, problems, vault } = resolveRoots(ctx.env);
  const notes: string[] = [];
  const now = ctx.now();
  const st = State.open(ctx.stateDir);
  try {
    ensureTable(st);
    for (const root of roots) {
      const headNow = shortHead(root);
      if (headNow === null) continue;
      const name = basename(root);
      let startFetch = false;
      st.tx(() => {
        const row = st.db.prepare('SELECT repo, head_seen, fetch_started_at, behind, behind_said FROM git_freshness WHERE repo = ?').get(root) as Row | undefined;
        if (row?.head_seen && row.head_seen !== headNow) {
          const subj = git(root, ['log', '--format=%s', '-1'], 3000);
          const top = subj.rc === 0 ? subj.stdout.trim().slice(0, 90) : '?';
          notes.push(`${name}: HEAD сдвинулся ${row.head_seen} → ${headNow} (не тобой — другая сессия/чип). Верх: ${top}`);
        }
        let said = row?.behind_said ?? '';
        const behind = row?.behind ?? '';
        if (behind) { if (behind !== said) { notes.push(`${name}: ${behind}`); said = behind; } }
        else said = '';
        let started = row?.fetch_started_at ?? 0;
        if (now - started >= FETCH_EVERY_MS) { started = now; startFetch = true; }
        st.db.prepare('INSERT INTO git_freshness(repo, head_seen, fetch_started_at, behind, behind_said, updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(repo) DO UPDATE SET head_seen = excluded.head_seen, fetch_started_at = excluded.fetch_started_at, behind_said = excluded.behind_said, updated_at = excluded.updated_at')
          .run(root, headNow, started, behind, said, now);
      });
      if (startFetch) spawnFetch(root, ctx.stateDir, loadConfig(ctx.env).freshness.sync);
    }
    const tracker = loadConfig(ctx.env).freshness.trackerRel;
    if (vault && tracker) {
      const m = fileMtime(join(vault, tracker));
      if (m !== null) {
        const was = st.marker(TRACKER_MARKER);
        if (was !== null && was !== String(m)) notes.push(`${basename(tracker)} изменён с прошлого хода — перечитать нужные задачи, не полагаться на прочитанное`);
        st.setMarker(TRACKER_MARKER, String(m), now);
      }
    }
  } finally { st.close(); }
  if (notes.length) {
    const text = ['СВЕЖЕСТЬ ЧЕКАУТОВ — состояние изменилось не тобой:', ...notes.map((n) => `  · ${n}`), ...problems.map((p) => `  · ${p}`), 'Прочитанное ранее в этой сессии могло устареть. Перечитать перед выводами.'].join('\n');
    return { kind: 'context', text, gate: NAME };
  }
  if (problems.length) return { kind: 'unknown', reason: problems.join('; '), gate: NAME };
  return { kind: 'silent' };
}

function seal(ctx: GateContext): Verdict {
  const { roots, vault } = resolveRoots(ctx.env);
  const notes: string[] = [];
  const now = ctx.now();
  const st = State.open(ctx.stateDir);
  try {
    ensureTable(st);
    for (const root of roots) {
      const h = shortHead(root);
      if (h === null) continue;
      st.tx(() => st.db.prepare('INSERT INTO git_freshness(repo, head_seen, updated_at) VALUES(?,?,?) ON CONFLICT(repo) DO UPDATE SET head_seen = excluded.head_seen, updated_at = excluded.updated_at').run(root, h, now));
    }
    const tracker = loadConfig(ctx.env).freshness.trackerRel;
    if (vault && tracker) { const m = fileMtime(join(vault, tracker)); if (m !== null) st.setMarker(TRACKER_MARKER, String(m), now); }
    st.tx(() => {
      const due = st.db.prepare("SELECT repo, branch, state, note FROM git_sync WHERE note != '' AND state != said").all() as Array<{ repo: string; branch: string; state: string; note: string }>;
      const said = st.db.prepare('UPDATE git_sync SET said = ? WHERE repo = ? AND branch = ?');
      for (const d of due) if (roots.includes(d.repo)) { said.run(d.state, d.repo, d.branch); notes.push(d.note); }
    });
  } finally { st.close(); }
  if (!notes.length) return { kind: 'silent' };
  return { kind: 'context', text: ['ПЕРЕМОТКА ЛОКАЛЬНЫХ ВЕТОК — оставлены как есть:', ...notes.map((n) => `  · ${n}`)].join('\n'), gate: NAME };
}

const gate: Gate = { name: NAME, events: ['prompt', 'stop'], killSwitch: KILL, run: (ctx) => decide(ctx) };
register(gate);

// Child mode: `node git-freshness.ts --fetch <root> <stateDir> [<sync json>]` — only from spawnFetchDetached.
const isMain = isMainModule(import.meta.url);
if (isMain && process.argv[2] === '--fetch' && process.argv[3] && process.argv[4]) {
  try { runFetch(process.argv[3], process.argv[4], process.argv[5] ? JSON.parse(process.argv[5]) as SyncSpec : undefined); } catch { /* background: a failed fetch is absent data, nobody to report to */ }
  process.exit(0);
}
