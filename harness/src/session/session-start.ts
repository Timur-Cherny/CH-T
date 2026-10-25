// SessionStart: свежесть детерминированных проверок репозитория — коротко в контекст сессии.
// (1) Инвентарь README между маркерами inventory:begin/end пересчитывается из файлов и сравнивается
//     с записанным: дрейф → строка «обновить --sync». README не правится (только --check оригинала).
// (2) The schedule of mandatory runs, READ ONLY from the very store `due.ts --done` writes (the schedule table
//     in harness.db, the legacy schedule-state.json while it is empty); evaluate() comes from due.ts, there is no
//     second evaluator. No recorded run → unknown, never ok.
// Project root: $CLAUDE_PROJECT_DIR, else toplevel(cwd). The schedule shows in every project (the brain's when the project has none).
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { register } from '../gates/registry.ts';
import { toplevel } from '../git.ts';
import { localDate } from './common.ts';
import { view, reportLines, mainWorktree } from '../../scripts/due.ts';
import { counts, dataLines, currentData } from '../../scripts/readme-inventory.ts';
import type { Gate, GateContext, Verdict } from '../types.ts';

export const NAME = 'session-start';
export const KILL = 'CLAUDE_SKIP_SESSION_START';

// ---------- инвентарь README ----------

function isDir(p: string): boolean { try { return statSync(p).isDirectory(); } catch { return false; } }

/** The five lines of the inventory block, counted by the CLI scripts/readme-inventory.ts: one implementation, not a twin. */
export function inventoryData(root: string): string[] { return dataLines(counts(root)); }

export type ReadmeDrift = { status: 'absent' } | { status: 'ok' } | { status: 'drift'; was: string[]; now: string[] } | { status: 'unknown'; reason: string };

export function readmeDrift(root: string): ReadmeDrift {
  let readme: string;
  try { readme = readFileSync(join(root, 'README.md'), 'utf8'); } catch { return { status: 'absent' }; }
  const was = currentData(readme);
  if (was === null) return { status: 'absent' };
  let now: string[];
  try { now = inventoryData(root); } catch (e) { return { status: 'unknown', reason: (e as Error).message.split('\n')[0] }; }
  return was.join('\n') === now.join('\n') ? { status: 'ok' } : { status: 'drift', was, now };
}

// ---------- schedule (read only) ----------

/** The brain the harness lives in carries the schedule, and a linked worktree of it counts as the brain; another
 *  project with its own specs/schedule.json keeps its own. */
export function scheduleRoot(projectRoot: string, harnessRoot: string): string {
  const brain = mainWorktree(dirname(harnessRoot));
  if (mainWorktree(projectRoot) === brain) return brain;
  return existsSync(join(projectRoot, 'specs', 'schedule.json')) ? projectRoot : brain;
}

export function decide(ctx: GateContext): Verdict {
  const root = ctx.env.CLAUDE_PROJECT_DIR || toplevel(ctx.payload.cwd) || ctx.payload.cwd;
  if (!isDir(root)) return { kind: 'unknown', reason: 'корень проекта не существует', gate: NAME };
  const out: string[] = [];
  const drift = readmeDrift(root);
  if (drift.status === 'unknown') out.push(`readme-inventory: состав не посчитан (${drift.reason}) — инвентарь неизвестен`);
  if (drift.status === 'drift') {
    out.push('readme-inventory: блок «Проверенный состав» разошёлся с фактом. Обновить: ~/.claude/harness/bin/run scripts/readme-inventory.ts --sync');
    const n = Math.max(drift.was.length, drift.now.length);
    for (let i = 0; i < n && out.length < 13; i++) if (drift.was[i] !== drift.now[i]) { if (drift.was[i] !== undefined) out.push(`< ${drift.was[i]}`); if (drift.now[i] !== undefined) out.push(`> ${drift.now[i]}`); }
  }
  const sched = view(scheduleRoot(root, ctx.root), ctx.stateDir, localDate(ctx.now()));
  if (sched.kind === 'rows') out.push(...reportLines(sched.rows, false));
  if (out.length) {
    if (sched.kind === 'unreadable') out.push(`[расписание] specs/schedule.json нечитаем (${sched.error}) — расписание неизвестно`);
    return { kind: 'context', text: out.join('\n'), gate: NAME };
  }
  if (sched.kind === 'unreadable') return { kind: 'unknown', reason: `specs/schedule.json нечитаем (${sched.error}) — расписание неизвестно`, gate: NAME };
  return { kind: 'silent' };
}

const gate: Gate = { name: NAME, events: ['session-start'], killSwitch: KILL, run: decide };
register(gate);
