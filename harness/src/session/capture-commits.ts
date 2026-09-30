// Stop: commits of the git user in every root the session touched → journal `commits` (~/.claude/worklog-commits.jsonl)
// through appendJsonl — metadata only, no subject and no email. Roots: toplevel(cwd) ∪ session_roots ∪ repositories
// whose HEAD moved during a call of this session (head_moves, written by the tree sweep on post) ∪ roots with a due
// entry in pending_commits, whoever's they are: a deferred commit must not wait for its own session to come back.
// A commit belongs to the worktree whose HEAD reflog created it: a creating action, entry time ≈ committer time. Who
// made it is read from head_moves by attribute() once every post that could cover the move has landed — the same answer
// whichever session writes the line. A commit this root did not create (merged, pulled, made in a worktree already
// gone) is written as `window` once its creator had a day to write it.
// Dedup: journal_index(journal='commits', key=<hash>), one BEGIN IMMEDIATE per commit, so a failure on one line never
// rolls back the index of a line already appended. A neighbour holding the lock → unknown, journal untouched.
import { basename, dirname } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { register } from '../gates/registry.ts';
import { State } from '../state.ts';
import { appendJsonl, commitsJournalPath, JournalError } from '../journal.ts';
import { git, toplevel, head, headLogMtime } from '../git.ts';
import { MAX_CALL_MS, MOVE_SLACK_MS } from '../sweep.ts';
import { shortHash } from './common.ts';
import type { Gate, GateContext, Verdict } from '../types.ts';

export const NAME = 'capture-commits';
export const KILL = 'CLAUDE_SKIP_CAPTURE_COMMITS';
export const ADAPTER = 'harness-v4';
/** Until then the post of the call that made a commit may still be on its way: the Bash ceiling plus the post-hook timeout. */
export const DEFER_MS = MAX_CALL_MS + 60_000;
/** A commit this root did not create is written by it only after the creating worktree had this long to write it. */
export const GRACE_MS = 24 * 3600_000;
/** Seconds between committer time and the reflog entry of the operation that created the commit. */
export const MADE_TOLERANCE_S = 3;
const RETAIN_MS = 45 * 86_400_000;
const SINCE = '30 days ago';
const LIMIT = 1000;

export interface CommitMeta { hash: string; ts: string; files: number; insertions: number; deletions: number }
export interface Evidence { session: string; named: boolean }
export type Attribution = 'session' | 'overlapping' | 'window';
export type Decision = { write: true; attribution: Attribution; session: string | null; candidates?: string[] } | { write: false; dueAt: number; kind: 'made' | 'adopt'; movedAt: number };

export const journalPath = commitsJournalPath;

/** Класс ветки — метка вместо имени (имя ветки может нести путь/тему задачи). */
export function branchClass(name: string): string {
  if (name === 'HEAD') return 'detached';
  if (/^(main|master)$/.test(name)) return 'main';
  const m = /^(release|hotfix|feature|fix|feat|chore|docs|refactor|test)\//.exec(name);
  return m ? m[1] : 'other';
}

/** Разбор `git log --pretty=format:%x1e%H%x1f%cI --shortstat`: тема и автор не запрашиваются вовсе. */
export function parseLog(out: string): CommitMeta[] {
  const res: CommitMeta[] = [];
  for (const chunk of out.split('\x1e')) {
    const t = chunk.trim();
    if (!t) continue;
    const [headLine, ...rest] = t.split('\n');
    const [hash, ts] = headLine.split('\x1f');
    if (!/^[0-9a-f]{40}$/.test(hash ?? '')) continue;
    const stat = rest.join('\n');
    const num = (re: RegExp) => Number(re.exec(stat)?.[1] ?? 0);
    res.push({ hash, ts: ts ?? '', files: num(/(\d+) files? changed/), insertions: num(/(\d+) insertions?\(\+\)/), deletions: num(/(\d+) deletions?\(-\)/) });
  }
  return res;
}

/** Whether a reflog entry made its commit: its action word, and for a merge or pull git's own verdict after the colon.
 * After the colon of any other action stands the commit subject — it is never looked at. */
export function creates(message: string): boolean {
  const cut = message.indexOf(': ');
  const action = cut < 0 ? message : message.slice(0, cut);
  const verdict = cut < 0 ? '' : message.slice(cut + 2);
  if (/^(rebase|pull)\b.*\((pick|reword|squash|fixup|edit|continue|merge)\)$/.test(action)) return true;
  if (/^(merge|pull)\b/.test(action)) return verdict.startsWith('Merge made');
  if (action === 'cherry-pick') return verdict !== 'fast-forward';
  return /^(commit( \((initial|amend|merge|cherry-pick)\))?|revert|am)$/.test(action);
}

/** `git log -g --date=unix --format=%H%x1f%gd%x1f%ct%x1f%gs`: commits this worktree created → when HEAD became them (ms). */
export function parseReflog(out: string): { entries: number; made: Map<string, number> } {
  const made = new Map<string, number>();
  let entries = 0;
  for (const line of out.split('\n')) {
    const [hash, selector, ct, ...message] = line.split('\x1f');
    if (!/^[0-9a-f]{40}$/.test(hash ?? '')) continue;
    entries++;
    const movedS = Number(/@\{(\d+)\}$/.exec(selector ?? '')?.[1]);
    if (!Number.isFinite(movedS) || Math.abs(movedS - Number(ct)) > MADE_TOLERANCE_S || !creates(message.join('\x1f'))) continue;
    const prev = made.get(hash);
    if (prev === undefined || movedS * 1000 < prev) made.set(hash, movedS * 1000);
  }
  return { entries, made };
}

/** Who made a commit its worktree created at `movedAt`, from the git calls that ran there while HEAD moved. Nothing
 * is decided before DEFER_MS: a session whose first touch of the worktree is the call still running is not known yet.
 * Proof is one session and a call that named the worktree; any second session makes it one of several. */
export function attribute(evidence: Evidence[], movedAt: number, now: number): Decision {
  if (now - movedAt < DEFER_MS) return { write: false, dueAt: movedAt + DEFER_MS, kind: 'made', movedAt };
  const named = new Set(evidence.filter((e) => e.named).map((e) => e.session));
  const any = [...new Set(evidence.map((e) => e.session))].sort();
  if (any.length === 1 && named.size === 1) return { write: true, attribution: 'session', session: any[0] };
  if (named.size) return { write: true, attribution: 'overlapping', session: null, candidates: any };
  return any.length ? { write: true, attribution: 'window', session: null, candidates: any } : { write: true, attribution: 'window', session: null };
}

/** A commit reachable here that this worktree did not create. */
export function adopt(committedAt: number, now: number): Decision {
  return now - committedAt < GRACE_MS ? { write: false, dueAt: committedAt + GRACE_MS, kind: 'adopt', movedAt: committedAt } : { write: true, attribution: 'window', session: null };
}

function lines(out: string): string[][] { return out.split('\n').filter(Boolean).map((l) => l.split('\x1f')); }

function rootToken(root: string): string { return String(headLogMtime(root) ?? head(root) ?? ''); }

function evidenceAt(st: State, root: string, movedAt: number): Evidence[] {
  const rows = st.db.prepare('SELECT session_id, named FROM head_moves WHERE repo = ? AND started_at - ? <= ? AND ended_at >= ?').all(root, MOVE_SLACK_MS, movedAt, movedAt) as { session_id: string; named: number }[];
  return rows.map((r) => ({ session: r.session_id, named: r.named === 1 }));
}

/** Shortstat of the commits to write, read from any directory of the repository — objects are shared by its worktrees. */
function metaOf(dir: string, hashes: string[]): Map<string, CommitMeta> | string {
  if (!hashes.length) return new Map();
  const r = git(dir, ['log', '--no-walk=unsorted', '--ignore-missing', '--pretty=format:%x1e%H%x1f%cI', '--shortstat', ...hashes], 8000);
  return r.rc === 0 ? new Map(parseLog(r.stdout).map((c) => [c.hash, c])) : `git log не ответил: ${r.stderr.split('\n')[0]}`;
}

/** One transaction per line: a refused line never rolls back the index of one already appended. Throws on a held lock. */
function writeLines(st: State, home: string, root: string, decisions: Map<string, Decision>, meta: Map<string, CommitMeta>, bclass: string): string[] {
  const ins = st.db.prepare("INSERT OR IGNORE INTO journal_index(journal, key) VALUES('commits', ?)");
  const refused: string[] = [];
  for (const [h, d] of decisions) {
    const c = meta.get(h);
    if (!d.write || !c) continue;
    try {
      st.tx(() => {
        if (Number(ins.run(h).changes) !== 1) return;
        appendJsonl(journalPath(home), 'commits', { ts: c.ts, adapter: ADAPTER, session: d.session, attribution: d.attribution, ...(d.candidates ? { candidates: d.candidates } : {}), repo_hash: shortHash(root), commit_hash: h, files: c.files, insertions: c.insertions, deletions: c.deletions, branch_class: bclass });
      });
    } catch (e) { if (e instanceof JournalError) refused.push(e.message); else throw e; }
  }
  return refused;
}

/** One root: null when done or nothing to do, otherwise the reason it stays unknown. */
function scanRoot(ctx: GateContext, st: State, root: string, home: string, force: boolean): string | null {
  const label = basename(root);
  const key = `${NAME}:root:${shortHash(root)}`;
  const token = rootToken(root);
  if (!token) return null; // an empty repository: nothing to collect
  const markerBefore = st.marker(key);
  if (!force && markerBefore === token) return null;
  const now = ctx.now();
  const pendingBefore = (st.db.prepare('SELECT hash FROM pending_commits WHERE repo = ?').all(root) as { hash: string }[]).map((r) => r.hash);
  let note: string | null = null;
  const email = git(root, ['config', '--get', 'user.email'], 3000);
  if (email.rc !== 0 || !email.stdout.trim()) return `${label}: git user.email не настроен — коммиты не атрибутировать`;
  const author = `--author=${email.stdout.trim()}`;
  const reflog = git(root, ['log', '-g', `--since=${SINCE}`, author, '--date=unix', '--format=%H%x1f%gd%x1f%ct%x1f%gs', 'HEAD'], 8000);
  if (reflog.rc !== 0) return `${label}: git log -g не ответил: ${reflog.stderr.split('\n')[0]}`;
  const { entries, made } = parseReflog(reflog.stdout);
  const reach = git(root, ['log', '--branches', 'HEAD', `--since=${SINCE}`, '-n', String(LIMIT), author, '--format=%H%x1f%ct'], 8000);
  if (reach.rc !== 0) return `${label}: git log не ответил: ${reach.stderr.split('\n')[0]}`;
  const reachable = new Map(lines(reach.stdout).map(([h, ct]) => [h!, Number(ct) * 1000]));
  if (reachable.size && !entries && !lines(git(root, ['log', '-g', '-n', '1', '--format=%H', 'HEAD'], 3000).stdout).length && markerBefore !== token) {
    note = `${label}: reflog HEAD пуст — где создан коммит, не доказать; коммиты пишутся как window через сутки`;
  }
  const seen = st.db.prepare("SELECT 1 FROM journal_index WHERE journal = 'commits' AND key = ?");
  const decisions = new Map<string, Decision>();
  for (const h of [...reachable.keys()].filter((x) => !seen.get(x))) {
    const movedAt = made.get(h);
    decisions.set(h, movedAt === undefined ? adopt(reachable.get(h)!, now) : attribute(evidenceAt(st, root, movedAt), movedAt, now));
  }
  const meta = metaOf(root, [...decisions].filter(([, d]) => d.write).map(([h]) => h));
  if (typeof meta === 'string') return `${label}: ${meta}`;
  const deferred = [...decisions].filter(([, d]) => !d.write);
  const common = deferred.length ? git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], 3000).stdout.trim() || null : null;
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], 3000);
  try {
    const refused = writeLines(st, home, root, decisions, meta, branch.rc === 0 ? branchClass(branch.stdout.trim()) : 'unknown');
    if (refused.length) return `${label}: журнал отверг ${refused.length} записей — ${refused[0]}`;
    finishPass(st, { root, key, markerBefore, token, pendingBefore, decisions, common, now });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // SQLITE_BUSY: a neighbour held the lock past busy_timeout — lines already committed stay, the marker does not move.
    return `запись отложена: ${msg.split('\n')[0]}`;
  }
  return note;
}

/** The last step of a pass, in one transaction. A neighbour's pass may have deferred a commit this one never saw, or
 * moved the marker past it: only what this pass read or decided is its to replace, and the marker never goes back. */
export function finishPass(st: State, p: { root: string; key: string; markerBefore: string | null; token: string; pendingBefore: string[]; decisions: Map<string, Decision>; common: string | null; now: number }): void {
  st.tx(() => {
    const drop = st.db.prepare('DELETE FROM pending_commits WHERE repo = ? AND hash = ?');
    for (const h of new Set([...p.pendingBefore, ...p.decisions.keys()])) drop.run(p.root, h);
    const defer = st.db.prepare('INSERT OR REPLACE INTO pending_commits(repo, hash, due_at, kind, moved_at, common) VALUES(?,?,?,?,?,?)');
    for (const [h, d] of p.decisions) if (!d.write) defer.run(p.root, h, d.dueAt, d.kind, d.movedAt, p.common);
    st.db.prepare('DELETE FROM head_moves WHERE repo = ? AND ended_at < ?').run(p.root, p.now - RETAIN_MS);
    if (st.marker(p.key) === p.markerBefore) st.setMarker(p.key, p.token, p.now);
  });
}

/** Due entries of a worktree that is gone: its commits live on in the shared object store, its evidence in head_moves
 * under its path. A worktree removed right after its last commit keeps its attribution and its origin. */
function settleOrphan(ctx: GateContext, st: State, root: string, home: string): string | null {
  const now = ctx.now();
  const rows = st.db.prepare('SELECT hash, kind, moved_at, common FROM pending_commits WHERE repo = ? AND due_at <= ?').all(root, now) as { hash: string; kind: string | null; moved_at: number | null; common: string | null }[];
  const store = rows.map((r) => r.common).find((c): c is string => !!c && existsSync(c));
  const decisions = new Map<string, Decision>();
  for (const r of rows) decisions.set(r.hash, r.kind === 'adopt' || r.moved_at === null ? { write: true, attribution: 'window', session: null } : attribute(evidenceAt(st, root, r.moved_at), r.moved_at, now));
  const meta = store ? metaOf(store, [...decisions.keys()]) : new Map<string, CommitMeta>();
  if (typeof meta === 'string') return `${basename(root)}: ${meta}`;
  for (const h of meta.keys()) if (!lines(git(store!, ['for-each-ref', '--contains', h, '--count=1', '--format=%(refname)', 'refs/heads'], 3000).stdout).length) meta.delete(h); // amended or rebased away
  const lost = [...decisions.keys()].filter((h) => !meta.has(h)).length;
  try {
    const refused = writeLines(st, home, root, decisions, meta, 'unknown');
    if (refused.length) return `${basename(root)}: журнал отверг ${refused.length} записей — ${refused[0]}`;
    st.tx(() => { for (const h of decisions.keys()) st.db.prepare('DELETE FROM pending_commits WHERE repo = ? AND hash = ?').run(root, h); });
  } catch (e) { return `запись отложена: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}`; }
  return lost ? `${basename(root)}: ${lost} отложенных коммитов удалённого воркtree не найдено ни на одной ветке — не записаны` : null;
}

/** A worktree of the session removed before any Stop saw its commits: its branches stay in the shared store, so the
 * main checkout of that store is scanned once, whatever its marker says — what it did not create waits a day there. */
function checkoutsOfGone(st: State, repos: string[]): string[] {
  const out: string[] = [];
  for (const repo of repos) {
    if (existsSync(repo)) continue;
    const key = `${NAME}:gone:${shortHash(repo)}`;
    if (st.marker(key)) continue;
    const common = (st.db.prepare('SELECT common FROM head_moves WHERE repo = ? AND common IS NOT NULL LIMIT 1').get(repo) as { common: string } | undefined)?.common;
    const main = common && basename(common) === '.git' ? dirname(common) : null;
    if (main && rootToken(main)) out.push(main);
    st.setMarker(key, '1');
  }
  return out;
}

export function decide(ctx: GateContext, opts: { busyTimeoutMs?: number } = {}): Verdict {
  const home = ctx.env.HOME;
  if (!home) return { kind: 'unknown', reason: 'HOME не задан — путь журнала неизвестен', gate: NAME };
  const { cwd, session_id: session } = ctx.payload;
  const st = State.open(ctx.stateDir, { busyTimeoutMs: opts.busyTimeoutMs });
  try {
    const reasons: string[] = [];
    const roots = new Set<string>();
    const top = toplevel(cwd);
    if (top) roots.add(top);
    else { try { statSync(cwd); } catch { reasons.push('cwd из payload не существует'); } }
    const known = st.db.prepare('SELECT repo FROM session_roots WHERE session_id = ? UNION SELECT repo FROM head_moves WHERE session_id = ?').all(session, session) as { repo: string }[];
    for (const { repo } of known) if (existsSync(repo)) roots.add(repo);
    const due = new Set((st.db.prepare('SELECT DISTINCT repo FROM pending_commits WHERE due_at <= ?').all(ctx.now()) as { repo: string }[]).map((r) => r.repo));
    for (const main of checkoutsOfGone(st, known.map((k) => k.repo))) { due.add(main); roots.add(main); }
    for (const repo of due) if (!rootToken(repo)) { due.delete(repo); roots.delete(repo); const r = settleOrphan(ctx, st, repo, home); if (r) reasons.push(r); }
    for (const root of new Set([...roots, ...due])) { const r = scanRoot(ctx, st, root, home, due.has(root)); if (r) reasons.push(r); }
    return reasons.length ? { kind: 'unknown', reason: reasons.join('; '), gate: NAME } : { kind: 'silent' };
  } finally { st.close(); }
}

const gate: Gate = { name: NAME, events: ['stop'], killSwitch: KILL, run: (ctx) => decide(ctx) };
register(gate);
