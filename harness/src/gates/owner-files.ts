// owner-files — harness/owner/ holds the owner's decisions (the pre-push exception list first): only the owner changes them.
// pre-write: Write/Edit/NotebookEdit into harness/owner/ of any checkout or worktree is denied. pre-bash: a command that
// names the owner path passes only when every stage naming it is a read (cat, grep, jq, git log/diff/add …) and no stage
// writes there; everything else — sed -i, cp, rm, git checkout, python -c, a program handed the path — is denied.
// Boundary (declared, not a gap): a path assembled at runtime ($VAR, $(…)) is not seen; the auto-mode classifier and
// review of the owner's commits hold that side.
import { resolve } from 'node:path';
import { register } from './registry.ts';
import { buildModel } from '../parsers/stages.ts';
import type { Stage } from '../parsers/stages.ts';
import type { GateContext, PreToolUsePayload, Verdict } from '../types.ts';

export const NAME = 'owner-files';
export const KILL = 'CLAUDE_SKIP_OWNER_FILES';
const SILENT: Verdict = { kind: 'silent' };
const OWNER_DIR = /\/harness\/owner(\/|$)/;
const MENTION = /harness\/owner(\/|\b)|pre-push-exceptions\.json/;
const READERS: ReadonlySet<string> = new Set([
  'cat', 'bat', 'less', 'more', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'jq', 'wc', 'ls', 'stat', 'file', 'diff',
  'sha256sum', 'md5', 'readlink', 'realpath', 'test', '[', '[[', 'echo', 'printf',
]);
const GIT_READS: ReadonlySet<string> = new Set(['log', 'show', 'diff', 'blame', 'status', 'add', 'ls-files', 'cat-file', 'rev-parse', 'grep']);
const GIT_VALUE_OPTS: ReadonlySet<string> = new Set(['-C', '-c', '--git-dir', '--work-tree']);

const deny = (why: string): Verdict => ({
  kind: 'deny', gate: NAME,
  reason: `${NAME}: ${why}. Файлы harness/owner/ меняет только владелец — предложи правку текстом, внесёт он.`,
});

const ownerPath = (p: string, cwd: string): boolean => OWNER_DIR.test(resolve(cwd, p));
const names = (tok: string, cwd: string): boolean => MENTION.test(tok) || ownerPath(tok, cwd);

function gitVerb(rest: string[]): string | null {
  for (let i = 0; i < rest.length; i++) {
    if (GIT_VALUE_OPTS.has(rest[i])) { i++; continue; }
    if (!rest[i].startsWith('-')) return rest[i];
  }
  return null;
}

function reads(st: Stage<null>): boolean {
  if (st.name === 'git') { const v = gitVerb(st.rest); return v !== null && GIT_READS.has(v); }
  if (st.name === 'sed') return !st.rest.some((t) => /^-[a-zA-Z]*[iI]/.test(t) || t.startsWith('--in-place'));
  return READERS.has(st.name);
}

function judgeBash(command: string, cwd: string): Verdict {
  if (!MENTION.test(command)) return SILENT;
  let stages: Stage<null>[];
  try { stages = buildModel<null>(command, () => null).pipelines.flat(); } catch {
    return deny('команда называет harness/owner/, но не разобрана — что она делает с файлом, не доказать');
  }
  for (const st of stages) {
    const hit = st.writes.find((w) => ownerPath(w, cwd) || MENTION.test(w));
    if (hit) return deny(`команда пишет в ${hit}`);
    if (st.argv.some((t) => names(t, cwd)) && !reads(st)) return deny(`«${st.name}» получает путь harness/owner/ и это не чтение`);
  }
  return SILENT;
}

export function decide(ctx: GateContext): Verdict {
  const p = ctx.payload as PreToolUsePayload;
  if (p.hook_event_name !== 'PreToolUse') return SILENT;
  const input = (p.tool_input ?? {}) as Record<string, unknown>;
  if (ctx.event === 'pre-bash' && p.tool_name === 'Bash') {
    return typeof input.command === 'string' ? judgeBash(input.command, p.cwd ?? '/') : SILENT;
  }
  if (ctx.event !== 'pre-write') return SILENT;
  const target = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : null;
  if (target !== null && ownerPath(target, p.cwd ?? '/')) return deny(`${p.tool_name} в ${target}`);
  return SILENT;
}

register({ name: NAME, events: ['pre-write', 'pre-bash'], killSwitch: KILL, run: decide });
