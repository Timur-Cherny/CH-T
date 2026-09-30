// Прогон гейтов pre-bash по командам из транскриптов двумя разборщиками команды — старым (legacy) и по грамматике —
// с таблицей переходов вердиктов. Тексты команд не печатаются (граница данных): только счётчики; `--show a→b`
// печатает команды одного перехода для разбора на месте. deny→clean обязан быть 0 — это регрессия барьера.
//   node scripts/shell-replay.ts [--root ~/.claude/projects] [--days 30] [--gates all|имя,имя] [--no-prefilter]
//                                [--sample N] [--json] [--show deny→clean]
// --no-prefilter берёт все команды, а не только те, что доходят до гейтов в живой сессии: так парсер нагружается шире.
// Ресурсный гейт запускается с нулевым ожиданием окна: интересен вердикт разбора, не память машины.
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../src/gates/index.ts';
import { GATES } from '../src/gates/registry.ts';
import type { GateContext, HookPayload, Verdict } from '../src/types.ts';
import { isMainModule } from '../src/is-main.ts';

export type Kind = 'clean' | 'deny' | 'unknown' | 'ask' | 'note' | 'wait';
export interface Replay { commands: number; gates: Record<string, { transitions: Record<string, number>; legacy: Record<string, number>; grammar: Record<string, number> }> }

const HARNESS = fileURLToPath(new URL('..', import.meta.url));

/** Уникальные команды Bash из транскриптов за days дней; проходят префильтр bin/prefilter.regex, как и в живой сессии. */
export function collect(root: string, days: number, prefilter = true): string[] {
  const since = Date.now() - days * 86400_000;
  const re = prefilter ? new RegExp(readFileSync(join(HARNESS, 'bin', 'prefilter.regex'), 'utf8').trim()) : /(?:)/;
  const out = new Set<string>();
  let dirs: string[] = [];
  try { dirs = readdirSync(root).map((d) => join(root, d)).filter((p) => statSync(p).isDirectory()); } catch { return []; }
  for (const dir of dirs) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
      const path = join(dir, f);
      if (statSync(path).mtimeMs < since) continue;
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.includes('"Bash"')) continue;
        let j: { message?: { content?: unknown } };
        try { j = JSON.parse(line); } catch { continue; }
        const content = j?.message?.content;
        if (!Array.isArray(content)) continue;
        for (const b of content) {
          const cmd = b && typeof b === 'object' && b.type === 'tool_use' && b.name === 'Bash' ? b.input?.command : undefined;
          if (typeof cmd === 'string' && re.test(cmd)) out.add(cmd);
        }
      }
    }
  }
  return [...out];
}

export const kindOf = (v: Verdict): Kind => (v.kind === 'silent' ? 'clean' : v.kind === 'context' ? 'note' : v.kind);

export async function replay(commands: string[], gateNames: string[], cwd: string): Promise<Replay> {
  const stateDir = mkdtempSync(join(tmpdir(), 'shell-replay-'));
  const gates = GATES.filter((g) => g.events.includes('pre-bash') && gateNames.includes(g.name));
  const out: Replay = { commands: commands.length, gates: {} };
  for (const g of gates) out.gates[g.name] = { transitions: {}, legacy: {}, grammar: {} };
  const bump = (m: Record<string, number>, k: string): void => { m[k] = (m[k] ?? 0) + 1; };
  const baseEnv = { ...process.env, CLAUDE_STATE_DIR: stateDir, RESOURCE_GUARD_WAIT_S: '0', RESOURCE_GUARD_MIN_MB: '0', RESOURCE_GUARD_MAX_LOAD: '1000000', CLAUDE_HARNESS_UNKNOWN: 'note' };
  try {
    for (const command of commands) {
      const payload = { session_id: 'replay', cwd, permission_mode: 'auto', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: 'replay' } as unknown as HookPayload;
      for (const g of gates) {
        const kinds: Kind[] = [];
        for (const mode of ['legacy', 'grammar'] as const) {
          const env = { ...baseEnv, CLAUDE_HARNESS_SHELL_PARSER: mode === 'legacy' ? 'legacy' : 'grammar' };
          process.env.CLAUDE_HARNESS_SHELL_PARSER = env.CLAUDE_HARNESS_SHELL_PARSER;
          const ctx: GateContext = { event: 'pre-bash', payload, env, root: HARNESS, stateDir, now: Date.now };
          let v: Verdict;
          try { v = await g.run(ctx); } catch (err) { v = { kind: 'unknown', reason: err instanceof Error ? err.message : String(err), gate: g.name }; }
          kinds.push(kindOf(v));
          bump(out.gates[g.name][mode], kinds[kinds.length - 1]);
        }
        bump(out.gates[g.name].transitions, `${kinds[0]}→${kinds[1]}`);
      }
    }
  } finally {
    delete process.env.CLAUDE_HARNESS_SHELL_PARSER;
    rmSync(stateDir, { recursive: true, force: true });
  }
  return out;
}

export function render(r: Replay): string {
  const lines = [`команд: ${r.commands}`, '', '| гейт | переход | сколько |', '|---|---|---:|'];
  for (const [gate, g] of Object.entries(r.gates)) {
    const keys = Object.keys(g.transitions).sort((a, b) => (a.split('→')[0] === a.split('→')[1] ? 1 : 0) - (b.split('→')[0] === b.split('→')[1] ? 1 : 0) || a.localeCompare(b));
    for (const k of keys) lines.push(`| ${gate} | ${k}${k.startsWith('deny→') && !k.endsWith('→deny') ? ' ⛔' : ''} | ${g.transitions[k]} |`);
  }
  const bad = Object.values(r.gates).reduce((n, g) => n + Object.entries(g.transitions).filter(([k]) => k.startsWith('deny→') && !k.endsWith('→deny')).reduce((m, [, v]) => m + v, 0), 0);
  lines.push('', bad ? `⛔ deny→не-deny: ${bad} — регрессия барьера, слияние запрещено` : '✓ deny→не-deny: 0');
  return lines.join('\n');
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (name: string, dflt: string): string => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt; };
  const root = opt('--root', join(process.env.HOME ?? '', '.claude', 'projects'));
  const days = Number(opt('--days', '30'));
  const wanted = opt('--gates', 'all');
  const gates = wanted === 'all' ? GATES.filter((g) => g.events.includes('pre-bash')).map((g) => g.name) : wanted.split(',');
  const sample = Number(opt('--sample', '0'));
  let commands = collect(root, days, !args.includes('--no-prefilter'));
  if (sample > 0 && commands.length > sample) commands = commands.filter((_, i) => i % Math.ceil(commands.length / sample) === 0);
  replay(commands, gates, process.cwd()).then(async (r) => {
    if (args.includes('--json')) console.log(JSON.stringify(r, null, 2));
    else console.log(render(r));
    const show = opt('--show', '');
    if (show) {
      const [from, to] = show.split('→');
      for (const g of GATES.filter((x) => x.events.includes('pre-bash') && gates.includes(x.name))) {
        for (const command of commands) {
          const one = await replay([command], [g.name], process.cwd());
          if (one.gates[g.name].transitions[`${from}→${to}`]) console.log(`--- ${g.name} ${show}\n${command}`);
        }
      }
    }
  }, (err) => { console.error(err); process.exit(1); });
}
