// The local agent runs a small model's tool calls on the owner's machine; a call the gates never saw, a file tool that
// leaves the checkout, a question answered by nobody, or a run that ends while Stop holds it would all pass silently.
// INVARIANT: every bash/write/edit call is judged by the registry before it runs; a deny reaches the model as a refusal,
// never as output; in «Авто» an unproven call is a deny, in «Агент» it waits for the human; file tools stay inside the
// repository; the page API answers only with the page token; compaction never splits a tool call from its answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { request } from 'node:http';
import { compact, inside, runAgent, serve, textToolCalls, LOCAL_EVENTS, LOCAL_NA, type AgentEvent, type AgentOptions, type ChatFn, type ChatMessage, type ModelReply } from './agent.ts';
import { unreachedGates } from '../core.ts';

const baseEnv: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env)
  .filter(([k]) => !k.startsWith('CLAUDE_SKIP_') && k !== 'CLAUDE_HARNESS_UNKNOWN' && k !== 'BRAIN_TASK'));
const site = join(mkdtempSync(join(tmpdir(), 'TEST-local-site-')), 'harness.config.json');
writeFileSync(site, JSON.stringify({ protectedBranches: ['main'] }));

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'TEST-local-repo-'));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
  return dir;
}
const opts = (dir: string, attended = false): AgentOptions => ({
  repo: dir, task: 'test', model: 'fake', llm: 'http://127.0.0.1:9/v1', maxSteps: 8, contextBudget: 24000, context: '',
  stateDir: mkdtempSync(join(tmpdir(), 'TEST-local-state-')), attended, env: { ...baseEnv, CLAUDE_HARNESS_CONFIG: site },
});
const call = (name: string, args: Record<string, unknown>, id = `c-${name}-${Math.random().toString(36).slice(2, 7)}`) => ({ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });
/** A model that plays a fixed script and records what it was shown. */
function scripted(replies: ModelReply[]): ChatFn & { seen: ChatMessage[][] } {
  const seen: ChatMessage[][] = [];
  const f = (async (messages: ChatMessage[]) => { seen.push(structuredClone(messages)); return replies.shift() ?? { content: 'готово', tool_calls: [] }; }) as ChatFn & { seen: ChatMessage[][] };
  f.seen = seen;
  return f;
}
const never = async () => { throw new Error('в «Авто» человека не спрашивают'); };

test('every registry gate is reached by a local event or named N/A with a reason', () => {
  assert.deepEqual(unreachedGates(LOCAL_EVENTS, LOCAL_NA), []);
});

test('Авто: a question the model knows is answered from knowledge, with no tool and no gate', async () => {
  const dir = repo(); const events: AgentEvent[] = [];
  const r = await runAgent(opts(dir), 'что такое резерв товара?', scripted([{ content: 'Резерв — товар, закреплённый за заказом.', tool_calls: [] }]), (e) => events.push(e), never, new AbortController().signal);
  assert.equal(r.status, 'done');
  assert.ok(!events.some((e) => e.type === 'tool'));
  assert.match(String(events.find((e) => e.type === 'final')?.summary), /Резерв/);
});

test('a written file goes through the write gates, lands in the repository and the run ends at finish', async () => {
  const dir = repo(); const events: AgentEvent[] = [];
  const model = scripted([
    { content: 'Создам файл.', tool_calls: [call('write_file', { path: 'notes/hello.txt', content: 'привет\n' })] },
    { content: null, tool_calls: [call('bash', { command: 'cat notes/hello.txt' })] },
    { content: null, tool_calls: [call('finish', { summary: 'файл создан, cat показал содержимое' })] },
  ]);
  const r = await runAgent(opts(dir), 'создай notes/hello.txt', model, (e) => events.push(e), never, new AbortController().signal);
  assert.equal(r.status, 'done');
  assert.equal(readFileSync(join(dir, 'notes/hello.txt'), 'utf8'), 'привет\n');
  assert.deepEqual(events.filter((e) => e.type === 'gate').map((e) => e.kind), ['silent', 'silent']);
  const shown = model.seen[2]!.filter((m) => m.role === 'tool').map((m) => m.content).join('\n');
  assert.match(shown, /exit 0\nпривет/);
});

test('a gate deny reaches the model as a refusal and the command never runs', async () => {
  const dir = repo(); writeFileSync(join(dir, 'a.txt'), 'x');
  const model = scripted([
    { content: null, tool_calls: [call('bash', { command: 'git add a.txt && git -c user.name=t -c user.email=t@e commit -m "feat: x\n\nGenerated with Claude"' })] },
    { content: null, tool_calls: [call('finish', { summary: 'не вышло' })] },
  ]);
  await runAgent(opts(dir), 'закоммить', model, () => undefined, never, new AbortController().signal);
  const answer = model.seen[1]!.find((m) => m.role === 'tool')?.content ?? '';
  assert.match(answer, /^ОТКАЗ commit-msg-guard/);
  assert.equal(execFileSync('git', ['-C', dir, 'rev-list', '--count', 'HEAD']).toString().trim(), '1', 'Miss this and the gate is decoration');
});

test('an unproven call: «Авто» denies it without asking, «Агент» asks the human and obeys the answer', async () => {
  const cmd = 'pg_dump -h "$DB_HOST" app > d.sql';
  const dir = repo();
  const auto = scripted([{ content: null, tool_calls: [call('bash', { command: cmd })] }, { content: null, tool_calls: [call('finish', { summary: 'стоп' })] }]);
  await runAgent(opts(dir), 'сними дамп', auto, () => undefined, never, new AbortController().signal);
  assert.match(auto.seen[1]!.find((m) => m.role === 'tool')?.content ?? '', /^ОТКАЗ /);
  const asked: string[] = [];
  const agent = scripted([{ content: null, tool_calls: [call('bash', { command: cmd })] }, { content: null, tool_calls: [call('finish', { summary: 'стоп' })] }]);
  await runAgent(opts(dir, true), 'сними дамп', agent, () => undefined, async (_id, text) => { asked.push(text); return false; }, new AbortController().signal);
  assert.equal(asked.length, 1);
  assert.match(agent.seen[1]!.find((m) => m.role === 'tool')?.content ?? '', /^ОТКАЗ человек не разрешил/);
  assert.equal(existsSync(join(dir, 'd.sql')), false);
});

test('file tools never leave the repository, through .. or through a symlink', async () => {
  const dir = repo();
  assert.equal(inside(dir, '../outside.txt'), null);
  assert.equal(inside(dir, '/etc/passwd'), null);
  execFileSync('ln', ['-s', '/tmp', join(dir, 'link')]);
  assert.equal(inside(dir, 'link/x.txt'), null);
  assert.equal(inside(dir, 'src/new.ts'), join(dir, 'src/new.ts'));
  const outside = mkdtempSync(join(tmpdir(), 'TEST-local-outside-'));
  execFileSync('ln', ['-s', join(outside, 'authorized_keys'), join(dir, 'notes.md')]);
  assert.equal(inside(dir, 'notes.md'), null, 'a dangling link would create its target outside the repository');
  execFileSync('mkdir', ['-p', join(dir, 'harness/owner')]);
  writeFileSync(join(dir, 'harness/owner/pre-push-exceptions.json'), '{}');
  execFileSync('ln', ['-s', 'harness/owner/pre-push-exceptions.json', join(dir, 'exceptions.json')]);
  assert.equal(inside(dir, 'exceptions.json'), null, 'the gates would judge the link name, not the owner file behind it');
  const viaLinkDir = scripted([{ content: null, tool_calls: [call('write_file', { path: 'notes.md', content: 'ssh-ed25519 AAAA' })] }, { content: null, tool_calls: [call('finish', { summary: '-' })] }]);
  await runAgent(opts(dir), 'x', viaLinkDir, () => undefined, never, new AbortController().signal);
  assert.equal(existsSync(join(outside, 'authorized_keys')), false);
  const model = scripted([{ content: null, tool_calls: [call('write_file', { path: '../escape.txt', content: 'x' })] }, { content: null, tool_calls: [call('finish', { summary: '-' })] }]);
  await runAgent(opts(dir), 'x', model, () => undefined, never, new AbortController().signal);
  assert.match(model.seen[1]!.find((m) => m.role === 'tool')?.content ?? '', /вне репозитория/);
});

test('edit_file replaces exactly one occurrence and refuses an ambiguous fragment', async () => {
  const dir = repo(); writeFileSync(join(dir, 'f.txt'), 'a\nb\na\n');
  const model = scripted([
    { content: null, tool_calls: [call('edit_file', { path: 'f.txt', old_string: 'a', new_string: 'z' })] },
    { content: null, tool_calls: [call('edit_file', { path: 'f.txt', old_string: 'b\n', new_string: 'B\n' })] },
    { content: null, tool_calls: [call('finish', { summary: '-' })] },
  ]);
  await runAgent(opts(dir), 'x', model, () => undefined, never, new AbortController().signal);
  assert.match(model.seen[1]!.at(-1)?.content ?? '', /встречается 2 раз/);
  assert.equal(readFileSync(join(dir, 'f.txt'), 'utf8'), 'a\nB\na\n');
});

test('tool calls written into the text are still calls; garbage between tags is ignored', () => {
  const calls = textToolCalls('Смотрю.\n<tool_call>{"name": "list_dir", "arguments": {"path": "."}}</tool_call><tool_call>не json</tool_call>');
  assert.equal(calls.length, 1); assert.equal(calls[0]!.function.name, 'list_dir');
});

test('compaction shortens old output first, then drops whole old turns, never the task or a call without its answer', () => {
  const msgs: ChatMessage[] = [{ role: 'system', content: 's' }, { role: 'user', content: 'задача' }];
  for (let i = 0; i < 10; i++) {
    msgs.push({ role: 'assistant', content: `ход ${i}`, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] });
    msgs.push({ role: 'tool', tool_call_id: `c${i}`, name: 'bash', content: 'x'.repeat(3000) });
  }
  const elided = compact(msgs, 1, 100_000);
  assert.equal(elided.mode, 'elide');
  assert.ok(elided.messages[3]!.content!.length < 600); assert.equal(elided.messages.at(-1)!.content!.length, 3000);
  const dropped = compact(msgs, 1, 2000);
  assert.equal(dropped.mode, 'drop');
  assert.equal(dropped.messages[1]!.content, 'задача');
  const ids = new Set(dropped.messages.flatMap((m) => (m.tool_calls ?? []).map((c) => c.id)));
  for (const m of dropped.messages) if (m.role === 'tool') assert.ok(ids.has(m.tool_call_id!), 'ответ инструмента без своего вызова');
});

function http(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; text: string }> {
  return new Promise((ok, bad) => {
    const r = request({ host: '127.0.0.1', port, method, path, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) } }, (res) => {
      let t = ''; res.on('data', (c: Buffer) => { t += c.toString('utf8'); }); res.on('end', () => ok({ status: res.statusCode ?? 0, text: t }));
    });
    r.on('error', bad); if (body) r.write(body); r.end();
  });
}

test('the page API answers only with the page token and a local Host; a run streams events to the final one', async () => {
  const dir = repo();
  const s = await serve(opts(dir), 0, scripted([{ content: 'знаю ответ', tool_calls: [] }]));
  const port = Number(new URL(s.url).port);
  try {
    const page = await http(port, 'GET', '/');
    assert.equal(page.status, 200);
    assert.ok(!page.text.includes(s.token), 'Miss this and any local process (the model\'s own commands too) reads the token off the page');
    assert.match(page.text, /frame-ancestors|BRAIN/);
    const token = new URLSearchParams(new URL(s.url).hash.slice(1)).get('token');
    assert.equal(token, s.token);
    assert.equal((await http(port, 'POST', '/api/run', {}, '{"prompt":"x"}')).status, 403);
    assert.equal((await http(port, 'POST', '/api/run', { 'X-Brain-Token': token!, Origin: 'https://evil.example' }, '{"prompt":"x"}')).status, 403);
    assert.equal((await http(port, 'GET', '/', { Host: 'evil.example' })).status, 421);
    const run = await http(port, 'POST', '/api/run', { 'X-Brain-Token': token! }, '{"prompt":"вопрос","mode":"auto"}');
    const events = run.text.trim().split('\n').map((l) => JSON.parse(l) as AgentEvent);
    assert.equal(events[0]!.type, 'start'); assert.equal(events.at(-1)!.type, 'final'); assert.equal(events.at(-1)!.status, 'done');
  } finally { s.close(); }
});

test('a gate question is answered only by the id the server made — the model cannot answer its own call', async () => {
  const dir = repo();
  const s = await serve(opts(dir, true), 0, scripted([{ content: null, tool_calls: [call('bash', { command: 'pg_dump -h "$DB_HOST" app > d.sql' }, 'evil-1')] }, { content: null, tool_calls: [call('finish', { summary: '-' })] }]));
  const port = Number(new URL(s.url).port);
  const h = { 'Content-Type': 'application/json', 'X-Brain-Token': s.token };
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/run`, { method: 'POST', headers: h, body: JSON.stringify({ prompt: 'x', mode: 'agent' }) });
    const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = ''; const events: AgentEvent[] = [];
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop()!;
      for (const l of lines.filter(Boolean)) {
        const e = JSON.parse(l) as AgentEvent; events.push(e);
        if (e.type === 'ask') {
          assert.equal(e.call, 'evil-1'); assert.notEqual(e.id, 'evil-1');
          const forged = await fetch(`http://127.0.0.1:${port}/api/answer`, { method: 'POST', headers: h, body: JSON.stringify({ id: 'evil-1', allow: true }) });
          assert.equal(forged.status, 404, 'Miss this and a background loop of the model approves its own dump');
          assert.equal((await fetch(`http://127.0.0.1:${port}/api/answer`, { method: 'POST', headers: h, body: JSON.stringify({ id: e.id, allow: false }) })).status, 200);
        }
      }
    }
    assert.ok(events.some((e) => e.type === 'answer' && e.allowed === false));
    assert.equal(existsSync(join(dir, 'd.sql')), false);
  } finally { s.close(); }
});

test('a command leaves nothing running behind and gets no credentials of the launching shell', async () => {
  const dir = repo();
  const { runBash } = await import('./agent.ts');
  const r = await runBash('(sleep 1; touch late.txt) & echo $GITHUB_TOKEN-$SSH_AUTH_SOCK-$DATABASE_URL-$HOME', dir, { PATH: process.env.PATH, HOME: '/h', GITHUB_TOKEN: 't', SSH_AUTH_SOCK: '/s', DATABASE_URL: 'postgres://u:p@h/d' }, 10, new AbortController().signal);
  assert.match(r.output, /^---\/h/);
  await new Promise((ok) => setTimeout(ok, 1800));
  assert.equal(existsSync(join(dir, 'late.txt')), false, 'Miss this and a background loop started by one command outlives it');
});

test.after(() => { rmSync(site, { force: true }); });
