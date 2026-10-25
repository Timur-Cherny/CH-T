// SessionStart: тулчейн харнесса (TOOLCHAIN.lock) не установлен или не совпадает с замком. Без него гейты и проверки
// на TS-AST отвечают unknown на каждом событии, и это выглядит как норма — сигнал печатается при старте сессии.
import { register } from '../gates/registry.ts';
import { verifyTypescript } from '../toolchain.ts';
import type { Gate, GateContext, Verdict } from '../types.ts';

export const NAME = 'toolchain-signal';
export const KILL = 'CLAUDE_SKIP_TOOLCHAIN_SIGNAL';

export function decide(ctx: GateContext): Verdict {
  const v = verifyTypescript(ctx.env, ctx.root);
  if (v.ok) return { kind: 'silent' };
  return { kind: 'context', text: `[тулчейн] ${v.reason}. До установки гейты и проверки на TS-AST отвечают unknown.`, gate: NAME };
}

const gate: Gate = { name: NAME, events: ['session-start'], killSwitch: KILL, run: decide };
register(gate);
