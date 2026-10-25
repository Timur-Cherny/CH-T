// Shared core of every non-Claude runtime: one registry, one merge, one notion of "N/A with a reason".
// Claude Code reaches the gates through harness/bin/hook; Codex, Antigravity and the local agent reach the same
// registry through this module. A runtime adapter only translates its payload into a Claude-shaped HookPayload
// and renders the verdict back into its own output schema — it never re-implements a rule.
import { isAbsolute, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../harness/src/gates/index.ts';
import { GATES } from '../harness/src/gates/registry.ts';
import { merge } from '../harness/src/emit.ts';
import type { GateContext, HarnessEvent, HookPayload, Verdict } from '../harness/src/types.ts';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PRE: ReadonlySet<HarnessEvent> = new Set(['pre-bash', 'pre-write']);

/** Gates that make no sense outside a Claude Code session, whatever the runtime; each with the reason. */
export const BASE_NA: Readonly<Record<string, string>> = {
  'model-gate': 'нет Agent/Task: субагентов адаптер не пропускает',
  'workflow-friction-gate': 'нет инструмента Workflow',
  'work-docs-reminder': 'prompt не передаётся ядру по приватности',
  'memory-index': 'transcript_path не передаётся ядру по приватности',
  'precompact-snapshot': 'transcript_path не передаётся ядру по приватности',
  'session-start': 'контекст корня; исполнитель получает только свою задачу',
  'tracker-inbox': 'очередь @agent исполнителю не показывается',
  'friction-prefilter': 'ревизия графа инцидентов — работа корня',
  'memory-guard': 'контекст корня; на Stop исполнителя уводит модель от задачи',
  'git-freshness': 'сдвиг HEAD отслеживаемых репозиториев — сведения для корня, исполнителю шум',
  'capture-commits': 'журнал общий с Claude, а индекс дедупа раздельный — записи двоились бы',
  telemetry: 'телеметрия Claude читает журналы своих сессий',
  friction: 'события субагентов не подписаны: субагенты выключены',
};

/** Checkers that run code of the checkout itself (.claude/check.sh, the project's TypeScript, the contour's tests).
 *  A hook of a sandboxed client runs outside its sandbox: a model that planted the code there would run it with the
 *  network and the hook's environment. Off for Codex and Antigravity; the local agent has no sandbox to escape. */
export const SANDBOX_SKIPS: Readonly<Record<string, string>> = { CLAUDE_HARNESS_SANDBOXED: '1' };

export const unknownVerdict = (gate: string, reason: string): Verdict => ({ kind: 'unknown', gate, reason });
export const denyVerdict = (gate: string, reason: string): Verdict => ({ kind: 'deny', gate, reason });

/** ask, block and unknown on a pre event become deny: a runtime that cannot show the question must not run the tool. */
export function refuse(v: Verdict): Verdict {
  if (v.kind === 'ask' || v.kind === 'block') return { kind: 'deny', gate: v.gate, reason: v.reason };
  if (v.kind === 'unknown') return { kind: 'deny', gate: v.gate, reason: `unknown(${v.gate}): ${v.reason}` };
  return v;
}

/** Merge for runtimes without a question channel: on pre events anything short of a pass is a deny. */
export function strictMerge(verdicts: Verdict[], event: HarnessEvent, env: NodeJS.ProcessEnv): Verdict {
  if (!PRE.has(event)) return merge(verdicts, event, env);
  const note = env.CLAUDE_HARNESS_UNKNOWN === 'note';
  const merged = merge(verdicts, event, { ...env, CLAUDE_HARNESS_UNKNOWN: note ? 'note' : 'deny' });
  return note && merged.kind === 'context' ? merged : refuse(merged);
}

/** Merge for a runtime whose human sees the question (the local chat): unknown stays ask, never silent. */
export function attendedMerge(verdicts: Verdict[], event: HarnessEvent, env: NodeJS.ProcessEnv): Verdict {
  return merge(verdicts, event, { ...env, CLAUDE_HARNESS_UNKNOWN: env.CLAUDE_HARNESS_UNKNOWN === 'deny' ? 'deny' : 'ask' }, 'default');
}

export interface RunOptions {
  /** Gates this runtime does not reach, by name, each with the reason. */
  na: Readonly<Record<string, string>>;
  /** Absolute state directory of this runtime; never the Claude one. */
  stateDir: string | undefined;
  /** Name used in unknown verdicts of the adapter itself. */
  adapter: string;
  /** How verdicts are merged: strict (no question channel) or attended (a human answers ask). */
  mode?: 'strict' | 'attended';
  /** The client runs the model in a sandbox the hook is outside of: checkers that run checkout code are off. */
  sandboxed?: boolean;
}

// resource-guard waits up to 240 s for resources; a deny from any other gate must not queue behind that wait.
const resourceLast = (a: { name: string }, b: { name: string }): number => Number(a.name === 'resource-guard') - Number(b.name === 'resource-guard');

/** Runs every registry gate of the event that the runtime reaches, in registry order, and merges the verdicts. */
export async function runGates(event: HarnessEvent, payload: HookPayload, env: NodeJS.ProcessEnv, opts: RunOptions): Promise<Verdict> {
  const mergeFn = opts.mode === 'attended' ? attendedMerge : strictMerge;
  const stateDir = opts.stateDir;
  if (!stateDir || !isAbsolute(stateDir)) return mergeFn([unknownVerdict(opts.adapter, 'каталог состояния рантайма должен быть абсолютным путём')], event, env);
  const ctx: GateContext = {
    event, payload, env: { ...env, ...(opts.sandboxed ? SANDBOX_SKIPS : {}), CLAUDE_STATE_DIR: stateDir },
    root: resolve(ROOT, 'harness'), stateDir, now: Date.now,
  };
  const results: Verdict[] = [];
  for (const gate of GATES.filter((g) => g.events.includes(event) && !(g.name in opts.na)).sort(resourceLast)) {
    if (env[gate.killSwitch] === '1' && !env.BRAIN_TASK) continue;
    if (PRE.has(event) && gate.name === 'resource-guard' && results.some((v) => v.kind !== 'silent' && v.kind !== 'context')) break;
    let v: Verdict;
    try { v = await gate.run(ctx); } catch { v = unknownVerdict(gate.name, `проверка ${gate.name} не завершилась`); }
    results.push(v);
    if (PRE.has(event) && v.kind === 'deny') break;
  }
  return mergeFn(results, event, env);
}

/** Every registry gate is either reached by one of the runtime's events or named N/A with a reason. */
export function unreachedGates(events: readonly HarnessEvent[], na: Readonly<Record<string, string>>): string[] {
  return GATES.filter((g) => !(g.name in na) && !g.events.some((e) => events.includes(e))).map((g) => g.name);
}

/** MCP tools a runtime lets through untouched: `mcp__<server>__<tool>` for servers listed in BRAIN_MCP_ALLOWED. */
export function mcpAllowed(tool: string, env: NodeJS.ProcessEnv): boolean {
  const servers = (env.BRAIN_MCP_ALLOWED ?? '').split(',').map((s) => s.trim()).filter((s) => /^[A-Za-z0-9_-]+$/.test(s));
  const m = /^mcp__([A-Za-z0-9_-]+)__[A-Za-z0-9_]+$/.exec(tool);
  return m !== null && servers.includes(m[1]!);
}

/** Text of a verdict for a human or a model: gate name first, as every harness message. */
export function verdictText(v: Verdict): string {
  if (v.kind === 'silent') return '';
  if (v.kind === 'context') return `${v.gate}: ${v.text}`;
  if (v.kind === 'unknown') return `unknown(${v.gate}): ${v.reason}`;
  return `${v.gate}: ${v.reason}${v.kind === 'block' && v.notes ? `\n${v.notes}` : ''}`;
}
