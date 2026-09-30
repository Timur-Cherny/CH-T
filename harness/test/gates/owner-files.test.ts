// INVARIANT: files under harness/owner/ (the owner's decisions, e.g. the pre-push exception list) are changed only by
// the owner; an agent's Write/Edit/NotebookEdit there is denied, and so is any Bash command that names that path and is not
// a plain read. Reading, diffing and staging stay open.
// REGRESSION 23.09: the exception list was introduced so that the agent stops loosening pre-push-guard itself.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox, payload, bashPayload, HARNESS_ROOT } from '../_env.ts';
import { decide, NAME, KILL } from '../../src/gates/owner-files.ts';
import { route } from '../../src/main.ts';
import type { GateContext, HarnessEvent, HookPayload, Verdict } from '../../src/types.ts';

const sb = sandbox('harness-owner-');
after(() => sb.cleanup());
const env = { HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, HARNESS_ROOT };
const LIST = '/Users/u/brain/harness/owner/pre-push-exceptions.json';

function ctx(event: HarnessEvent, p: unknown): GateContext {
  return { event, payload: p as HookPayload, env, root: HARNESS_ROOT, stateDir: sb.stateDir, now: Date.now };
}
const tool = (tool_name: string, tool_input: Record<string, unknown>) => payload('PreToolUse', { tool_name, tool_input, tool_use_id: 'toolu_o' });
const bash = (command: string, cwd = '/Users/u/brain') => { const p = bashPayload(command) as unknown as { cwd: string }; p.cwd = cwd; return decide(ctx('pre-bash', p)); };
const kind = (v: Verdict | Promise<Verdict>) => Promise.resolve(v).then((x) => x.kind);

describe(NAME, () => {
  it('denies Write, Edit and NotebookEdit into harness/owner/ in any checkout, passes elsewhere (both sides)', async () => {
    assert.equal(await kind(decide(ctx('pre-write', tool('Write', { file_path: LIST, content: '{}' })))), 'deny');
    assert.equal(await kind(decide(ctx('pre-write', tool('Edit', { file_path: '/w/.claude/worktrees/x/harness/owner/a.json', old_string: 'a', new_string: 'b' })))), 'deny');
    assert.equal(await kind(decide(ctx('pre-write', tool('Write', { file_path: '/Users/u/.claude/harness/owner/new.json', content: '{}' })))), 'deny');
    assert.equal(await kind(decide(ctx('pre-write', tool('NotebookEdit', { notebook_path: '/r/harness/owner/n.ipynb', new_source: '' })))), 'deny');
    assert.equal(await kind(decide(ctx('pre-write', tool('Write', { file_path: '/Users/u/brain/harness/src/owner.ts', content: '' })))), 'silent');
    assert.equal(await kind(decide(ctx('pre-write', tool('Write', { file_path: '/r/harness/ownership/x.json', content: '' })))), 'silent');
  });

  it('denies Bash that writes, moves, edits in place or runs a program over the owner path', async () => {
    for (const c of [
      `echo '{}' > ${LIST}`,
      `sed -i '' 's/a/b/' harness/owner/pre-push-exceptions.json`,
      'cp /tmp/x.json harness/owner/pre-push-exceptions.json',
      'rm harness/owner/pre-push-exceptions.json',
      'git checkout HEAD~1 -- harness/owner/pre-push-exceptions.json',
      `python3 -c "open('harness/owner/pre-push-exceptions.json','w').write('{}')"`,
      'cat harness/owner/pre-push-exceptions.json | tee harness/owner/copy.json',
    ]) assert.equal(await kind(bash(c)), 'deny', c);
  });

  it('lets reads, diffs and staging through (the other side)', async () => {
    for (const c of [
      'cat harness/owner/pre-push-exceptions.json',
      'jq . harness/owner/pre-push-exceptions.json',
      'grep -n remote harness/owner/pre-push-exceptions.json | head -3',
      'git diff -- harness/owner/',
      'git log --oneline -- harness/owner/pre-push-exceptions.json',
      'git add harness/owner/pre-push-exceptions.json',
      'ls -la harness/owner',
      'npm test',
    ]) assert.equal(await kind(bash(c)), 'silent', c);
  });

  it('is reached through the router for both events and is skipped by its kill-switch', async () => {
    const w = await route('pre-write', tool('Write', { file_path: LIST, content: '{}' }) as unknown as HookPayload, { ...env });
    assert.match(JSON.stringify(w), new RegExp(NAME));
    const off = await route('pre-write', tool('Write', { file_path: LIST, content: '{}' }) as unknown as HookPayload, { ...env, [KILL]: '1' });
    assert.doesNotMatch(JSON.stringify(off), new RegExp(NAME));
  });
});
