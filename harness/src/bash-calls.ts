// Bash calls in time: the ceiling of one call and the markers of the root's calls (INC-FRICTION-SHARED-ROOT-FOREIGN-WRITES).
// The shim marks `<session>.<tool_use_id>.start` on every pre-bash of the root before its prefilter, and `.end` when its own
// gate denied the call; friction marks `.end`, or `.bg` for a call left running in the background, on the root's post. The
// file's mtime is the time, its content the call's cwd. An agent's Bash call whose interval crossed a root call of its own
// session, or of another session in a root it wrote in, cannot tell whose write its diff holds.
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PostToolUsePayload } from './types.ts';

/** Hard ceiling of one Bash call: the post of the call that made a commit lands at most this long after it. */
export const MAX_CALL_MS = 600_000;
/** A call in the background lives its `timeout`, 30 min by default and 2 h at most (Bash tool, CC 2.1.289). */
export const BG_DEFAULT_MS = 30 * 60_000;
export const BG_MAX_MS = 2 * 3600_000;
/** A pre without a post may still run: up to 5 min of pre-hooks and the wait for approval come before its 10 min. */
export const START_OPEN_MS = 30 * 60_000;

const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const KINDS = ['start', 'end', 'bg'] as const;
type Kind = (typeof KINDS)[number];

export const rootBashDir = (stateDir: string): string => join(stateDir, 'root-bash');

/** A call keeps running past its post when it was launched in the background or moved there (timeout, Ctrl+B, a message). */
export function backgrounded(p: Pick<PostToolUsePayload, 'tool_input' | 'tool_response'>): boolean {
  return p.tool_input?.run_in_background === true || typeof p.tool_response?.backgroundTaskId === 'string';
}

/** Telemetry never blocks a call: a directory that cannot be made only leaves the call unmarked. */
export function ensureRootBashDir(stateDir: string): void {
  try { mkdirSync(rootBashDir(stateDir), { recursive: true }); } catch { return; }
}

/** Only a call launched in the background names its life; one Claude Code moved there gets the default. */
export function backgroundLife(p: Pick<PostToolUsePayload, 'tool_input'>): number {
  const timeout = p.tool_input?.timeout;
  return p.tool_input?.run_in_background === true && typeof timeout === 'number' && timeout > 0 ? Math.min(timeout, BG_MAX_MS) : BG_DEFAULT_MS;
}

/** The root's post: `.end`, or `.bg` whose mtime is the end of the call's life in the background. Ids outside
 * [A-Za-z0-9_-] would make a path, so they leave no marker; a failed write leaves none either. */
export function markRootBashPost(stateDir: string, p: PostToolUsePayload, now: number): void {
  const id = p.tool_use_id;
  if (!id || !SAFE_ID.test(p.session_id) || !SAFE_ID.test(id)) return;
  const bg = backgrounded(p);
  const path = join(rootBashDir(stateDir), `${p.session_id}.${id}.${bg ? 'bg' : 'end'}`);
  try {
    ensureRootBashDir(stateDir); writeFileSync(path, typeof p.cwd === 'string' ? p.cwd : '');
    if (bg) { const until = (now + backgroundLife(p)) / 1000; utimesSync(path, until, until); }
  } catch { return; }
}

/** True when a root call of `session` ran at some moment of [from, to]. A pre without a post runs START_OPEN_MS, a post
 * without its pre ran at most the Bash ceiling before it, a backgrounded call runs until the mtime of its `.bg`. */
export function rootBashCrosses(stateDir: string, session: string, from: number, to: number): boolean {
  for (const c of markedCalls(stateDir, (s) => s === session).values()) if (crosses(c, from, to)) return true;
  return false;
}

/** True when a root call of another session ran at some moment of [from, to] with its cwd inside one of `repos`
 * (INC-FRICTION-CROSS-SESSION-WRITES). A marker without a cwd cannot be placed in a root and does not count: every other
 * session's call would otherwise take the credit from every agent. */
export function otherSessionBashCrosses(stateDir: string, session: string, repos: ReadonlySet<string>, from: number, to: number, rootOf: (cwd: string) => string | null): boolean {
  const roots = new Map<string, string | null>();
  for (const [key, c] of markedCalls(stateDir, (s) => s !== session)) {
    if (!crosses(c, from, to)) continue;
    const cwd = KINDS.map((k) => readCwd(join(rootBashDir(stateDir), `${key}.${k}`))).find(Boolean);
    if (!cwd) continue;
    if (!roots.has(cwd)) roots.set(cwd, rootOf(cwd));
    const root = roots.get(cwd);
    if (root && repos.has(root)) return true;
  }
  return false;
}

type Call = Partial<Record<Kind, number>>;

/** The marked calls of the sessions `pick` accepts, keyed `<session>.<tool_use_id>`: both ids are [A-Za-z0-9_-], so the
 * first dot ends the session and the last one starts the kind. */
function markedCalls(stateDir: string, pick: (session: string) => boolean): Map<string, Call> {
  const calls = new Map<string, Call>();
  let names: string[];
  try { names = readdirSync(rootBashDir(stateDir)); } catch { return calls; }
  for (const name of names) {
    const first = name.indexOf('.'); const dot = name.lastIndexOf('.'); const kind = name.slice(dot + 1) as Kind;
    if (first <= 0 || dot <= first + 1 || !KINDS.includes(kind) || !pick(name.slice(0, first))) continue;
    let at: number; try { at = statSync(join(rootBashDir(stateDir), name)).mtimeMs; } catch { continue; }
    const key = name.slice(0, dot);
    calls.set(key, { ...calls.get(key), [kind]: at });
  }
  return calls;
}

/** A pre without a post runs START_OPEN_MS, a post without its pre ran at most the Bash ceiling before it, a backgrounded
 * call runs until the mtime of its `.bg`. */
function crosses(c: Call, from: number, to: number): boolean {
  const start = c.start ?? (c.end !== undefined ? c.end - MAX_CALL_MS : c.bg !== undefined ? c.bg - BG_MAX_MS - MAX_CALL_MS : undefined);
  if (start === undefined) return false;
  const end = c.bg ?? c.end ?? start + START_OPEN_MS;
  return start <= to && end >= from;
}

const readCwd = (path: string): string => { try { return readFileSync(path, 'utf8'); } catch { return ''; } };

/** Markers outlive no call: everything older than `before` goes, the directory stays for the shim to write into; a file a
 * concurrent stop already removed is skipped. */
export function sweepRootBash(stateDir: string, before: number): void {
  let names: string[];
  try { names = readdirSync(rootBashDir(stateDir)); } catch { return; }
  for (const name of names) {
    const p = join(rootBashDir(stateDir), name);
    try { if (statSync(p).mtimeMs < before) rmSync(p, { force: true }); } catch { continue; }
  }
}
