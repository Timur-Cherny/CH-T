// INVARIANT К5/R6: каждая команда в settings.json (корень и .claude/) — bin/hook <известное событие>; ни одного прямого пути к .sh;
// матчер MCP — regex `mcp__.*` (голое `mcp__` — точное имя и не совпадает ни с чем: проба 05.09); поле `if` не используется (не фильтрует).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HARNESS_ROOT } from '../_env.ts';

const KNOWN = new Set(['pre-bash', 'pre-agent', 'pre-write', 'post', 'post-batch', 'agent-start', 'agent-stop', 'stop', 'session-start', 'session-end', 'prompt', 'precompact', 'worktree-create', 'worktree-remove', 'contour-changed']);
type Hooks = Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeout?: number; if?: string }> }>>;

for (const [file, prefix] of [['settings.json', '"$HOME"/.claude/harness/bin/hook '], ['.claude/settings.json', '"$CLAUDE_PROJECT_DIR"/.claude/bin/hook ']] as const) {
  describe(file, () => {
    const cfg = JSON.parse(readFileSync(join(HARNESS_ROOT, '..', file), 'utf8')) as { hooks: Hooks };
    const entries = Object.entries(cfg.hooks).flatMap(([ev, arr]) => arr.flatMap((m) => m.hooks.map((h) => ({ ev, matcher: m.matcher, ...h }))));
    it('routes every command through the shim with a known event and a timeout', () => {
      for (const e of entries) {
        assert.equal(e.type, 'command');
        assert.ok(e.command.startsWith(prefix), e.command);
        assert.ok(KNOWN.has(e.command.slice(prefix.length)), e.command);
        assert.ok(typeof e.timeout === 'number' && e.timeout > 0, e.command);
        assert.equal(e.if, undefined, 'поле if не фильтрует — префильтр в шиме');
      }
    });
    it('uses a regex matcher for MCP tools and never a bare mcp__', () => {
      for (const e of entries) if (e.matcher?.startsWith('mcp')) assert.equal(e.matcher, 'mcp__.*');
    });
    it('gives resource-heavy pre-bash a timeout above the 240 s wait window', () => {
      for (const e of entries.filter((x) => x.command.endsWith(' pre-bash'))) assert.ok((e.timeout ?? 0) >= 300, 'pre-bash ждёт окно до 240 с — таймаут обязан быть больше');
    });
  });
}
