// SessionStart: owner comments tagged @agent in the local tracker that nobody has handled yet. The queue has no
// standing listener, so every session start names it; a tracker that does not answer is reported, never silence.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { register } from '../gates/registry.ts';
import type { Gate, GateContext, Verdict } from '../types.ts';

export const NAME = 'tracker-inbox';
export const KILL = 'CLAUDE_SKIP_TRACKER_INBOX';
export const TIMEOUT_MS = 1500;
const SHOWN = 8;
export const TOKEN_FILE = '.claude/.secrets/tracker-agent-token';

interface Row { issue?: unknown; acked?: unknown }
type Fetch = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export async function decide(ctx: GateContext, get: Fetch = fetch): Promise<Verdict> {
  const installed = ctx.env.TRACKER_URL || (ctx.env.HOME && existsSync(join(ctx.env.HOME, TOKEN_FILE)));
  if (!installed) return { kind: 'silent' };
  const base = String(ctx.env.TRACKER_URL || 'http://tracker.localhost').replace(/\/$/, '');
  let rows: unknown;
  try {
    const res = await get(`${base}/api/agent/inbox`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { kind: 'context', text: `[трекер] очередь @agent не проверена: ${base} ответил ${res.status}`, gate: NAME };
    rows = await res.json();
  } catch (e) {
    const why = (e as Error).name === 'TimeoutError' ? `нет ответа за ${TIMEOUT_MS} мс` : 'не отвечает';
    return { kind: 'context', text: `[трекер] очередь @agent не проверена: ${base} ${why}`, gate: NAME };
  }
  if (!Array.isArray(rows)) return { kind: 'context', text: '[трекер] очередь @agent не проверена: ответ не список', gate: NAME };
  const open = (rows as Row[]).filter((r) => r && !r.acked && typeof r.issue === 'string');
  if (!open.length) return { kind: 'silent' };
  const ids = [...new Set(open.map((r) => r.issue as string))];
  const list = ids.slice(0, SHOWN).join(', ') + (ids.length > SHOWN ? ` и ещё ${ids.length - SHOWN}` : '');
  return {
    kind: 'context',
    text: `[трекер] @agent ждут ответа: ${open.length} — ${list}. Назвать их владельцу в первом ответе; разобрать — tracker_inbox, взять — tracker_start, подтвердить — tracker_ack.`,
    gate: NAME,
  };
}

const gate: Gate = { name: NAME, events: ['session-start'], killSwitch: KILL, run: (ctx) => decide(ctx) };
register(gate);
