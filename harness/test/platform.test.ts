// INVARIANT: spawnTool returns rc=124 ⟺ Node's kill timer fired (error code ETIMEDOUT), whatever status or signal the
// child ended with; a child that fails on its own keeps its own code. It broke silently: the mapping read `err.killed`,
// a field the synchronous child_process API never sets, so a timeout came back as rc=1 — or as the exit status of a
// TERM-trapping child, 0 included — and checkers reported `fail` (or `pass`) for a tool that never finished.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnTool } from '../src/platform.ts';

const ENV: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
const bash = (script: string, timeoutMs: number): ReturnType<typeof spawnTool> => spawnTool('bash', ['-c', script], { timeoutMs, env: ENV });

describe('spawnTool', () => {
  it('returns 124 when the child outlives timeoutMs — the kill is a timeout, not a verdict of the tool', () => {
    const r = bash('exec sleep 30', 150);
    assert.equal(r.rc, 124, 'Miss this and every checker reads a timed-out tool as its answer: a healthy file is reported as fail');
  });

  for (const status of [0, 3]) {
    it(`returns 124 when the timed-out child traps TERM and exits ${status} on its own — the timer fired, the status is noise`, () => {
      const r = bash(`trap 'kill $!; exit ${status}' TERM; sleep 30 & wait`, 300);
      assert.equal(r.rc, 124, `Miss this and a check that never finished is recorded as ${status === 0 ? 'pass' : 'fail'}`);
    });
  }

  it('keeps the exit code and both streams of a child that fails on its own', () => {
    assert.deepEqual(bash('echo out; echo err >&2; exit 7', 5000), { rc: 7, stdout: 'out\n', stderr: 'err\n' });
  });

  it('returns 0 with the output of a child that finishes inside timeoutMs', () => {
    assert.deepEqual(bash('echo ok', 5000), { rc: 0, stdout: 'ok\n', stderr: '' });
  });

  for (const sig of ['TERM', 'KILL']) {
    it(`does not call it a timeout when SIG${sig} kills the child while the timer never fired — a signal alone proves nothing`, () => {
      const r = bash(`kill -${sig} $$`, 5000);
      assert.equal(r.rc, 1, 'Miss this and an out-of-memory kill is reported as «превысил таймаут», sending the reader after a slow script that is not slow');
    });
  }

  it('refuses a binary outside the allowlist before anything is spawned', () => {
    assert.throws(() => spawnTool('curl', ['--version']), /вне allowlist/);
  });
});
