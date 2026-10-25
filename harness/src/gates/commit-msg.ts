// PreToolUse(Bash) `git commit`: сообщение коммита без следов AI-инструментов (порт hooks/commit-msg-guard.sh).
// Команда разбирается токенизатором и git-argv (`cd X &&`, `git -C X`); сообщение берётся из `-m`/`--message`
// и — в отличие от bash-оригинала, у которого это названная дыра — читается из файла `-F`/`--file`.
// `git commit -F - <<EOF` and `-m "$(cat <<'EOF' … EOF)"` are read: the here-doc body sits in the same command line.
// Unknown stays for stdin without a here-doc (`… | git commit -F -`), a here-doc with expansions, a missing
// terminator, any other `$(…)` and cd into an unknown variable.
// Regex ATTRIBUTION применяется к сообщению коммита — тексту без грамматики (PORTING: допустимо); когда
// источник непрозрачен, он же применяется к сырому тексту команды: видимая атрибуция — доказанное
// нарушение, а не «нет данных».
import { readFileSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { register } from './registry.ts';
import { tokenize } from '../parsers/shell.ts';
import { parseShell } from '../parsers/parser.ts';
import { segmentsWithCwd, parseGit, isGit } from './git-argv.ts';
import type { Gate, GateContext, Verdict } from '../types.ts';

export const NAME = 'commit-msg-guard';
const ATTRIBUTION = /co-authored-by:[^\n]*(claude|anthropic)|noreply@anthropic\.com|generated with[^\n]*claude|claude-session:|🤖/i;
const DENY_TEXT = 'в коммит-месседже AI-атрибуция (Co-Authored-By Claude/Anthropic, noreply@anthropic.com, «Generated with Claude», Claude-Session или 🤖). Правило юзера: коммиты без следов AI. Убери эти строки из сообщения и повтори коммит.';
// Короткие опции commit со значением: кластер `-am x` читается слева направо, первая такая опция забирает остаток.
const VALUE_SHORT = new Set(['m', 'F', 'c', 'C', 't']);
const VALUE_LONG = new Set(['--message', '--file', '--reuse-message', '--reedit-message', '--template', '--author', '--date', '--fixup', '--squash', '--cleanup', '--trailer']);

interface MessageSources { messages: string[]; files: string[] }

export function messageSources(args: string[]): MessageSources {
  const messages: string[] = []; const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') break;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq < 0 ? a : a.slice(0, eq);
      let val: string | undefined;
      if (eq >= 0) val = a.slice(eq + 1);
      else if (VALUE_LONG.has(key)) val = args[++i];
      if (key === '--message') messages.push(val ?? '');
      else if (key === '--file') files.push(val ?? '');
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const ch = a[j];
        if (!VALUE_SHORT.has(ch)) continue;
        const val = a.slice(j + 1) || (args[++i] ?? '');
        if (ch === 'm') messages.push(val); else if (ch === 'F') files.push(val);
        break;
      }
    }
  }
  return { messages, files };
}

/** A function or an alias named cat anywhere in the command: its `$(cat <<'X' …)` no longer prints the here-doc. */
function catRedefined(command: string): boolean {
  const stack: unknown[] = [parseShell(command)];
  while (stack.length) {
    const n = stack.pop();
    if (Array.isArray(n)) { stack.push(...n); continue; }
    if (!n || typeof n !== 'object') continue;
    const o = n as { kind?: string; name?: string; words?: Array<{ text: string }> };
    if (o.kind === 'func' && o.name === 'cat') return true;
    if (o.kind === 'simple' && o.words?.[0]?.text === 'alias' && o.words.slice(1).some((w) => /^['"]?cat=/.test(w.text))) return true;
    stack.push(...Object.values(n));
  }
  return false;
}

/** `-m "$(cat <<'X' … X)"` — the form Claude Code writes: a quoted here-doc read by a bare cat is the message itself,
 *  minus the trailing newlines `$(…)` strips. Any other body, an unquoted here-doc or a redefined cat stays opaque. */
function catHeredoc(value: string, redefined: boolean): string | null {
  const m = /^\$\(([\s\S]*)\)$/.exec(value);
  if (!m || redefined) return null;
  const s = parseShell(m[1]);
  const item = s.errors.length === 0 && s.body.items.length === 1 ? s.body.items[0] : null;
  const cmds = item && !item.bg && item.pipelines.length === 1 ? item.pipelines[0].commands : [];
  const c = cmds.length === 1 ? cmds[0] : null;
  if (!c || c.kind !== 'simple' || c.words.length !== 1 || !c.words[0].bare || c.words[0].text !== 'cat' || c.redirects.length !== 1) return null;
  const h = c.redirects[0].here;
  return h && h.quoted && h.terminated ? h.body.replace(/\n+$/, '') : null;
}

const unknown = (reason: string): Verdict => ({ kind: 'unknown', gate: NAME, reason });
const DENY: Verdict = { kind: 'deny', gate: NAME, reason: DENY_TEXT };

export function decide(ctx: GateContext): Verdict {
  const p = ctx.payload;
  if (!('tool_name' in p) || p.tool_name !== 'Bash') return { kind: 'silent' };
  const command = (p.tool_input as { command?: unknown } | undefined)?.command;
  if (typeof command !== 'string' || !command.trim()) return { kind: 'silent' };
  const parse = tokenize(command);
  for (const seg of segmentsWithCwd(parse, p.cwd, ctx.env)) {
    if (!isGit(seg.name)) continue;
    const call = parseGit(seg.rest, seg.cwd, seg.env);
    if (!call || call.verb !== 'commit') continue;
    const src = messageSources(call.args);
    let opaque = [...seg.unknown];
    const texts: string[] = [];
    let resolved = true;
    for (const m of src.messages) {
      if (!m.includes('$(') && !m.includes('`')) { texts.push(m); continue; }
      const body = catHeredoc(m, catRedefined(command));
      if (body === null) resolved = false; else texts.push(body);
    }
    const elsewhere = call.args.some((a) => (a.includes('$(') || a.includes('`')) && !src.messages.includes(a));
    if (resolved && !elsewhere) opaque = opaque.filter((o) => o !== 'command-substitution');
    // `-F -` со своим here-doc — читаемый источник; без него на stdin приходит чужой вывод.
    for (const f of src.files) {
      if (f !== '-') continue;
      if (seg.heredocs.length && !opaque.length) texts.push(seg.heredocs.join('\n'));
      else opaque.push('stdin');
    }
    if (opaque.length) {
      if (ATTRIBUTION.test(command)) return DENY;
      return unknown(`сообщение коммита не прочитать (${opaque.join(', ')}): проверить нечего, доказать чистоту нельзя`);
    }
    for (const f of src.files) {
      if (f === '-') continue;
      if (call.cwd === null && !isAbsolute(f)) return unknown(`каталог для файла сообщения ${f} не определён (cd по неизвестной переменной)`);
      try { texts.push(readFileSync(resolve(call.cwd ?? '/', f), 'utf8')); }
      catch (e) { return unknown(`файл сообщения ${f} не прочитан: ${(e as Error).message.split('\n')[0]}`); }
    }
    if (ATTRIBUTION.test(texts.join('\n\n'))) return DENY;
  }
  return { kind: 'silent' };
}

const gate: Gate = { name: NAME, events: ['pre-bash'], killSwitch: 'CLAUDE_SKIP_COMMIT_GUARD', run: decide };
register(gate);
