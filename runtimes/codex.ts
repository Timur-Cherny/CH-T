// Codex adapter: Codex hooks (SessionStart, PreToolUse, PostToolUse, Stop) into the shared registry.
// Codex 0.154 runs a tool whose PreToolUse answered ask, kills a hook on its timeout and never hands the hook the
// command's workdir — so pre events are strict (anything short of a pass is a deny) and git/glab must name their directory.
import { readFileSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { merge, render, type Emitted } from '../harness/src/emit.ts';
import { BASE_NA, PRE, ROOT, SANDBOX_SKIPS, mcpAllowed, refuse, runGates, strictMerge, unknownVerdict, denyVerdict } from './core.ts';
import { tokenize } from '../harness/src/parsers/shell.ts';
import { parseGit, segmentsWithCwd } from '../harness/src/gates/git-argv.ts';
import { tagMutates, withShellPaths } from '../harness/src/gates/owner-actions.ts';
import { loadConfig } from '../harness/src/config.ts';
import { messageSources } from '../harness/src/gates/commit-msg.ts';
import type { HarnessEvent, HookPayload, Verdict } from '../harness/src/types.ts';

const root = ROOT;
const unknown = (reason: string): Verdict => unknownVerdict('codex-adapter', reason);
const refusal = (reason: string): Verdict => denyVerdict('codex-adapter', reason);

// Events a Codex hook feeds into the registry; every other gate is N/A for the reason named here.
export const CODEX_EVENTS: readonly HarnessEvent[] = ['session-start', 'pre-bash', 'pre-write', 'post', 'stop'];
export const CODEX_NA: Record<string, string> = {
  ...BASE_NA,
  'model-gate': 'у Codex нет Agent/Task; spawn_agent отбивает таблица инструментов адаптера',
  telemetry: 'Stop Claude уже читает ~/.codex/sessions (harness/src/telemetry.ts)',
  friction: 'события субагентов не подписаны: spawn_agent отбит, multi_agent выключается профилем',
};

const SH = new Set(['sh', 'bash', 'zsh', 'dash']);
const PASSED = ['tool_name', 'tool_use_id', 'stop_hook_active', 'agent_id', 'agent_type', 'model', 'permission_mode'];

// Codex already normalizes exec_command into Bash/command; cmd is not an alias here.
export function payloadOf(raw: string): HookPayload {
  const p = JSON.parse(raw);
  if (!p || typeof p !== 'object' || Array.isArray(p)
    || typeof p.session_id !== 'string' || !p.session_id
    || typeof p.cwd !== 'string' || !isAbsolute(p.cwd)
    || typeof p.hook_event_name !== 'string') throw new Error('invalid hook envelope');
  const clean: Record<string, unknown> = {
    session_id: `codex:${p.session_id}`, cwd: p.cwd, hook_event_name: p.hook_event_name,
  };
  for (const k of PASSED) if (p[k] !== undefined) clean[k] = p[k];
  if (p.tool_input && typeof p.tool_input === 'object' && !Array.isArray(p.tool_input)) clean.tool_input = p.tool_input;
  // The transcript, prompt, model reply and tool output are never passed to the core.
  return clean as unknown as HookPayload;
}

interface PatchOp { kind: 'Add' | 'Update' | 'Delete'; path: string; moveTo: string | null; added: string[]; hunks: { old: string[]; new: string[] }[] }

export function parsePatch(text: string): PatchOp[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[0] !== '*** Begin Patch' || !lines.includes('*** End Patch')) throw new Error('unsupported patch envelope');
  const ops: PatchOp[] = [];
  let op: PatchOp | null = null;
  for (const line of lines.slice(1)) {
    const m = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (m) { op = { kind: m[1] as PatchOp['kind'], path: m[2], moveTo: null, added: [], hunks: [] }; ops.push(op); continue; }
    if (line === '*** End Patch') break;
    if (!op || line === '*** End of File') continue;
    if (line.startsWith('*** Move to: ')) { op.moveTo = line.slice(13); continue; }
    if (op.kind === 'Add') { if (line.startsWith('+')) op.added.push(line.slice(1)); continue; }
    if (line.startsWith('@@') || !op.hunks.length) op.hunks.push({ old: [], new: [] });
    if (line.startsWith('@@')) continue;
    const hunk = op.hunks[op.hunks.length - 1];
    if (line.startsWith('+')) { op.added.push(line.slice(1)); hunk.new.push(line.slice(1)); }
    else if (line.startsWith('-')) hunk.old.push(line.slice(1));
    else { const ctx = line.startsWith(' ') ? line.slice(1) : line; hunk.old.push(ctx); hunk.new.push(ctx); }
  }
  for (const o of ops) o.hunks = o.hunks.filter((h) => h.old.length || h.new.length);
  return ops;
}

export function patchCalls(p: HookPayload): HookPayload[] {
  if (!('tool_input' in p) || typeof p.tool_input.command !== 'string') throw new Error('patch command missing');
  return parsePatch(p.tool_input.command).filter((o) => o.kind !== 'Delete').map((o) => ({
    ...p, tool_name: o.kind === 'Add' ? 'Write' : 'Edit', tool_input: {
      file_path: resolve(p.cwd, o.moveTo ?? o.path), [o.kind === 'Add' ? 'content' : 'new_string']: o.added.join('\n'),
    },
  } as HookPayload));
}

const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const asBash = (p: HookPayload, command: string) => ({ event: 'pre-bash' as HarnessEvent, payload: { ...p, tool_name: 'Bash', tool_input: { command } } as HookPayload });
const asWrite = (p: HookPayload, tool: string, input: Record<string, string>) => ({ event: 'pre-write' as HarnessEvent, payload: { ...p, tool_name: tool, tool_input: input } as HookPayload });

// A delete and a move reach the gates as the rm and mv Claude would run; each hunk as the Edit Claude would send.
export function patchChecks(p: HookPayload): { event: HarnessEvent; payload: HookPayload }[] {
  if (!('tool_input' in p) || typeof p.tool_input.command !== 'string') throw new Error('patch command missing');
  return parsePatch(p.tool_input.command).flatMap((o) => {
    const path = resolve(p.cwd, o.path);
    if (o.kind === 'Delete') return [asBash(p, `rm -- ${quote(path)}`)];
    if (o.kind === 'Add') return [asWrite(p, 'Write', { file_path: path, content: o.added.join('\n') })];
    const move = o.moveTo ? [asBash(p, `mv -- ${quote(path)} ${quote(resolve(p.cwd, o.moveTo))}`)] : [];
    return [...move, ...o.hunks.map((h) => asWrite(p, 'Edit', { file_path: path, old_string: h.old.join('\n'), new_string: h.new.join('\n') }))];
  });
}

// Git verbs no gate judges by directory. Any other verb may be an alias, and owner-actions reads aliases from the repository.
const DIR_FREE_GIT: ReadonlySet<string> = new Set([
  'add', 'am', 'apply', 'archive', 'bisect', 'blame', 'branch', 'cat-file', 'check-ignore', 'checkout', 'cherry-pick', 'clean',
  'clone', 'commit', 'config', 'describe', 'diff', 'fetch', 'for-each-ref', 'format-patch', 'grep', 'help', 'init', 'log',
  'ls-files', 'ls-remote', 'ls-tree', 'merge', 'merge-base', 'mv', 'notes', 'pull', 'rebase', 'reflog', 'remote', 'reset',
  'restore', 'rev-list', 'rev-parse', 'revert', 'rm', 'shortlog', 'show', 'show-ref', 'stash', 'status', 'switch', 'version', 'worktree',
]);
const base = (w: string): string => w.split('/').pop() ?? w;
// commit-msg-guard reads a relative message file from the directory it judges.
const dirFree = (verb: string, args: string[]): boolean =>
  verb === 'tag' ? !tagMutates(args) : verb === 'commit' ? messageSources(args).files.every((f) => f === '-' || isAbsolute(f)) : DIR_FREE_GIT.has(verb);

/** The first git or glab call whose repository the hook cannot know: Codex 0.154 runs exec_command in the model's
 *  workdir but hands hooks only the session cwd (probe 24.09), so the command itself has to name an absolute directory. */
export function unboundCall(command: string, workdir: string | null, env: NodeJS.ProcessEnv): string | null {
  const parse = tokenize(command);
  if (parse.unknown.some((k) => k === 'nested-shell-depth' || k === 'parse-error') && /\b(git|glab)\b/.test(command)) return command;
  // The legacy parser marks no shell scopes, so a cd there may belong to a subshell: only git -C names the directory.
  const legacy = parse.segments.some((s) => !s.flow);
  for (const seg of segmentsWithCwd(parse, workdir, withShellPaths(env, command, loadConfig(env).shellPaths))) {
    let name = base(seg.name);
    let rest = seg.rest;
    if (name !== 'git' && name !== 'glab') {
      const k = seg.argv.findIndex((w, i) => i > 0 && (base(w) === 'git' || base(w) === 'glab'));
      if (k < 0) continue;
      name = base(seg.argv[k]); rest = seg.argv.slice(k + 1);
    }
    const cwd = legacy ? workdir : seg.cwd;
    if (name === 'glab') { if (cwd === null) return seg.raw; continue; }
    const call = parseGit(rest, cwd, seg.env);
    if (!call || call.cwd !== null || dirFree(call.verb, call.args)) continue;
    return seg.raw;
  }
  return null;
}

const HEREDOC = /^\s*(?:cd\s+('[^']*'|"[^"]*"|\S+)\s*&&\s*)?(?:apply_patch|applypatch)\s*<<-?\s*(['"]?)(\w+)\2[ \t]*\n([\s\S]*?)\n\3\s*$/;
// Codex takes both spellings as the patch command (APPLY_PATCH_COMMANDS); any other form of it writes past the write gates.
const PATCH_WORD = /(^|[\s;&|(`'"/])(apply_patch|applypatch)([\s;&|)`'"<]|$)/;

function patchPaths(p: HookPayload): string[] {
  try { return parsePatch((p as { tool_input: { command: string } }).tool_input.command).flatMap((o) => (o.moveTo ? [o.path, o.moveTo] : [o.path])); } catch { return ['']; }
}

/** A patch fed to apply_patch through the shell, resolved from workdir; null cwd when neither names an absolute directory. */
export function heredocPatch(p: HookPayload, command: string, workdir: string | null): { patch: HookPayload; cwd: string | null } | null {
  const m = HEREDOC.exec(command);
  if (!m) return null;
  const dir = m[1] ? m[1].replace(/^(['"])(.*)\1$/, '$2') : '.';
  const cwd = isAbsolute(dir) ? dir : workdir === null ? null : resolve(workdir, dir);
  return { patch: { ...p, cwd: cwd ?? p.cwd, tool_name: 'apply_patch', tool_input: { command: m[4] } } as HookPayload, cwd };
}

// Codex 0.154 runs the tool when PreToolUse answers ask, so on pre events anything short of a pass is a deny.
export const codexMerge = strictMerge;

const json = (body: Record<string, unknown>): Emitted => ({ rc: 0, stderr: '', stdout: JSON.stringify(body) });
const NO_HOOK_OUTPUT: ReadonlySet<HarnessEvent> = new Set(['stop', 'agent-stop', 'precompact']);
const NO_DECISION: ReadonlySet<HarnessEvent> = new Set(['session-start', 'precompact']);

// Codex 0.154 output schemas: Stop, SubagentStop and PreCompact take no hookSpecificOutput; SessionStart and PreCompact no decision.
export function renderCodex(v: Verdict, event: HarnessEvent): Emitted {
  if (PRE.has(event)) return render(refuse(v), event);
  if (v.kind === 'context' && NO_HOOK_OUTPUT.has(event)) return json({ systemMessage: `${v.gate}: ${v.text}` });
  if (v.kind === 'unknown' && NO_HOOK_OUTPUT.has(event)) return json({ systemMessage: `unknown(${v.gate}): ${v.reason}` });
  if (v.kind === 'block' && NO_DECISION.has(event)) return json({ systemMessage: `${v.gate}: ${v.reason}` });
  return render(v, event);
}

const gates = (event: HarnessEvent, payload: HookPayload, env: NodeJS.ProcessEnv): Promise<Verdict> =>
  runGates(event, payload, env, { na: CODEX_NA, stateDir: env.BRAIN_CODEX_STATE_DIR, adapter: 'codex-adapter', sandboxed: true });

async function patchVerdict(p: HookPayload, env: NodeJS.ProcessEnv): Promise<Verdict> {
  let checks: { event: HarnessEvent; payload: HookPayload }[];
  try { checks = patchChecks(p); } catch { return codexMerge([unknown('формат apply_patch не разобран')], 'pre-write', env); }
  const results: Verdict[] = [];
  for (const c of checks) {
    const v = await gates(c.event, c.payload, env);
    results.push(v);
    if (v.kind === 'deny') break;
  }
  return codexMerge(results, 'pre-write', env);
}

async function bashVerdict(p: HookPayload, env: NodeJS.ProcessEnv): Promise<Verdict> {
  const ti = ('tool_input' in p ? p.tool_input : {}) as Record<string, unknown>;
  if (typeof ti.command !== 'string') return refusal('Bash.command отсутствует');
  if (ti.shell !== undefined && !(typeof ti.shell === 'string' && SH.has(basename(ti.shell)))) {
    return refusal(`оболочка ${String(ti.shell)} вне sh-семейства: гейты разбирают синтаксис sh`);
  }
  if (ti.workdir !== undefined && ti.workdir !== null && typeof ti.workdir !== 'string') return refusal('workdir не строка');
  const workdir = typeof ti.workdir === 'string' && ti.workdir ? resolve(p.cwd, ti.workdir) : null;
  const unbound = unboundCall(ti.command, workdir, env);
  if (unbound !== null) return refusal(`«${unbound}»: Codex не передаёт хукам workdir, поэтому каталог git- и glab-команды должен стоять в ней явно — cd /абсолютный/путь && … или git -C /абсолютный/путь …`);
  const heredoc = heredocPatch(p, ti.command, workdir);
  if (!heredoc && PATCH_WORD.test(ti.command)) return refusal('apply_patch/applypatch через оболочку — только формой «apply_patch <<\'EOF\'» (можно с ведущим cd /абсолютный/путь &&): другие формы пишут файлы мимо гейтов записи');
  if (heredoc && heredoc.cwd === null && patchPaths(heredoc.patch).some((path) => !isAbsolute(path))) {
    return refusal('apply_patch через оболочку с относительными путями: Codex не передаёт хукам workdir — нужен явный cd /абсолютный/путь или абсолютные пути в патче');
  }
  const results = [await gates('pre-bash', { ...p, cwd: workdir ?? p.cwd } as HookPayload, env)];
  if (heredoc && results[0].kind !== 'deny') results.push(await patchVerdict(heredoc.patch, env));
  return codexMerge(results, 'pre-bash', env);
}


export async function handle(raw: string, env: NodeJS.ProcessEnv): Promise<{ event: HarnessEvent; verdict: Verdict }> {
  const p = payloadOf(raw);
  switch (p.hook_event_name) {
    case 'SessionStart': {
      const shared: Verdict = { kind: 'context', gate: 'shared-workflow', text:
        `Общий контур: ${root}. Прочитай ${root}/runtimes/WORKFLOW.md. `
        + 'Подключены общие shell/write проверки и сверка изменённого дерева. '
        + 'Это не подтверждение прохождения продуктовых тестов. Claude-телеметрия не подключена.' };
      return { event: 'session-start', verdict: merge([shared, await gates('session-start', p, env)], 'session-start', env) };
    }
    case 'PreToolUse': {
      const tool = 'tool_name' in p ? p.tool_name : undefined;
      if (tool === 'Bash') return { event: 'pre-bash', verdict: await bashVerdict(p, env) };
      if (tool === 'apply_patch') return { event: 'pre-write', verdict: await patchVerdict(p, env) };
      if (typeof tool === 'string' && mcpAllowed(tool, env)) return { event: 'pre-bash', verdict: { kind: 'silent' } };
      return { event: 'pre-bash', verdict: refusal(`инструмент ${String(tool)} адаптер Codex не пропускает`) };
    }
    case 'PostToolUse': {
      if ('tool_name' in p && p.tool_name === 'apply_patch') {
        const results: Verdict[] = [];
        // Drop the shared tool_use_id: a single patch may touch several repositories.
        const calls = patchCalls(p);
        for (const call of calls) {
          const { tool_use_id: _id, ...withoutClaim } = call as HookPayload & { tool_use_id?: string };
          results.push(await gates('post', withoutClaim as HookPayload, env));
        }
        if (!calls.length) results.push(await gates('post', p, env));
        return { event: 'post', verdict: merge(results, 'post', env) };
      }
      return { event: 'post', verdict: await gates('post', p, env) };
    }
    case 'Stop': return { event: 'stop', verdict: await gates('stop', p, env) };
    default: return { event: 'post', verdict: unknown('неподдержанное событие') };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    Object.assign(process.env, SANDBOX_SKIPS);
    const { event, verdict } = await handle(readFileSync(0, 'utf8'), process.env);
    const out = renderCodex(verdict, event);
    process.stdout.write(out.stdout || '{}');
    process.stderr.write(out.stderr);
    process.exitCode = out.rc;
  } catch {
    // Neither the payload nor the stack reaches the logs when the adapter fails.
    process.stderr.write('brain: hook input or execution failed; checks are unverified\n');
    process.exitCode = 2;
  }
}
