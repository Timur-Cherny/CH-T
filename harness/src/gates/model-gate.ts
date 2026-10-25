// PreToolUse(Agent|Task): any explicit `model` on a subagent is denied — inheritance from the parent is the
// only contract (port of hooks/model-gate.sh). A Workflow script is out of scope on purpose: it may set
// opts.model per stage, and no gate judges it. No allowlist of models: a list goes stale and lets a model be
// strengthened under another name. The router reads the kill-switch: CLAUDE_SKIP_MODEL_GATE.
import { register } from './registry.ts';
import type { Gate, GateContext, Verdict } from '../types.ts';

export const NAME = 'model-gate';
const AGENT_TOOLS = new Set(['Agent', 'Task']);

export function decide(ctx: GateContext): Verdict {
  const p = ctx.payload;
  if (!('tool_name' in p) || !AGENT_TOOLS.has(p.tool_name)) return { kind: 'silent' };
  const input = (p as { tool_input?: unknown }).tool_input;
  if (typeof input !== 'object' || input === null) return { kind: 'unknown', gate: NAME, reason: 'tool_input отсутствует или не объект — явную модель не проверить' };
  if (!('model' in input)) return { kind: 'silent' };
  const model = (input as Record<string, unknown>).model;
  if (model === null || model === undefined || model === '') return { kind: 'silent' };
  const shown = typeof model === 'string' ? model : JSON.stringify(model);
  return {
    kind: 'deny', gate: NAME,
    reason: `явная модель субагента запрещена (model=${shown}). Убери model — субагент обязан наследовать модель родителя. Если override действительно нужен, сначала измени сам контракт и его тест.`,
  };
}

const gate: Gate = { name: NAME, events: ['pre-agent'], killSwitch: 'CLAUDE_SKIP_MODEL_GATE', run: decide };
register(gate);
