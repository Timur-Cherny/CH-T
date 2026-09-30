// UserPromptSubmit: a prompt meaning «document this / how does … work» in a repository with the work-doc convention →
// a reminder to record the explanation as a work-doc in the vault, not only in chat. Silent outside a match.
// The site (which repositories, what text) is the `workDocs` config block; unset — the gate is silent. The intent
// (INTENT) stays in code: it is a property of the language, not of the site. Regex runs over the cwd path and the
// prompt text, which have no grammar.
import { register } from '../gates/registry.ts';
import { loadConfig } from '../config.ts';
import type { Gate, GateContext, Verdict } from '../types.ts';

export const NAME = 'work-docs-reminder';
export const KILL = 'CLAUDE_SKIP_WORK_DOCS';

export const INTENT = /документ|задокумент|vault|obsidian|work-?doc|ворк-?док|опиши .*(бизнес|систем|работает|флоу)|как (работает|устроен|обрабатыва)|запиши .*(документ|память)/;

export function decide(ctx: GateContext): Verdict {
  const wd = loadConfig(ctx.env).workDocs;
  if (!wd) return { kind: 'silent' }; // конвенция площадки не настроена — напоминать не о чем
  let cwdRe: RegExp;
  try {
    cwdRe = new RegExp(wd.cwd);
  } catch {
    return { kind: 'silent' }; // битый regex в конфиге не должен ронять каждый промпт
  }
  if (!cwdRe.test(ctx.payload.cwd)) return { kind: 'silent' };
  const prompt = (ctx.payload as { prompt?: unknown }).prompt;
  if (typeof prompt !== 'string') return { kind: 'unknown', reason: 'в payload нет prompt — намерение не проверить', gate: NAME };
  return INTENT.test(prompt.toLowerCase()) ? { kind: 'context', text: wd.text, gate: NAME } : { kind: 'silent' };
}

const gate: Gate = { name: NAME, events: ['prompt'], killSwitch: KILL, run: decide };
register(gate);
