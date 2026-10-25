// INVARIANT: прогон по транскриптам считает переходы вердиктов между разборщиками по гейтам и никогда не печатает
// текст команды без --show; deny→не-deny помечается как регрессия. Корпус — синтетический JSONL в песочнице.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collect, replay, render } from '../../scripts/shell-replay.ts';
import { sandbox } from '../_env.ts';

const sb = sandbox('harness-replay-');
after(() => sb.cleanup());

const line = (command: string): string => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } });

describe('scripts/shell-replay', () => {
  it('collects unique Bash commands that pass the prefilter, from every project directory', () => {
    const root = join(sb.dir, 'projects');
    mkdirSync(join(root, 'p1'), { recursive: true }); mkdirSync(join(root, 'p2'), { recursive: true });
    writeFileSync(join(root, 'p1', 'a.jsonl'), [line('psql -c "SELECT 1"'), line('ls -la'), line('psql -c "SELECT 1"'), 'not json', JSON.stringify({ message: { content: 'text "Bash"' } })].join('\n'));
    writeFileSync(join(root, 'p2', 'b.jsonl'), [line('git push origin main'), line('echo "Bash"')].join('\n'));
    assert.deepEqual(collect(root, 30).sort(), ['git push origin main', 'psql -c "SELECT 1"']);
    assert.deepEqual(collect(join(sb.dir, 'missing'), 30), []);
  });
  it('replays each command through both parsers per gate and counts transitions without keeping texts', async () => {
    const r = await replay(['psql -c "SET statement_timeout = 0"', 'psql -c "SELECT 1"', 'ls'], ['pg-session'], sb.dir);
    assert.equal(r.commands, 3);
    const t = r.gates['pg-session'].transitions;
    assert.equal(t['deny→deny'], 1, JSON.stringify(t));
    assert.equal(t['clean→clean'], 2, JSON.stringify(t));
    assert.equal(JSON.stringify(r).includes('statement_timeout'), false, 'текст команды не уезжает в отчёт');
    const text = render(r);
    assert.match(text, /команд: 3/);
    assert.match(text, /✓ deny→не-deny: 0/);
  });
  it('marks a deny→clean transition as a regression in the rendered table', () => {
    const text = render({ commands: 1, gates: { 'pg-session': { transitions: { 'deny→clean': 1 }, legacy: { deny: 1 }, grammar: { clean: 1 } } } });
    assert.match(text, /deny→clean ⛔/);
    assert.match(text, /регрессия барьера/);
  });
});
