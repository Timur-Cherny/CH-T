// SessionStart: свежесть детерминированных проверок репозитория — коротко в контекст сессии.
// (1) Инвентарь README между маркерами inventory:begin/end пересчитывается из файлов и сравнивается
//     с записанным: дрейф → строка «обновить --sync». README не правится (только --check оригинала).
// (2) The schedule of mandatory runs, READ ONLY from the very store `due.ts --done` writes (the schedule table
//     in harness.db, the legacy schedule-state.json while it is empty); evaluate() comes from due.ts, there is no
//     second evaluator. No recorded run → unknown, never ok.
// Project root: $CLAUDE_PROJECT_DIR, else toplevel(cwd). The schedule shows in every project (the brain's when the project has none).
// Regex — по строкам без грамматики: путь хука в строке settings.json, строка `status: open` в шапке чипа.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { register } from '../gates/registry.ts';
import { toplevel } from '../git.ts';
import { localDate } from './common.ts';
import { view, reportLines, mainWorktree } from '../../scripts/due.ts';
import type { Gate, GateContext, Verdict } from '../types.ts';

export const NAME = 'session-start';
export const KILL = 'CLAUDE_SKIP_SESSION_START';

// ---------- инвентарь README ----------

function listDir(dir: string): string[] { try { return readdirSync(dir); } catch { return []; } }
function isDir(p: string): boolean { try { return statSync(p).isDirectory(); } catch { return false; } }
function isFile(p: string): boolean { try { return statSync(p).isFile(); } catch { return false; } }
function walkMd(dir: string): number {
  let n = 0;
  for (const e of listDir(dir)) { const p = join(dir, e); if (isDir(p)) n += walkMd(p); else if (e.endsWith('.md') && isFile(p)) n++; }
  return n;
}
function jsonStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => jsonStrings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => jsonStrings(x, out));
  return out;
}

/** Пять строк блока «Проверенный состав» — те же формулировки, что в scripts/readme-inventory.sh. */
export function inventoryData(root: string): string[] {
  const hooks = listDir(join(root, 'hooks')).filter((f) => f.endsWith('.sh') && isFile(join(root, 'hooks', f))).sort();
  let settings: unknown = null;
  try { settings = JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8')); } catch { settings = null; }
  const wired = new Set<string>();
  for (const s of jsonStrings(settings)) if (/hooks\/[^ ]+\.sh/.test(s)) for (const m of s.matchAll(/[^/ ]+\.sh/g)) wired.add(m[0]);
  const unwired = hooks.filter((h) => !wired.has(h)).map((h) => `\`${h}\``).join(', ');
  const agents = listDir(join(root, 'agents')).filter((f) => f.endsWith('.md') && isFile(join(root, 'agents', f))).length;
  const skills = listDir(join(root, 'skills')).filter((d) => isDir(join(root, 'skills', d)) && !d.endsWith('-workspace')).length;
  const memRoots = listDir(join(root, 'memory')).filter((d) => isDir(join(root, 'memory', d))).length;
  const memFiles = walkMd(join(root, 'memory'));
  return [
    `- \`hooks/*.sh\`: ${hooks.length}; из них ${wired.size} подключены в \`settings.json\`;`,
    `- не зарегистрированы как lifecycle hooks: ${unwired || '—'};`,
    `- \`agents/*.md\`: ${agents};`,
    `- верхнеуровневых authored skills: ${skills};`,
    `- project-memory roots: ${memRoots}, файлов памяти: ${memFiles}.`,
  ];
}

export type ReadmeDrift = { status: 'absent' } | { status: 'ok' } | { status: 'drift'; was: string[]; now: string[] };

export function readmeDrift(root: string): ReadmeDrift {
  let readme: string;
  try { readme = readFileSync(join(root, 'README.md'), 'utf8'); } catch { return { status: 'absent' }; }
  const lines = readme.split('\n');
  const b = lines.findIndex((l) => l.includes('<!-- inventory:begin')); const e = lines.findIndex((l) => l.includes('<!-- inventory:end'));
  if (b < 0 || e < 0 || e <= b) return { status: 'absent' };
  const was = lines.slice(b + 1, e).filter((l) => l !== '' && !l.startsWith('Снимок'));
  const now = inventoryData(root);
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
  if (drift.status === 'drift') {
    out.push('readme-inventory: блок «Проверенный состав» разошёлся с фактом. Обновить: ~/.claude/harness/bin/run scripts/readme-inventory.ts --sync');
    const n = Math.max(drift.was.length, drift.now.length);
    for (let i = 0; i < n && out.length < 13; i++) if (drift.was[i] !== drift.now[i]) { if (drift.was[i] !== undefined) out.push(`< ${drift.was[i]}`); if (drift.now[i] !== undefined) out.push(`> ${drift.now[i]}`); }
  }
  const sched = view(scheduleRoot(root, ctx.root), ctx.stateDir, localDate(ctx.now()), ctx.env.HOME ?? '');
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
