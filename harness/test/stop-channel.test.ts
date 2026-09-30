// INVARIANT: a note on the root's Stop never gives the model another turn. Claude Code continues the conversation on
// additionalContext at Stop exactly as on block (docs: hooks#stop-decision-control), so a note goes to the human as
// systemMessage and only an explicit block (first delivery of a finding, undrained checks) wakes the model.
// REGRESSION 24.09: 199 Stop contexts in a week, 188 followed by one more model turn, 196 of them from memory-guard;
// the owner decided memory-index, the repeat of a sweep-stop signature and git-freshness on Stop go to him.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { route } from '../src/main.ts';
import { merge, render } from '../src/emit.ts';
import { sandbox, payload, runHook, onlyGate, HARNESS_ROOT, NODE_BIN } from './_env.ts';

function git(cwd: string, ...args: string[]): string { return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }); }
const HOOK = { CLAUDE_HARNESS_NODE: NODE_BIN };
const wakes = (stdout: string): boolean => /additionalContext|"decision"/.test(stdout);

describe('Stop of the root hands notes to the human', () => {
  const sb = sandbox('harness-stop-channel-');
  after(() => sb.cleanup());

  it('renders a context verdict on stop as systemMessage and keeps block as the one way to continue', () => {
    assert.deepEqual(JSON.parse(render({ kind: 'context', text: 'note', gate: 'g' }, 'stop').stdout), { systemMessage: 'note' });
    assert.deepEqual(JSON.parse(render({ kind: 'block', reason: 'fix it', gate: 'g' }, 'stop').stdout), { decision: 'block', reason: 'g: fix it' });
  });

  it('keeps the notes of lower rank as systemMessage beside a block, so a drain block does not swallow them', () => {
    const v = merge([{ kind: 'block', reason: 'drain', gate: 'sweep-stop' }, { kind: 'context', text: 'memory note', gate: 'memory-guard' }, { kind: 'unknown', reason: 'no HOME', gate: 'capture-commits' }], 'stop');
    const out = JSON.parse(render(v, 'stop').stdout) as { decision?: string; systemMessage?: string };
    assert.equal(out.decision, 'block');
    assert.match(out.systemMessage ?? '', /memory note/); assert.match(out.systemMessage ?? '', /unknown\(capture-commits\): no HOME/);
  });
  it('blocks the first Stop on a sweep failure and hands its repeats to the human without waking the model', async () => {
    const repo = join(sb.dir, 'repo'); mkdirSync(repo);
    git(repo, 'init', '-q'); writeFileSync(join(repo, 'README.md'), 'x\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'i');
    const top = git(repo, 'rev-parse', '--show-toplevel').trim();
    await route('post', payload('PostToolUse', { session_id: 's-seen', tool_name: 'Bash', tool_input: { command: 'true' }, tool_use_id: 't1' }, top) as never, { HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, HARNESS_ROOT, ...onlyGate('sweep') });
    writeFileSync(join(top, '.git', 'HEAD'), 'garbage\n');
    const env = { ...HOOK, ...onlyGate('sweep-stop') };
    const [first, ...repeats] = [false, true, true].map((active) => runHook('stop', payload('Stop', { session_id: 's-seen', stop_hook_active: active }, top), sb, env));
    assert.match(first.stdout, /"decision":"block"/, first.stdout + first.stderr);
    for (const r of repeats) {
      assert.equal(wakes(r.stdout), false, `a repeat of the same signature gave the model a turn: ${r.stdout}`);
      assert.match(r.stdout, /systemMessage/, 'the repeat went silent instead of reaching the human');
    }
  });

  it('wakes the model once while a background writer keeps a file broken with the same message', async () => {
    const dir = join(sb.dir, 'writer'); mkdirSync(dir);
    git(dir, 'init', '-q'); writeFileSync(join(dir, 'README.md'), 'x\n'); git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'i');
    const top = git(dir, 'rev-parse', '--show-toplevel').trim();
    const env = { HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, HARNESS_ROOT, ...onlyGate('sweep-stop') };
    const kinds: string[] = [];
    for (let i = 0; i < 6; i++) {
      writeFileSync(join(top, 'progress.json'), `// generated\n{"rows": [${i}]}`);
      kinds.push((await route('stop', payload('Stop', { session_id: 's-writer', stop_hook_active: i > 0 }, top) as never, env)).kind);
    }
    assert.deepEqual(kinds, ['block', 'context', 'context', 'context', 'context', 'context'], 'a finding the model cannot fix woke it on every Stop');
  });

  it('hands an orphan memory note to the human on every Stop instead of waking the model', () => {
    const proj = join(sb.dir, 'proj'); mkdirSync(join(proj, 'memory'), { recursive: true });
    writeFileSync(join(proj, 'memory', 'MEMORY.md'), '- [A](a.md) — a\n');
    writeFileSync(join(proj, 'memory', 'a.md'), '---\nname: a\n---\n'); writeFileSync(join(proj, 'memory', 'b.md'), '---\nname: b\n---\n');
    const env = { ...HOOK, ...onlyGate('memory-index') };
    for (const active of [false, true]) {
      const r = runHook('stop', payload('Stop', { session_id: 's-mem', transcript_path: join(proj, 'sess.jsonl'), stop_hook_active: active }, sb.dir), sb, env);
      assert.equal(wakes(r.stdout), false, r.stdout);
      assert.match(r.stdout, /memory-integrity/);
    }
  });
});
