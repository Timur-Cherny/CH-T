// Local runtime: an agent loop for a model served on this machine (mlx_lm.server or any OpenAI-compatible server) under
// the same gates as Claude Code. The model gets five tools — bash, read_file, write_file, edit_file, list_dir — and
// `finish`; every tool call is judged by the registry before it runs, every change goes through the tree sweep after it,
// and the run ends only when the Stop gates let it. The human watches every step in the chat page this server serves
// and, in «Агент» mode, answers the questions a gate asks (ask/unknown) with a button; nothing runs past a question unanswered.
//   node runtimes/local/agent.ts --repo <checkout> [--task <name>] [--port 8091] [--llm http://127.0.0.1:8080/v1]
//        [--model default_model] [--max-steps 40] [--context 24000] [--context-file <file>] [--attended] [--open]
// Modes per task, chosen in the chat: «Авто» (default) — the model decides itself whether to answer from its knowledge
// or act through the tools, and nobody is asked: a gate question (ask/unknown) is a deny, as in Claude's auto mode;
// «Агент» — the same, but a gate question goes to the human as a button. A proven violation is a deny in both.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { BASE_NA, runGates, verdictText } from '../core.ts';
import type { HarnessEvent, HookPayload, Verdict } from '../../harness/src/types.ts';

export const ADAPTER = 'local-agent';
export const LOCAL_EVENTS: readonly HarnessEvent[] = ['session-start', 'pre-bash', 'pre-write', 'post', 'stop'];
export const LOCAL_NA: Record<string, string> = {
  ...BASE_NA,
  'model-gate': 'у локального агента нет субагентов',
  friction: 'события субагентов не подписаны: субагентов нет',
};

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUT_CAP = 6000;
const STOP_ROUNDS = 3;
const ASK_TIMEOUT_MS = 10 * 60_000;

export interface AgentOptions {
  repo: string;
  task: string;
  model: string;
  llm: string;
  maxSteps: number;
  /** Prompt tokens the run may grow to before old tool output is compacted. */
  contextBudget: number;
  context: string;
  stateDir: string;
  attended: boolean;
  env: NodeJS.ProcessEnv;
}

export interface ChatMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string; name?: string }
export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface ModelReply { content: string | null; tool_calls: ToolCall[]; usage?: { prompt_tokens?: number; completion_tokens?: number } }
export type ChatFn = (messages: ChatMessage[], signal: AbortSignal) => Promise<ModelReply>;
export type AgentEvent = Record<string, unknown> & { type: string };
/** A question to the human about one call; the id the UI answers is made by the server, never by the model. */
export type AskFn = (callId: string, text: string) => Promise<boolean>;

export const TOOLS = [
  fn('bash', 'Выполнить команду bash в корне репозитория. Вывод обрезается до 6000 знаков.', { command: { type: 'string', description: 'команда' }, timeout_s: { type: 'integer', description: 'таймаут, по умолчанию 120, максимум 600' } }, ['command']),
  fn('read_file', 'Прочитать файл репозитория с номерами строк.', { path: { type: 'string' }, offset: { type: 'integer', description: 'первая строка, с 1' }, limit: { type: 'integer', description: 'сколько строк, по умолчанию 400' } }, ['path']),
  fn('write_file', 'Создать файл или переписать его целиком.', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
  fn('edit_file', 'Заменить точный фрагмент файла. old_string должен встречаться ровно один раз.', { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, ['path', 'old_string', 'new_string']),
  fn('list_dir', 'Список файлов каталога репозитория.', { path: { type: 'string', description: 'каталог, по умолчанию корень' } }, []),
  fn('finish', 'Задача решена и проверена: итог для человека.', { summary: { type: 'string', description: 'что сделано, чем проверено, что осталось' } }, ['summary']),
];

function fn(name: string, description: string, properties: Record<string, unknown>, required: string[]) {
  return { type: 'function' as const, function: { name, description, parameters: { type: 'object', properties, required } } };
}

export function systemPrompt(o: Pick<AgentOptions, 'repo' | 'task' | 'context'>): string {
  return [
    `Ты — агент-исполнитель в git-репозитории ${o.repo} (задача brain: ${o.task}). Задачу ставит человек в чате. Работаешь только через инструменты.`,
    'Правила:',
    '0. Сам решай, нужны ли действия. Вопрос, на который отвечаешь из своих знаний, — ответь сразу текстом, без инструментов. Задача, которая требует фактов репозитория или изменений, — через инструменты.',
    '1. Сначала осмотрись: list_dir, read_file, bash (git status, ls, grep). Не выдумывай содержимое файлов — читай их.',
    '2. Меняй файлы через edit_file (точная замена уникального фрагмента) или write_file (новый файл целиком).',
    '3. После правки проверь результат: запусти тест, сборку или сам скрипт через bash.',
    '4. Каждый вызов проверяет харнесс. «ОТКАЗ <гейт>: причина» — правило, а не сбой: измени подход, не обходи проверку.',
    '5. «[харнесс] …» после вызова — находки проверок изменённых файлов: исправь их до finish.',
    '6. Когда задача решена и проверена, вызови finish: что сделано, чем проверено, что осталось.',
    'Пиши по-русски, кратко.',
    o.context ? `\n${o.context}` : '',
  ].join('\n');
}

/** Tool calls a model wrote into its text instead of the tool channel: `<tool_call>{"name":…,"arguments":…}</tool_call>`. */
export function textToolCalls(content: string | null): ToolCall[] {
  if (!content) return [];
  const out: ToolCall[] = [];
  for (const m of content.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)) {
    try {
      const j = JSON.parse(m[1]!) as { name?: unknown; arguments?: unknown };
      if (typeof j.name !== 'string') continue;
      out.push({ id: `text-${out.length}-${randomUUID().slice(0, 8)}`, type: 'function', function: { name: j.name, arguments: typeof j.arguments === 'string' ? j.arguments : JSON.stringify(j.arguments ?? {}) } });
    } catch { continue; }
  }
  return out;
}

/** OpenAI-compatible chat call; thinking stays off — a small model spends the whole budget on it otherwise. */
export function openAiChat(llm: string, model: string): ChatFn {
  return async (messages, signal) => {
    const res = await fetch(`${llm.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, tools: TOOLS, tool_choice: 'auto', temperature: 0.2, max_tokens: 2048, stream: false, chat_template_kwargs: { enable_thinking: false } }),
    });
    if (!res.ok) throw new Error(`модель ответила ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const j = await res.json() as { choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[]; usage?: ModelReply['usage'] };
    const msg = j.choices?.[0]?.message ?? {};
    const calls = (msg.tool_calls ?? []).map((c, i) => ({ ...c, id: c.id || `call-${i}`, type: 'function' as const }));
    return { content: msg.content ?? null, tool_calls: calls.length ? calls : textToolCalls(msg.content ?? null), usage: j.usage };
  };
}

/** A path the model names, inside the checkout or null: the file tools never leave the repository. */
/** A path the model names, as its real path inside the checkout, or null. The parent is resolved through every link;
 *  the final component may not be a link (a dangling one would create its target outside, a live one would make the
 *  gates judge the link instead of the file). The gates and the write both get this real path. */
export function inside(repo: string, p: unknown): string | null {
  if (typeof p !== 'string' || !p) return typeof p === 'undefined' ? realpathSync(repo) : null;
  const abs = resolve(repo, p);
  let isLink = false;
  try { isLink = lstatSync(abs).isSymbolicLink(); } catch { isLink = false; }
  if (isLink) return null;
  let probe = dirname(abs);
  const tail: string[] = [basename(abs)];
  while (!existsSync(probe) && dirname(probe) !== probe) { tail.unshift(basename(probe)); probe = dirname(probe); }
  const real = join(existsSync(probe) ? realpathSync(probe) : probe, ...tail);
  const root = realpathSync(repo);
  const rel = relative(root, real);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)) ? real : null;
}

export function clip(text: string, cap = OUTPUT_CAP): string {
  if (text.length <= cap) return text;
  const head = Math.floor(cap / 3);
  return `${text.slice(0, head)}\n… [обрезано ${text.length - cap} знаков] …\n${text.slice(text.length - (cap - head))}`;
}

const ENV_ALLOW: ReadonlySet<string> = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'TMPDIR', 'TZ', 'NODE_PATH', 'JAVA_HOME', 'GOPATH']);

/** The environment a model's command runs in: an allowlist, not a denylist — no ssh agent, no DSN, no token of the
 *  launching shell reaches it. BRAIN_ENV_KEEP (envKeep of brain.config.json) names what the owner lets through. */
export function commandEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keep = new Set((env.BRAIN_ENV_KEEP ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (ENV_ALLOW.has(k) || k.startsWith('LC_') || keep.has(k)) out[k] = v;
  return { ...out, GIT_TERMINAL_PROMPT: '0', PAGER: 'cat', GIT_PAGER: 'cat' };
}

export function runBash(command: string, cwd: string, env: NodeJS.ProcessEnv, timeoutS: number, signal: AbortSignal): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise((done) => {
    const child = spawn('/bin/bash', ['-c', command], { cwd, env: commandEnv(env), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let output = '';
    let timedOut = false;
    const take = (b: Buffer) => { if (output.length < 200_000) output += b.toString('utf8'); };
    child.stdout.on('data', take); child.stderr.on('data', take);
    const kill = () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, Math.min(Math.max(timeoutS, 1), 600) * 1000);
    signal.addEventListener('abort', kill, { once: true });
    let code: number | null = null;
    child.on('error', (e) => { clearTimeout(timer); done({ code: 127, output: String(e.message), timedOut }); });
    child.on('exit', (c) => { code = c; kill(); });
    child.on('close', () => { clearTimeout(timer); signal.removeEventListener('abort', kill); done({ code, output, timedOut }); });
  });
}

function listDir(dir: string, repo: string): string {
  const rows: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === '.git') continue;
    let isDir = false;
    try { isDir = statSync(join(dir, name)).isDirectory(); } catch { isDir = false; }
    rows.push(isDir ? `${name}/` : name);
    if (rows.length >= 500) { rows.push('… (больше 500)'); break; }
  }
  return `${relative(repo, dir) || '.'}:\n${rows.join('\n')}`;
}

function readNumbered(file: string, offset: number, limit: number): string {
  const lines = readFileSync(file, 'utf8').split('\n');
  const from = Math.max(1, offset);
  const slice = lines.slice(from - 1, from - 1 + limit).map((l, i) => `${String(from + i).padStart(5)}  ${l}`);
  const rest = lines.length - (from - 1 + slice.length);
  return slice.join('\n') + (rest > 0 ? `\n… ещё ${rest} строк (offset=${from + slice.length})` : '');
}

interface Planned { event: HarnessEvent | null; tool: string; input: Record<string, unknown>; error?: string }

/** A model's call as the Claude tool the gates know: bash → Bash, write_file → Write, edit_file → Edit; reads are not gated. */
export function plan(name: string, args: Record<string, unknown>, repo: string): Planned {
  const path = (k: string): string | null => inside(repo, args[k]);
  if (name === 'bash') return typeof args.command === 'string' && args.command.trim() ? { event: 'pre-bash', tool: 'Bash', input: { command: args.command } } : { event: null, tool: 'Bash', input: {}, error: 'command пуст' };
  if (name === 'write_file') {
    const p = path('path');
    if (!p || typeof args.content !== 'string') return { event: null, tool: 'Write', input: {}, error: p ? 'content не строка' : 'путь вне репозитория или ссылка' };
    return { event: 'pre-write', tool: 'Write', input: { file_path: p, content: args.content } };
  }
  if (name === 'edit_file') {
    const p = path('path');
    if (!p || typeof args.old_string !== 'string' || typeof args.new_string !== 'string') return { event: null, tool: 'Edit', input: {}, error: p ? 'old_string и new_string обязательны' : 'путь вне репозитория или ссылка' };
    return { event: 'pre-write', tool: 'Edit', input: { file_path: p, old_string: args.old_string, new_string: args.new_string } };
  }
  if (name === 'read_file' || name === 'list_dir') {
    const p = name === 'list_dir' && args.path === undefined ? repo : path('path');
    return p ? { event: null, tool: name === 'read_file' ? 'Read' : 'LS', input: { file_path: p } } : { event: null, tool: name, input: {}, error: 'путь вне репозитория или ссылка' };
  }
  return { event: null, tool: name, input: {}, error: `нет инструмента ${name}` };
}

/** Writes without following a link that appeared after the check: O_NOFOLLOW fails instead of writing through it. */
function writeNoFollow(file: string, body: string): void {
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
  try { writeSync(fd, body); } finally { closeSync(fd); }
}

async function execute(name: string, p: Planned, args: Record<string, unknown>, o: AgentOptions, signal: AbortSignal): Promise<string> {
  const file = String(p.input.file_path ?? '');
  if (name === 'bash') {
    const timeout = typeof args.timeout_s === 'number' ? args.timeout_s : 120;
    const r = await runBash(String(p.input.command), o.repo, o.env, timeout, signal);
    return `${r.timedOut ? 'таймаут' : `exit ${r.code}`}\n${clip(r.output)}`;
  }
  if (name === 'read_file') return clip(readNumbered(file, Number(args.offset ?? 1) || 1, Number(args.limit ?? 400) || 400), 12000);
  if (name === 'list_dir') return clip(listDir(file, o.repo));
  if (inside(o.repo, file) !== file) return 'ошибка: путь изменился после проверки гейтами (появилась ссылка) — вызов не выполнен';
  if (name === 'write_file') { mkdirSync(dirname(file), { recursive: true }); writeNoFollow(file, String(p.input.content)); return `записан ${relative(o.repo, file)} (${String(p.input.content).length} знаков)`; }
  const text = readFileSync(file, 'utf8');
  const oldS = String(p.input.old_string);
  const count = oldS ? text.split(oldS).length - 1 : 0;
  if (count !== 1) return `ошибка: old_string встречается ${count} раз — нужен ровно один; прочитай файл и возьми больше контекста`;
  writeNoFollow(file, text.replace(oldS, () => String(p.input.new_string)));
  return `изменён ${relative(o.repo, file)}`;
}

const parseArgs = (raw: string): Record<string, unknown> | null => {
  try { const j = JSON.parse(raw || '{}') as unknown; return j && typeof j === 'object' && !Array.isArray(j) ? j as Record<string, unknown> : null; } catch { return null; }
};

/** Rough token count where the server gave none: a Cyrillic-heavy prompt runs about three characters per token. */
export function estimateTokens(messages: ChatMessage[]): number {
  return Math.ceil(messages.reduce((n, m) => n + (m.content?.length ?? 0) + JSON.stringify(m.tool_calls ?? '').length, 0) / 3);
}

const STUB = 400;

/** Keeps the run inside its budget. The history is append-only between compactions so the server's prompt cache is
 *  reused; a compaction first shortens tool output older than the last `keep` model turns, then drops whole old turns
 *  (an assistant call together with its tool answers) and leaves one note naming what was dropped. System prompt and the
 *  task are never touched. Returns the new list and what was done. */
export function compact(messages: ChatMessage[], taskIndex: number, budget: number, keep = 6): { messages: ChatMessage[]; mode: 'none' | 'elide' | 'drop' } {
  const turns: number[] = [];
  messages.forEach((m, i) => { if (i > taskIndex && m.role === 'assistant') turns.push(i); });
  const recentFrom = turns.length > keep ? turns[turns.length - keep]! : messages.length;
  const elided = messages.map((m, i) => {
    if (i <= taskIndex || i >= recentFrom || !m.content || m.content.length <= STUB) return m;
    if (m.role === 'tool') return { ...m, content: `${m.content.slice(0, STUB)}
… [сжато ради окна: было ${m.content.length} знаков; повтори вызов, если нужно]` };
    if (m.role === 'assistant') return { ...m, content: `${m.content.slice(0, STUB)} …` };
    return m;
  });
  if (estimateTokens(elided) <= budget) return { messages: elided, mode: 'elide' };
  const head = elided.slice(0, taskIndex + 1);
  const tail = elided.slice(recentFrom);
  const dropped = elided.slice(taskIndex + 1, recentFrom);
  const calls = dropped.flatMap((m) => (m.tool_calls ?? []).map((c) => `${c.function.name} ${c.function.arguments.slice(0, 80)}`));
  const note: ChatMessage = { role: 'user', content: `[окно] Ранние шаги (${calls.length} вызовов) удалены ради контекстного окна. Были: ${calls.slice(-20).join('; ')}. Если нужен их результат — повтори вызов.` };
  return { messages: [...head, note, ...tail], mode: 'drop' };
}

/** One task from the chat to the end: model step → gate → tool → sweep, until finish passes the Stop gates or a limit hits. */
export async function runAgent(o: AgentOptions, prompt: string, chat: ChatFn, emit: (e: AgentEvent) => void, ask: AskFn, signal: AbortSignal, history: ChatMessage[] = []): Promise<{ status: string; summary: string; messages: ChatMessage[] }> {
  const session = `local:${randomUUID()}`;
  const gate = (event: HarnessEvent, payload: Record<string, unknown>): Promise<Verdict> =>
    runGates(event, { session_id: session, cwd: o.repo, permission_mode: o.attended ? 'default' : 'dontAsk', ...payload } as unknown as HookPayload, o.env, { na: LOCAL_NA, stateDir: o.stateDir, adapter: ADAPTER, mode: o.attended ? 'attended' : 'strict' });
  let messages: ChatMessage[] = [{ role: 'system', content: systemPrompt(o) }, ...history, { role: 'user', content: prompt }];
  const taskIndex = messages.length - 1;
  const started = Date.now();
  const start = verdictText(await gate('session-start', { hook_event_name: 'SessionStart', source: 'startup' }));
  if (start) emit({ type: 'harness', text: start });
  let stopRounds = 0;
  for (let step = 1; step <= o.maxSteps; step++) {
    if (signal.aborted) return { status: 'stopped', summary: 'остановлено человеком', messages };
    emit({ type: 'step', n: step });
    if (estimateTokens(messages) > o.contextBudget * 0.85) {
      const before = estimateTokens(messages);
      const c = compact(messages, taskIndex, Math.floor(o.contextBudget * 0.6));
      messages = c.messages;
      emit({ type: 'context', mode: c.mode, before, after: estimateTokens(messages), budget: o.contextBudget });
    }
    const t0 = Date.now();
    let reply: ModelReply;
    try { reply = await chat(messages, signal); } catch (e) {
      if (signal.aborted) return { status: 'stopped', summary: 'остановлено человеком', messages };
      emit({ type: 'error', message: (e as Error).message });
      return { status: 'error', summary: (e as Error).message, messages };
    }
    const used = (reply.usage?.prompt_tokens ?? estimateTokens(messages)) + (reply.usage?.completion_tokens ?? 0);
    emit({ type: 'model', ms: Date.now() - t0, prompt_tokens: reply.usage?.prompt_tokens, completion_tokens: reply.usage?.completion_tokens, cached_tokens: (reply.usage as { prompt_tokens_details?: { cached_tokens?: number } } | undefined)?.prompt_tokens_details?.cached_tokens, context: used, budget: o.contextBudget });
    const thought = (reply.content ?? '').replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
    if (thought) emit({ type: 'assistant', text: thought });
    messages.push({ role: 'assistant', content: reply.content ?? '', ...(reply.tool_calls.length ? { tool_calls: reply.tool_calls } : {}) });
    const finish = reply.tool_calls.find((c) => c.function.name === 'finish');
    if (!reply.tool_calls.length || finish) {
      const summary = finish ? String(parseArgs(finish.function.arguments)?.summary ?? '') : thought;
      if (finish) messages.push({ role: 'tool', tool_call_id: finish.id, name: 'finish', content: 'принято' });
      const v = await gate('stop', { hook_event_name: 'Stop', stop_hook_active: stopRounds > 0 });
      const text = verdictText(v);
      if ((v.kind === 'block' || v.kind === 'deny') && stopRounds < STOP_ROUNDS) {
        stopRounds++;
        emit({ type: 'harness', text, blocking: true });
        messages.push({ role: 'user', content: `[харнесс] Перед завершением: ${text}\nИсправь и снова вызови finish.` });
        continue;
      }
      if (text) emit({ type: 'harness', text, blocking: v.kind === 'block' || v.kind === 'deny' });
      const status = v.kind === 'block' || v.kind === 'deny' ? 'blocked' : 'done';
      emit({ type: 'final', status, summary: summary || '(модель не дала итога)', steps: step, ms: Date.now() - started });
      return { status, summary, messages };
    }
    for (const call of reply.tool_calls) {
      if (signal.aborted) break;
      const name = call.function.name;
      const args = parseArgs(call.function.arguments);
      emit({ type: 'tool', id: call.id, name, args: args ?? call.function.arguments });
      const result = await toolStep(o, name, args, call, gate, emit, ask, signal);
      emit({ type: 'result', id: call.id, ok: !result.startsWith('ОТКАЗ') && !result.startsWith('ошибка'), output: clip(result, 4000) });
      messages.push({ role: 'tool', tool_call_id: call.id, name, content: result });
    }
  }
  emit({ type: 'final', status: 'limit', summary: `лимит шагов ${o.maxSteps} исчерпан`, steps: o.maxSteps, ms: Date.now() - started });
  return { status: 'limit', summary: `лимит шагов ${o.maxSteps}`, messages };
}

async function toolStep(o: AgentOptions, name: string, args: Record<string, unknown> | null, call: ToolCall, gate: (e: HarnessEvent, p: Record<string, unknown>) => Promise<Verdict>, emit: (e: AgentEvent) => void, ask: AskFn, signal: AbortSignal): Promise<string> {
  if (!args) return 'ошибка: аргументы не JSON-объект';
  const p = plan(name, args, o.repo);
  if (p.error) return `ошибка: ${p.error}`;
  let note = '';
  if (p.event) {
    const v = await gate(p.event, { hook_event_name: 'PreToolUse', tool_name: p.tool, tool_input: p.input, tool_use_id: call.id });
    emit({ type: 'gate', id: call.id, kind: v.kind, text: verdictText(v) });
    if (v.kind === 'deny') return `ОТКАЗ ${verdictText(v)}`;
    if (v.kind === 'ask' || v.kind === 'unknown' || v.kind === 'block') {
      const allowed = await ask(call.id, verdictText(v));
      emit({ type: 'answer', call: call.id, allowed });
      if (!allowed) return `ОТКАЗ человек не разрешил: ${verdictText(v)}`;
    }
    if (v.kind === 'context') note = `\n[харнесс] ${v.text}`;
  }
  let out: string;
  try { out = await execute(name, p, args, o, signal); } catch (e) { return `ошибка: ${(e as Error).message}`; }
  if (p.event) {
    const post = await gate('post', { hook_event_name: 'PostToolUse', tool_name: p.tool, tool_input: p.input, tool_use_id: call.id, tool_response: { stdout: '' } });
    const text = verdictText(post);
    if (text) { emit({ type: 'harness', id: call.id, text }); note += `\n[харнесс] ${text}`; }
  }
  return out + note;
}

interface Server { url: string; token: string; close: () => void }

/** The chat page and its API on 127.0.0.1 only. The page itself carries no secret: the token travels in the URL
 *  fragment the owner opens (never sent to the server, never in the page), and every API call carries it. */
export function serve(o: AgentOptions, port: number, chat: ChatFn, page = join(HERE, 'chat.html')): Promise<Server> {
  const token = randomBytes(24).toString('hex');
  const pending = new Map<string, (ok: boolean) => void>();
  const summaries: ChatMessage[] = [];
  let run: { id: string; abort: AbortController } | null = null;
  const hostOk = (req: IncomingMessage, p: number) => req.headers.host === `127.0.0.1:${p}` || req.headers.host === `localhost:${p}`;
  const json = (res: ServerResponse, code: number, body: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  const body = (req: IncomingMessage): Promise<Record<string, unknown>> => new Promise((ok, bad) => {
    let s = ''; req.on('data', (c: Buffer) => { s += c.toString('utf8'); if (s.length > 1_000_000) req.destroy(); });
    req.on('end', () => { try { ok(JSON.parse(s || '{}') as Record<string, unknown>); } catch (e) { bad(e); } }); req.on('error', bad);
  });
  const server = createServer(async (req, res) => {
    const p = (server.address() as { port: number }).port;
    if (!hostOk(req, p)) { res.writeHead(421); res.end(); return; }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${p}`);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/chat.html')) {
      const cfg = { repo: o.repo, task: o.task, model: o.model, attended: o.attended };
      const html = readFileSync(page, 'utf8').replace('/*__BRAIN__*/null', () => JSON.stringify(cfg).replace(/</g, '\\u003c'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" });
      res.end(html); return;
    }
    const origin = req.headers.origin;
    if (req.headers['x-brain-token'] !== token || (origin && origin !== `http://127.0.0.1:${p}` && origin !== `http://localhost:${p}`)) { json(res, 403, { error: 'нет токена страницы' }); return; }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      let llmOk = false;
      try { llmOk = (await fetch(`${o.llm.replace(/\/$/, '')}/models`, { signal: AbortSignal.timeout(3000) })).ok; } catch { llmOk = false; }
      json(res, 200, { repo: o.repo, task: o.task, model: o.model, llm: o.llm, llmOk, busy: run !== null }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/chat') {
      const b = await body(req).catch(() => null);
      if (!b) { json(res, 400, { error: 'тело не JSON' }); return; }
      const up = await fetch(`${o.llm.replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...b, model: o.model, chat_template_kwargs: { enable_thinking: false } }) }).catch((e: Error) => e);
      if (up instanceof Error || !up.body) { json(res, 502, { error: up instanceof Error ? up.message : 'нет ответа модели' }); return; }
      res.writeHead(up.status, { 'Content-Type': up.headers.get('content-type') ?? 'text/event-stream', 'Cache-Control': 'no-store' });
      for await (const chunk of up.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
      res.end(); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/answer') {
      const b = await body(req).catch(() => ({} as Record<string, unknown>));
      const f = pending.get(String(b.id)); if (f) { pending.delete(String(b.id)); f(b.allow === true); }
      json(res, f ? 200 : 404, { ok: Boolean(f) }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/stop') { run?.abort.abort(); for (const [, f] of pending) f(false); pending.clear(); json(res, 200, { ok: true }); return; }
    if (req.method === 'POST' && url.pathname === '/api/run') {
      if (run) { json(res, 409, { error: 'агент уже работает — дождись итога или останови' }); return; }
      const abort = new AbortController();
      run = { id: randomUUID(), abort };
      const b = await body(req).catch(() => null);
      const prompt = typeof b?.prompt === 'string' ? b.prompt.trim() : '';
      if (!prompt) { run = null; json(res, 400, { error: 'пустая задача' }); return; }
      const runOpts: AgentOptions = { ...o, attended: b?.mode === 'agent' ? true : b?.mode === 'auto' ? false : o.attended };
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      const emit = (e: AgentEvent) => { if (!res.writableEnded) res.write(`${JSON.stringify({ ...e, t: Date.now() })}\n`); };
      res.on('close', () => { if (!res.writableFinished) abort.abort(); });
      const askFn: AskFn = (callId, text) => new Promise((ok) => {
        const id = randomBytes(16).toString('hex');
        emit({ type: 'ask', id, call: callId, text });
        const timer = setTimeout(() => { pending.delete(id); ok(false); }, ASK_TIMEOUT_MS);
        pending.set(id, (v) => { clearTimeout(timer); ok(v); });
      });
      emit({ type: 'start', id: run.id, repo: o.repo, task: o.task, mode: runOpts.attended ? 'agent' : 'auto' });
      try {
        const r = await runAgent(runOpts, prompt, chat, emit, askFn, abort.signal, summaries.slice(-6));
        summaries.push({ role: 'user', content: `Предыдущая задача: ${prompt}` }, { role: 'assistant', content: `Итог (${r.status}): ${r.summary}` });
      } catch (e) { emit({ type: 'error', message: (e as Error).message }); }
      run = null; res.end(); return;
    }
    json(res, 404, { error: 'нет такого пути' });
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => {
    const p = (server.address() as { port: number }).port;
    ok({ url: `http://127.0.0.1:${p}/#token=${token}`, token, close: () => server.close() });
  }));
}

function arg(argv: string[], name: string, dflt?: string): string | undefined { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; }

export async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const repoArg = arg(argv, '--repo');
  if (!repoArg || !isAbsolute(repoArg) || !existsSync(join(repoArg, '.git'))) { process.stderr.write('agent: --repo <абсолютный путь к корню git-чекаута>\n'); return 64; }
  const stateDir = env.BRAIN_LOCAL_STATE_DIR ?? join(env.BRAIN_STATE_DIR ?? join(homedir(), '.local/state/ch-t'), 'local');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const ctxFile = arg(argv, '--context-file');
  const o: AgentOptions = {
    repo: realpathSync(repoArg), task: arg(argv, '--task', 'default')!, model: arg(argv, '--model', 'default_model')!,
    llm: arg(argv, '--llm', 'http://127.0.0.1:8080/v1')!, maxSteps: Number(arg(argv, '--max-steps', '40')) || 40,
    contextBudget: Number(arg(argv, '--context', '24000')) || 24000,
    context: ctxFile && existsSync(ctxFile) ? readFileSync(ctxFile, 'utf8') : '', stateDir, attended: argv.includes('--attended'), env,
  };
  const s = await serve(o, Number(arg(argv, '--port', '8091')) || 8091, openAiChat(o.llm, o.model));
  process.stdout.write(`агент: ${s.url}\nрепозиторий: ${o.repo} · задача: ${o.task} · модель: ${o.model} @ ${o.llm}\nссылка с токеном — только для этого окна; новая вкладка открывается этой же ссылкой\n`);
  if (argv.includes('--open')) {
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(opener, [s.url], { stdio: 'ignore', detached: true }).on('error', () => process.stdout.write(`открой вручную: ${s.url}\n`)).unref();
  }
  return await new Promise<number>(() => undefined);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), process.env).then((rc) => { process.exitCode = rc; }, (e: Error) => { process.stderr.write(`agent: ${e.message}\n`); process.exitCode = 1; });
}

