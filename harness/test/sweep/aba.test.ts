// INVARIANT I1 (P3, 25.09): a broken file never passes Stop silently, even when its content came back to a break
// that was already reported (X→Y→X). Three mechanisms let it through and are each covered here:
//  1. deliver() forgot a delivery only when the path left the change set, keyed on path not digest — so a finding
//     already delivered at X was suppressed forever, and the returning X was silent.
//  2. a worker job id is content-only, so a `done` job for X was never re-claimed when X returned unverified.
//  3. the worker recorded a verdict under the digest it started with, so a pass computed on Y could settle X.
// Store failure on Stop is the fourth: unknown becomes non-blocking context on Stop, so an unavailable store must
// block, never pass.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliver, recordResult, digestOf, rootReader } from '../../src/sweep.ts';
import { sweepStop } from '../../src/gates/sweep-gates.ts';
import { State } from '../../src/state.ts';
import { generation } from '../../src/contour.ts';
import type { ChangedFile } from '../../src/checks/types.ts';
import type { GateContext } from '../../src/types.ts';
import { sandbox, payload, HARNESS_ROOT } from '../_env.ts';

function repoWith(sb: ReturnType<typeof sandbox>, content: string): { repo: string; write: (c: string) => ChangedFile } {
  const repo = join(sb.dir, 'repo'); mkdirSync(repo, { recursive: true });
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', HOME: sb.home, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  writeFileSync(join(repo, 'a.ts'), content);
  for (const a of [['init', '-q'], ['add', '.'], ['commit', '-qm', 'base']]) execFileSync('git', a, { cwd: repo, env });
  const abs = join(repo, 'a.ts');
  const write = (c: string): ChangedFile => { writeFileSync(abs, c); return { repo, path: 'a.ts', absPath: abs, digest: digestOf(abs), status: 'M' }; };
  return { repo, write };
}

describe('sweep — a re-broken file (X→Y→X) is reported again, not suppressed by an old delivery', () => {
  it('re-delivers the finding when the current content returns to the reported digest (Fix 1)', () => {
    const sb = sandbox('harness-aba-'); const st = State.open(sb.stateDir);
    try {
      const { repo, write } = repoWith(sb, 'export const a = 1;\n');
      const gen = generation(repo);
      const X = write('export const a: number = "broken";\n');
      const fnd = recordResult(st, X, 'tsc-project', gen, { verdict: 'fail', message: 'X is broken' }, 1);
      assert.ok(fnd, 'the first break is news');
      assert.equal(deliver(st, rootReader('s1'), [repo], 1, [fnd!], [X]).found.length, 1, 'delivered at X');
      assert.equal(deliver(st, rootReader('s1'), [repo], 2, [], [X]).found.length, 0, 'still X in the same session — not re-reported');
      const Y = write('export const a: number = 1;\n');
      recordResult(st, Y, 'tsc-project', gen, { verdict: 'pass' }, 3);
      assert.equal(deliver(st, rootReader('s1'), [repo], 3, [], [Y]).found.length, 0, 'Y is clean — nothing owed');
      const X2 = write('export const a: number = "broken";\n');
      assert.equal(X2.digest, X.digest, 'same content, same digest');
      const again = deliver(st, rootReader('s1'), [repo], 4, [], [X2]);
      assert.deepEqual(again.found.map((f) => [f.path, f.level]), [['a.ts', 'fail']], 'the returned break is reported again — before Fix 1 this was empty and Stop was silent');
    } finally { st.close(); sb.cleanup(); }
  });
});

describe('sweep-stop — an unavailable store blocks, it does not pass', () => {
  const sb = sandbox('harness-aba-store-');
  after(() => sb.cleanup());
  it('returns block (not silent, not context) when the state dir cannot be opened (Fix #4)', async () => {
    // A state dir that is really a file: State.open cannot create its database there and throws.
    const bad = join(sb.dir, 'not-a-dir'); writeFileSync(bad, 'x');
    const ctx: GateContext = { event: 'stop', payload: payload('Stop', { session_id: 's1', stop_hook_active: false }, sb.dir) as never, env: { HOME: sb.home, CLAUDE_STATE_DIR: bad, HARNESS_ROOT }, root: HARNESS_ROOT, stateDir: bad, now: () => 1 };
    const v = await sweepStop(ctx);
    assert.equal(v.kind, 'block', JSON.stringify(v));
    assert.match((v as { reason: string }).reason, /хранилище недоступно|не проверено/);
  });
});
