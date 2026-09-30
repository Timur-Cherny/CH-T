// INVARIANT: project-check says `fail` ⟺ .claude/check.sh itself exited non-zero; a script the deadline killed is
// `unknown` with the reason named, and a `fail` always carries something to act on. It broke silently: with the sync
// tier's budget nearly spent, the kill came back from spawnTool as rc=1 with no output, and the Stop door blocked the
// turn on "<path> [project-check] fail: <path>: " for a file the script passes when run by hand.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from '../_env.ts';
import { run } from '../../src/checks/project-check.ts';
import type { ChangedFile, CheckContext } from '../../src/checks/types.ts';

const sb = sandbox('harness-project-check-');
after(() => sb.cleanup());

function docIn(name: string, script: string): ChangedFile {
  const repo = join(sb.dir, name);
  mkdirSync(join(repo, '.claude'), { recursive: true });
  writeFileSync(join(repo, '.claude', 'check.sh'), `#!/bin/bash\n${script}\n`, { mode: 0o755 });
  writeFileSync(join(repo, 'doc.md'), '# Title\n');
  return { repo, path: 'doc.md', absPath: join(repo, 'doc.md'), digest: '0', status: 'M' };
}
const ctx = (deadlineMs: number, env: NodeJS.ProcessEnv = {}): CheckContext => ({ env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: sb.home, ...env }, stateDir: sb.stateDir, now: () => 0, deadlineMs });

describe('project-check run', () => {
  it('answers unknown and names the timeout when the deadline kills the script — the file was never judged', async () => {
    const r = await run(docIn('killed', 'exec sleep 30'), ctx(150));
    assert.deepEqual(r, { verdict: 'unknown', missing_reason: 'check.sh превысил таймаут', transient: 'timeout' }, 'Miss this and a healthy file blocks the turn as a failure nobody can fix');
  });

  it('answers unknown when the timed-out script swallows TERM and exits 0 — a check that never finished is not a pass', async () => {
    const r = await run(docIn('trapped', "trap 'kill $!; exit 0' TERM; sleep 30 & wait"), ctx(300));
    assert.deepEqual(r, { verdict: 'unknown', missing_reason: 'check.sh превысил таймаут', transient: 'timeout' });
  });

  it('applies CHECK_TIMEOUT when it is tighter than the deadline of the tier', async () => {
    const r = await run(docIn('own-timeout', 'exec sleep 30'), ctx(Infinity, { CHECK_TIMEOUT: '0.25' }));
    assert.equal(r.verdict, 'unknown', JSON.stringify(r));
  });

  it('still fails a script that exits non-zero on its own and relays what it printed (no regression)', async () => {
    const r = await run(docIn('red', 'echo "no title: $1"; exit 1'), ctx(10000));
    assert.deepEqual(r, { verdict: 'fail', message: 'doc.md: no title: doc.md' });
  });

  it('names the exit code when a failing script printed nothing — an empty message leaves the reader nothing to act on', async () => {
    const r = await run(docIn('mute', 'exit 3'), ctx(10000));
    assert.deepEqual(r, { verdict: 'fail', message: 'doc.md: check.sh завершился с rc=3 без вывода' });
  });

  it('names the signal when the failing script was killed from outside without a word', async () => {
    const r = await run(docIn('shot', 'kill -KILL $$'), ctx(10000));
    assert.deepEqual(r, { verdict: 'fail', message: 'doc.md: check.sh убит сигналом SIGKILL без вывода' });
  });

  it('passes a script that exits 0', async () => {
    assert.deepEqual(await run(docIn('green', 'exit 0'), ctx(10000)), { verdict: 'pass' });
  });
});
