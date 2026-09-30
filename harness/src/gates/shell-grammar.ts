// shell-grammar — I1 for every pre-bash gate at once: a command the grammar read only up to a parse error is not silent
// while the unread tail names a word some gate judges (PRE_BASH_TRIGGERS, the same list the shim filters by). Each gate
// builds its own model and sees only the parsed part, so one grammar gap before psql or git blinds all of them.
// REGRESSION 25.09: `if [[ -f a ]]; then …; fi; psql -c "SET …"` was silent everywhere; the lexer gap is fixed, the class
// is closed here, and here only: data-boundary no longer turns a parse error into its own unknown. The tail is judged
// by words only — whether bash itself would run it is not decided (unknown, not deny).
import { register } from './registry.ts';
import { buildModel } from '../parsers/stages.ts';
import { PRE_BASH_REGEX } from './prefilters.ts';
import type { GateContext, PreToolUsePayload, Verdict } from '../types.ts';

export const NAME = 'shell-grammar';
export const KILL = 'CLAUDE_SKIP_SHELL_GRAMMAR';
const SILENT: Verdict = { kind: 'silent' };

export function judgeCommand(command: string): Verdict {
  for (const tail of buildModel<null>(command, () => null).unparsed) {
    const word = PRE_BASH_REGEX.exec(tail)?.[0];
    if (word === undefined) continue;
    const shown = tail.length > 80 ? `${tail.slice(0, 80)}…` : tail;
    return {
      kind: 'unknown', gate: NAME,
      reason: `${NAME}: команда вне грамматики оболочки с «${shown}», а в неразобранном остатке стоит «${word}» — ни один гейт его не видел. Перепиши команду проще: отдельными строками, без склеенных конструкций.`,
    };
  }
  return SILENT;
}

export function decide(ctx: GateContext): Verdict {
  const p = ctx.payload as PreToolUsePayload;
  if (p.hook_event_name !== 'PreToolUse' || p.tool_name !== 'Bash') return SILENT;
  const command = (p.tool_input as Record<string, unknown> | undefined)?.command;
  return typeof command === 'string' ? judgeCommand(command) : SILENT;
}

register({ name: NAME, events: ['pre-bash'], killSwitch: KILL, run: decide });
