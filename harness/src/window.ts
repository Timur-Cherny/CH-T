// The agent window: what changed in the session's roots while one subagent ran. friction takes the snapshot at
// SubagentStart (agent_window.snapshot); sweep reads it to decide which findings that subagent is a reader of.
// One digest definition serves both sides, so a comparison never mixes two ways of hashing the same file.
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import type { State } from './state.ts';

export const WINDOW_DIGEST_BYTES = 400_000;

/** repo → (path → windowDigest) of the changed and untracked files at the moment of the snapshot. */
export type Snapshot = Record<string, Record<string, string>>;

/** Digest of the first WINDOW_DIGEST_BYTES of a file, plus its size when it is longer than that — a cut or a growth past
 * the window shows, an edit that keeps both the head and the size does not; null — the file cannot be read. */
export function windowDigest(abs: string): string | null {
  try {
    const fd = openSync(abs, 'r');
    try {
      const buf = Buffer.alloc(WINDOW_DIGEST_BYTES); const n = readSync(fd, buf, 0, WINDOW_DIGEST_BYTES, 0);
      const head = createHash('sha256').update(buf.subarray(0, n)).digest('hex').slice(0, 16);
      const st = fstatSync(fd);
      return st.size > WINDOW_DIGEST_BYTES ? `${head}:${st.size}` : head;
    } finally { closeSync(fd); }
  } catch { return null; }
}

/** The window subagent `agentId` of the session opened at SubagentStart: its snapshot and start time; null — no start was
 * recorded for it, or the window closed at SubagentStop and a resume brought no new start: what changed since is others'. */
export function agentWindow(state: State, sessionId: string, agentId: string): { snapshot: Snapshot; startedAt: number } | null {
  const row = state.db.prepare('SELECT snapshot, started_at, stopped_at FROM agent_window WHERE session_id = ? AND agent_id = ?').get(sessionId, agentId) as { snapshot: string; started_at: number; stopped_at: number | null } | undefined;
  if (!row || row.stopped_at !== null) return null;
  let snapshot: Snapshot; try { snapshot = JSON.parse(row.snapshot) as Snapshot; } catch { snapshot = {}; }
  return { snapshot, startedAt: row.started_at };
}

/** True unless the file kept the content it had in the snapshot of its root: a path that was clean then, or a different
 * digest. The caller decides what a root absent from the snapshot means. */
export function changedSince(snap: Snapshot, repo: string, path: string, abs: string): boolean {
  const at = snap[repo]?.[path];
  return at === undefined || windowDigest(abs) !== at;
}
