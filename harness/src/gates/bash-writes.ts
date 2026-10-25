// bash-writes — pre-bash: файл, который команда пишет литеральным текстом (here-doc, echo, printf — прямо, через
// tee или трубу), проходит те же гейты записи, что Write и Edit. Иначе `cat > ds.yaml <<'EOF'` обходит правило,
// которое Write отбивает, и барьер зависит от инструмента записи (проба 16.09: манифест с ALTER ROLE … SET через
// here-doc — silent, тот же через Write — deny). Содержимое, которого в команде нет — cp, sed -i, curl -o, скрипт,
// подстановка в echo — не судится: это граница модели, объявленная в README, а не пропуск гейта.
import { resolve, basename } from 'node:path';
import { register, GATES } from './registry.ts';
import { buildModel } from '../parsers/stages.ts';
import type { Stage } from '../parsers/stages.ts';
import type { GateContext, PreToolUsePayload, Verdict } from '../types.ts';

export const NAME = 'bash-writes';
export const KILL = 'CLAUDE_SKIP_BASH_WRITES';
const SILENT: Verdict = { kind: 'silent' };
const RANK: Record<Verdict['kind'], number> = { silent: 0, context: 1, unknown: 2, ask: 3, block: 4, deny: 5 };
type St = Stage<null>;

function printfText(rest: string[]): string | null {
  const [fmt, ...args] = rest;
  if (fmt === undefined) return null;
  if (!args.length) return fmt.replace(/\\n/g, '\n');
  return /^(%s(\\n)?)+$/.test(fmt) ? args.join('\n') + '\n' : null;
}

/** Текст, который стадия выдаёт в stdout, если он целиком в команде: here-doc у cat и tee, литеральные echo и printf. */
export function literalText(st: St): string | null {
  const dyn = (k: number): boolean => st.dynamic[st.restAt + k] === true;
  if (st.heredocs.length && (st.name === 'tee' || (st.name === 'cat' && st.rest.every((t) => t === '-' || t.startsWith('-'))))) return st.heredocs.join('');
  if (st.name !== 'echo' && st.name !== 'printf') return null;
  if (st.rest.some((_, k) => dyn(k))) return null;
  if (st.name === 'echo') return `${st.rest.filter((t, k) => !(k === 0 && /^-[neE]+$/.test(t))).join(' ')}\n`;
  return printfText(st.rest);
}

/** Куда уходит текст стадии: файл за `>`/`>>` и файлы tee. Редирект stderr содержимого не получает. */
function targets(st: St): string[] {
  const out: string[] = [];
  if (st.stdoutTo !== null) out.push(st.stdoutTo);
  if (st.name === 'tee') out.push(...st.rest.filter((t) => !t.startsWith('-')));
  return out;
}

export function literalWrites(command: string, cwd: string): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  for (const st of buildModel<null>(command, () => null).pipelines.flat()) {
    const paths = targets(st);
    if (!paths.length) continue;
    const text = literalText(st) ?? (st.stdinStage ? literalText(st.stdinStage) : null);
    if (text === null) continue;
    for (const p of paths) out.push({ path: resolve(cwd, p), text });
  }
  return out;
}

export async function decide(ctx: GateContext): Promise<Verdict> {
  const p = ctx.payload as PreToolUsePayload;
  if (ctx.event !== 'pre-bash' || p.hook_event_name !== 'PreToolUse' || p.tool_name !== 'Bash') return SILENT;
  const command = typeof p.tool_input?.command === 'string' ? p.tool_input.command : '';
  if (!command) return SILENT;
  const writes = literalWrites(command, p.cwd);
  if (!writes.length) return SILENT;
  // Выключатель внутреннего гейта уважается так же, как в роутере: гейт с ним не вызывается вовсе (I4).
  const gates = GATES.filter((g) => g.name !== NAME && g.events.includes('pre-write') && ctx.env[g.killSwitch] !== '1');
  let top: Verdict = SILENT;
  for (const w of writes) {
    const payload: PreToolUsePayload = { ...p, tool_name: 'Write', tool_input: { file_path: w.path, content: w.text } };
    for (const g of gates) {
      let v: Verdict;
      try { v = await g.run({ ...ctx, event: 'pre-write', payload }); } catch (err) {
        v = { kind: 'unknown', reason: err instanceof Error ? err.message.split('\n')[0] : String(err), gate: g.name };
      }
      if (v.kind === 'silent') continue;
      const tagged: Verdict = 'reason' in v ? { ...v, reason: `${basename(w.path)}, который пишет команда: ${v.reason}` } : v;
      if (RANK[tagged.kind] > RANK[top.kind]) top = tagged;
    }
  }
  return top;
}

register({ name: NAME, events: ['pre-bash'], killSwitch: KILL, run: decide });
