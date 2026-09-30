// Sweep gates: post/post-batch hand the findings over as context (additionalContext); stop blocks once per signature
// per session and waits out background jobs: workers run them, the drain only waits and hands a job nobody holds to a
// new worker (a job still pending when the window ends blocks Stop).
// No sweep on agent-stop: SubagentStop output is the subagent's next turn and replaces its report, and a delivery
// there spends the finding on the subagent. A finding is owed to the root until its own post or Stop tells it; a subagent
// reads its own ledger and hears only about its window, never the line about checks in the background.
import { register } from './registry.ts';
import { State } from '../state.ts';
import { REPORT_CHARS, deliver, formatFindings, rootReader, signature, sweep, type Reader } from '../sweep.ts';
import { agentWindow } from '../window.ts';
import { awaitJob, pendingJobs } from '../jobs/worker.ts';
import type { GateContext, Verdict } from '../types.ts';

export const STOP_DRAIN_MS = 150_000;

/** Наблюдаемость бюджета R5: последние 50 замеров сверки (мс, изменено, проверено) — в markers, не в телеметрии. */
export function recordTiming(state: State, ms: number, changed: number, checked: number): void {
  const prev = state.marker('sweep:timings');
  const arr: Array<[number, number, number]> = prev ? JSON.parse(prev) : [];
  arr.push([Math.round(ms), changed, checked]);
  state.setMarker('sweep:timings', JSON.stringify(arr.slice(-50)));
}

export async function sweepPost(ctx: GateContext): Promise<Verdict> {
  const p = ctx.payload as { session_id: string; tool_use_id?: string; tool_name?: string; prompt_id?: string; agent_id?: unknown };
  const state = State.open(ctx.stateDir);
  try {
    const key = p.tool_use_id ?? `${p.prompt_id ?? 'p'}:${ctx.event}`;
    if (p.tool_use_id && !state.claim(p.session_id, ctx.event, key, ctx.now())) return { kind: 'silent' }; // второй хук того же события (user + repo-level)
    const t0 = ctx.now();
    const out = await sweep(ctx, state);
    const agentId = typeof p.agent_id === 'string' ? p.agent_id : '';
    const opened = agentId ? agentWindow(state, p.session_id, agentId) : null;
    const reader: Reader = agentId ? { sessionId: p.session_id, agentId, window: opened?.snapshot ?? null, since: opened?.startedAt ?? null } : rootReader(p.session_id);
    const { found, omitted, owedLater } = deliver(state, reader, out.roots, ctx.now(), out.findings, out.files, { filesAt: out.filesAt, budget: REPORT_CHARS });
    recordTiming(state, ctx.now() - t0, out.changed, out.checked);
    // Повтор той же находки на каждом событии исключён уже тем, что неизменившийся файл не перепроверяется
    // (verified) и доставка per-session однократна; подавление по подписи здесь глушило бы повторную поломку после починки.
    if (!found.length && !omitted && !out.unknownReasons.length) return out.pending && !agentId ? { kind: 'context', text: `harness sweep: ${out.pending} проверок в фоне`, gate: 'sweep' } : { kind: 'silent' };
    return { kind: 'context', text: formatFindings(found, out, omitted, owedLater), gate: 'sweep' };
  } finally { state.close(); }
}

export async function sweepStop(ctx: GateContext, drainMs = STOP_DRAIN_MS): Promise<Verdict> {
  const p = ctx.payload as { session_id: string };
  // Хранилище недоступно (заблокировано другим писателем дольше busy-timeout, битый файл) → дерево не проверить.
  // На Stop unknown уходит в context, а context НЕ блокирует — то есть сломанный файл закрыл бы сессию молча.
  // Поэтому здесь единственный не пропускающий исход — block: барьер не отработал, вслепую сессию не закрываем
  // (I1, P3 25.09). Заблокировано временно — следующий Stop пройдёт; протухло совсем — причина видна, чинится.
  let state: State;
  try { state = State.open(ctx.stateDir); }
  catch (e) { return { kind: 'block', reason: `sweep-stop: хранилище недоступно (${(e as Error).message.split('\n')[0]}) — дерево не проверено, сессия не закрывается вслепую`, gate: 'sweep' }; }
  try {
    const deadline = ctx.now() + drainMs;
    const out = await sweep(ctx, state);
    let leftPending = 0;
    for (const repo of out.roots) {
      for (const jobId of pendingJobs(state, repo)) {
        if (await awaitJob(state, jobId, ctx.env, ctx.root, ctx.now, Math.max(0, deadline - ctx.now())) === 'taken') leftPending++;
      }
    }
    const { found, omitted, fromBacklog } = deliver(state, rootReader(p.session_id), out.roots, ctx.now(), out.findings, out.files, { filesAt: out.filesAt, budget: REPORT_CHARS });
    const parts: string[] = [];
    if (found.length || omitted || out.unknownReasons.length) parts.push(formatFindings(found, { ...out, pending: leftPending }, omitted));
    if (leftPending) parts.push(`не дренировано фоновых проверок: ${leftPending} — Stop блокируется до результата`);
    if (!parts.length) return { kind: 'silent' };
    const sig = `stop:${signature(found)}:${leftPending}`;
    const seen = state.db.prepare('SELECT 1 FROM stop_blocks WHERE session_id = ? AND signature = ?').get(p.session_id, sig);
    if (seen && !leftPending && !fromBacklog) return { kind: 'context', text: parts.join('\n'), gate: 'sweep' }; // a repeat with nothing owed anew goes to the human
    state.db.prepare('INSERT OR IGNORE INTO stop_blocks(session_id, signature, blocked_at) VALUES(?,?,?)').run(p.session_id, sig, ctx.now());
    return { kind: 'block', reason: parts.join('\n'), gate: 'sweep' };
  } catch (e) {
    return { kind: 'block', reason: `sweep-stop: сверка не завершилась (${(e as Error).message.split('\n')[0]}) — дерево не проверено, сессия не закрывается вслепую`, gate: 'sweep' };
  } finally { state.close(); }
}

register({ name: 'sweep', events: ['post', 'post-batch'], killSwitch: 'CLAUDE_SKIP_TREE_SWEEP', run: sweepPost });
register({ name: 'sweep-stop', events: ['stop'], killSwitch: 'CLAUDE_SKIP_TREE_SWEEP', run: sweepStop });
