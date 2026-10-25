// Antigravity adapter (agy CLI, the App and the IDE read the same ~/.gemini/config/hooks.json): its hook events into the
// shared registry. Reference: antigravity.google/docs/hooks, checked 25.10.2026.
// The stdin carries no event name, so `brain hook agy <Event>` names it. PreToolUse answers {decision}; exit code and
// failure behaviour are not documented, so the adapter always exits 0 and a failure on a pre event is an explicit deny.
// PostToolUse has no channel to the model: findings wait in the runtime state and reach the model as a system message
// on the next PreInvocation; Stop keeps the agent running with decision "continue" while a finding blocks it.
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BASE_NA, ROOT, SANDBOX_SKIPS, mcpAllowed, runGates, denyVerdict, verdictText } from './core.ts';
import type { HarnessEvent, HookPayload, Verdict } from '../harness/src/types.ts';

export const ADAPTER = 'agy-adapter';
export const AGY_EVENTS: readonly HarnessEvent[] = ['session-start', 'pre-bash', 'pre-write', 'post', 'stop'];
export const AGY_NA: Record<string, string> = {
  ...BASE_NA,
  'model-gate': 'у Antigravity нет Agent/Task; invoke_subagent и define_subagent отбивает таблица инструментов адаптера',
  friction: 'события субагентов не подписаны: субагенты Antigravity отбиты',
};

/** Tools that read or talk and never change the tree: the Claude harness does not gate their twins either. */
const PASS: ReadonlySet<string> = new Set([
  'view_file', 'view_file_outline', 'view_code_item', 'list_dir', 'find_by_name', 'grep_search', 'codebase_search',
  'search_web', 'read_url_content', 'ask_question', 'list_permissions',
]);
/** manage_task reads and stops background tasks, and with send_input types into a live terminal past every gate. */
const TASK_READS: ReadonlySet<string> = new Set(['list', 'status', 'read', 'get', 'view']);

export interface AgyCall { event: HarnessEvent; payload: HookPayload }
export type AgyOutput = Record<string, unknown>;

interface Envelope { conversationId: string; cwd: string; raw: Record<string, unknown> }

/** The common fields every Antigravity event carries; transcript, artifacts and the model name never reach the core. */
export function envelope(raw: string): Envelope {
  const p = JSON.parse(raw) as Record<string, unknown>;
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('invalid hook envelope');
  const id = p.conversationId;
  const ws = p.workspacePaths;
  if (typeof id !== 'string' || !id) throw new Error('conversationId missing');
  const cwd = Array.isArray(ws) && typeof ws[0] === 'string' && isAbsolute(ws[0]) ? ws[0] : null;
  if (!cwd) throw new Error('workspacePaths[0] is not an absolute path');
  return { conversationId: id, cwd, raw: p };
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** One Antigravity tool call as the Claude-shaped calls the gates know; null — a tool the adapter does not let through. */
export function claudeCalls(env: Envelope, tool: unknown, hookEvent: 'PreToolUse' | 'PostToolUse', procEnv: NodeJS.ProcessEnv): { tool: string; calls: AgyCall[] } | { tool: string; refusal: string } | { tool: string; pass: true } {
  const t = (tool ?? {}) as { name?: unknown; args?: unknown };
  const name = str(t.name) ?? '';
  const args = (t.args && typeof t.args === 'object' && !Array.isArray(t.args) ? t.args : {}) as Record<string, unknown>;
  const base = { session_id: `agy:${env.conversationId}`, cwd: env.cwd, hook_event_name: hookEvent };
  const pre = hookEvent === 'PreToolUse';
  const file = (v: unknown): string | null => { const s = str(v); return s ? resolve(env.cwd, s) : null; };
  if (PASS.has(name)) return { tool: name, pass: true };
  if (name === 'manage_task') {
    const action = str(args.Action) ?? str(args.action) ?? '';
    return TASK_READS.has(action.toLowerCase()) ? { tool: name, pass: true } : { tool: name, refusal: `manage_task ${action || '?'}: ввод в живой терминал и управление задачами идут мимо гейтов — только просмотр (${[...TASK_READS].join(', ')})` };
  }
  if (name === 'run_command') {
    const command = str(args.CommandLine);
    if (command === null) return { tool: name, refusal: 'run_command.CommandLine отсутствует' };
    if (args.RunPersistent === true || (args.RequestedTerminalID !== undefined && args.RequestedTerminalID !== null && args.RequestedTerminalID !== '')) {
      return { tool: name, refusal: 'постоянный терминал: состояние оболочки (alias, переменные, cd) переходит между вызовами, а гейты судят каждую команду отдельно — запускай без RunPersistent и RequestedTerminalID' };
    }
    const cwd = str(args.Cwd);
    if (cwd !== null && cwd !== '' && !isAbsolute(cwd)) return { tool: name, refusal: `run_command.Cwd «${cwd}» не абсолютный: гейты судят команду по каталогу` };
    const payload = { ...base, cwd: cwd || env.cwd, tool_name: 'Bash', tool_input: { command } } as unknown as HookPayload;
    return { tool: name, calls: [{ event: pre ? 'pre-bash' : 'post', payload }] };
  }
  if (name === 'write_to_file') {
    const path = file(args.TargetFile);
    const content = str(args.CodeContent);
    if (!path || content === null) return { tool: name, refusal: 'write_to_file: TargetFile и CodeContent обязательны' };
    return { tool: name, calls: [{ event: pre ? 'pre-write' : 'post', payload: { ...base, tool_name: 'Write', tool_input: { file_path: path, content } } as unknown as HookPayload }] };
  }
  if (name === 'replace_file_content' || name === 'multi_replace_file_content') {
    const path = file(args.TargetFile);
    const chunks = name === 'replace_file_content' ? [args] : args.ReplacementChunks;
    if (!path || !Array.isArray(chunks) || !chunks.length) return { tool: name, refusal: `${name}: TargetFile и правки обязательны` };
    const edits: AgyCall[] = [];
    for (const c of chunks as Record<string, unknown>[]) {
      const oldS = str(c?.TargetContent); const newS = str(c?.ReplacementContent);
      if (oldS === null || newS === null) return { tool: name, refusal: `${name}: у правки нет TargetContent/ReplacementContent` };
      edits.push({ event: pre ? 'pre-write' : 'post', payload: { ...base, tool_name: 'Edit', tool_input: { file_path: path, old_string: oldS, new_string: newS } } as unknown as HookPayload });
    }
    return { tool: name, calls: pre ? edits : edits.slice(0, 1) };
  }
  if (name === 'call_mcp_tool') {
    const server = str(args.ServerName) ?? str(args.serverName);
    const mcpTool = str(args.ToolName) ?? str(args.toolName);
    if (server && mcpTool && mcpAllowed(`mcp__${server}__${mcpTool}`, procEnv)) return { tool: name, pass: true };
    return { tool: name, refusal: `MCP ${server ?? '?'}/${mcpTool ?? '?'} не в BRAIN_MCP_ALLOWED` };
  }
  return { tool: name, refusal: `инструмент ${name || '?'} адаптер Antigravity не пропускает` };
}

const stateDir = (env: NodeJS.ProcessEnv): string | undefined => env.BRAIN_AGY_STATE_DIR;
const notesFile = (dir: string, conversation: string): string => join(dir, 'notes', `${createHash('sha256').update(conversation).digest('hex').slice(0, 32)}.json`);

/** Findings the model has not seen yet: PostToolUse cannot show them, the next PreInvocation does. */
export function addNote(env: NodeJS.ProcessEnv, conversation: string, text: string): void {
  const dir = stateDir(env);
  if (!dir || !isAbsolute(dir) || !text) return;
  const f = notesFile(dir, conversation);
  mkdirSync(join(dir, 'notes'), { recursive: true, mode: 0o700 });
  const notes = takeNotes(env, conversation, false);
  notes.push(text);
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(notes), { mode: 0o600 });
  renameSync(tmp, f);
}

export function takeNotes(env: NodeJS.ProcessEnv, conversation: string, clear = true): string[] {
  const dir = stateDir(env);
  if (!dir || !isAbsolute(dir)) return [];
  const f = notesFile(dir, conversation);
  if (!existsSync(f)) return [];
  let notes: string[] = [];
  try { notes = (JSON.parse(readFileSync(f, 'utf8')) as unknown[]).filter((x): x is string => typeof x === 'string'); } catch { notes = []; }
  if (clear) writeFileSync(f, '[]', { mode: 0o600 });
  return notes;
}

const gates = (event: HarnessEvent, payload: HookPayload, env: NodeJS.ProcessEnv): Promise<Verdict> =>
  runGates(event, payload, env, { na: AGY_NA, stateDir: stateDir(env), adapter: ADAPTER, sandboxed: true });

function sessionContext(env: NodeJS.ProcessEnv): string {
  const file = env.BRAIN_CONTEXT_FILE;
  let text = `Общий контур: ${ROOT}. Прочитай ${ROOT}/runtimes/WORKFLOW.md. Подключены общие shell/write проверки и сверка изменённого дерева; это не подтверждение продуктовых тестов.`;
  if (file && isAbsolute(file) && existsSync(file)) { try { text += `\n${readFileSync(file, 'utf8')}`; } catch { text += '\nКонтекст задачи brain не прочитан.'; } }
  return text;
}

/** One hook call: the event named by brain, the stdin of Antigravity. Never throws for a pre event: a failure is a deny. */
export async function handle(event: string, raw: string, env: NodeJS.ProcessEnv): Promise<AgyOutput> {
  if (event === 'PreToolUse') {
    let e: Envelope;
    try { e = envelope(raw); } catch (err) { return deny(denyVerdict(ADAPTER, `вход хука не разобран: ${(err as Error).message}`)); }
    const mapped = claudeCalls(e, e.raw.toolCall, 'PreToolUse', env);
    if ('pass' in mapped) return { decision: 'allow' };
    if ('refusal' in mapped) return deny(denyVerdict(ADAPTER, mapped.refusal));
    for (const c of mapped.calls) {
      const v = await gates(c.event, c.payload, env);
      if (v.kind === 'deny') return deny(v);
      if (v.kind === 'context') addNote(env, e.conversationId, verdictText(v));
    }
    return { decision: 'allow' };
  }
  const e = envelope(raw);
  if (event === 'SessionStart') {
    const payload = { session_id: `agy:${e.conversationId}`, cwd: e.cwd, hook_event_name: 'SessionStart', source: 'startup' } as unknown as HookPayload;
    const extra = verdictText(await gates('session-start', payload, env));
    return { injectSteps: [{ systemMessage: extra ? `${sessionContext(env)}\n${extra}` : sessionContext(env) }] };
  }
  if (event === 'PostToolUse') {
    const mapped = claudeCalls(e, e.raw.toolCall, 'PostToolUse', env);
    if (!('calls' in mapped)) return {};
    for (const c of mapped.calls) {
      const v = await gates('post', c.payload, env);
      const text = verdictText(v);
      if (text) addNote(env, e.conversationId, text);
    }
    return {};
  }
  if (event === 'PreInvocation') {
    const notes = takeNotes(env, e.conversationId);
    return notes.length ? { injectSteps: [{ systemMessage: `Харнесс:\n${notes.join('\n')}` }] } : {};
  }
  if (event === 'Stop') {
    const executions = typeof e.raw.executionNum === 'number' ? e.raw.executionNum : 0;
    const payload = { session_id: `agy:${e.conversationId}`, cwd: e.cwd, hook_event_name: 'Stop', stop_hook_active: executions > 0 } as unknown as HookPayload;
    const v = await gates('stop', payload, env);
    const pending = takeNotes(env, e.conversationId);
    if (v.kind === 'block' || v.kind === 'deny') return { decision: 'continue', reason: [verdictText(v), ...pending].join('\n') };
    return { decision: 'stop' };
  }
  return {};
}

const deny = (v: Verdict): AgyOutput => ({ decision: 'deny', reason: verdictText(v) || `${ADAPTER}: отказ` });

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const event = process.argv[2] ?? '';
  let out: AgyOutput;
  try {
    Object.assign(process.env, SANDBOX_SKIPS);
    out = await handle(event, readFileSync(0, 'utf8'), process.env);
  } catch {
    process.stderr.write('brain: agy hook input or execution failed; checks are unverified\n');
    out = event === 'PreToolUse' ? deny(denyVerdict(ADAPTER, 'адаптер не выполнил проверки')) : event === 'Stop' ? { decision: 'stop' } : {};
  }
  process.stdout.write(JSON.stringify(out));
  process.exitCode = 0;
}
