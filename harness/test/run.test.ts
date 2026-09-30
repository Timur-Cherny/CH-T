// INVARIANT: bin/run hands a harness script to the harness runtime (Node >= 24) resolved exactly as
// bin/hook resolves it (bin/node-pin.sh); a PATH node below 24 is refused, never used.
// Молча ломалось: CLAUDE.md и скиллы звали `node harness/scripts/data-answers.ts` — под nvm default 22
// это ERR_UNKNOWN_FILE_EXTENSION, и агент лечил его флагом --experimental-strip-types вместо пина рантайма.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, fakeNode, assertNotReal, HARNESS_ROOT, NODE_BIN } from './_env.ts';
import type { Sandbox } from './_env.ts';

interface RunResult { rc: number; stdout: string; stderr: string }

/** Чёрный ящик: bin/run <args> из cwd песочницы с заданным окружением. */
function runLauncher(args: string[], sb: Sandbox, env: Record<string, string> = {}, opts: { path?: string; bin?: string } = {}): RunResult {
  assertNotReal(sb.home);
  const r = spawnSync('sh', [opts.bin ?? join(HARNESS_ROOT, 'bin', 'run'), ...args], {
    encoding: 'utf8',
    cwd: sb.dir,
    env: { PATH: opts.path ?? '/usr/bin:/bin', HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, ...env },
    timeout: 20000,
  });
  return { rc: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('bin/run', () => {
  const sb = sandbox('harness-run-');
  after(() => sb.cleanup());

  it('hands CLAUDE_HARNESS_NODE the harness-relative script and the arguments verbatim, from a foreign cwd', () => {
    const rec = join(sb.dir, 'rec-pin.txt');
    const p = fakeNode(join(sb.dir, 'pin'), '24.99.0', rec);
    const r = runLauncher(['scripts/export.ts', '--classify', 'select 1 from t'], sb, { CLAUDE_HARNESS_NODE: p });
    assert.equal(r.rc, 0, r.stderr);
    assert.deepEqual(readFileSync(rec, 'utf8').trim().split('\n'), [
      'v24.99.0', '--disable-warning=ExperimentalWarning', join(HARNESS_ROOT, 'scripts', 'export.ts'), '--classify', 'select 1 from t',
    ]);
  });

  it('refuses a PATH node below 24 with rc 69 and the install hint — the project runtime never runs a harness script', () => {
    const bin = join(sb.dir, 'bin22');
    const rec = join(sb.dir, 'rec-22.txt');
    fakeNode(bin, '22.17.1', rec);
    const r = runLauncher(['scripts/export.ts', '--env', 'prod', '--kind', 'rows'], sb, {}, { path: `${bin}:/usr/bin:/bin` });
    assert.equal(r.rc, 69, r.stderr);
    assert.match(r.stderr, /install\.sh|CLAUDE_HARNESS_NODE/);
    assert.equal(existsSync(rec), false, 'скрипт запущен под node 22');
  });

  it('reads ~/.claude/env/harness.env when no override is set — the pin install.sh wrote', () => {
    const sb2 = sandbox('harness-run-env-');
    try {
      const rec = join(sb2.dir, 'rec.txt');
      const p = fakeNode(join(sb2.dir, 'envnode'), '24.50.0', rec);
      mkdirSync(join(sb2.home, '.claude', 'env'), { recursive: true });
      writeFileSync(join(sb2.home, '.claude', 'env', 'harness.env'), `CLAUDE_HARNESS_NODE=${p}\n`);
      const r = runLauncher(['scripts/due.ts', '--all'], sb2);
      assert.equal(r.rc, 0, r.stderr);
      assert.equal(readFileSync(rec, 'utf8').split('\n')[0], 'v24.50.0');
    } finally {
      sb2.cleanup();
    }
  });

  it('picks v24.20.0 over v24.9.0 under ~/.nvm — the same numeric rule as bin/hook', () => {
    const sb2 = sandbox('harness-run-nvm-');
    try {
      const rec = join(sb2.dir, 'rec-nvm.txt');
      for (const v of ['24.9.0', '24.20.0', '18.20.5']) fakeNode(join(sb2.home, '.nvm', 'versions', 'node', `v${v}`, 'bin'), v, rec);
      runLauncher(['scripts/due.ts'], sb2);
      assert.equal(readFileSync(rec, 'utf8').split('\n')[0], 'v24.20.0');
    } finally {
      sb2.cleanup();
    }
  });

  it('passes node flags through when the first argument is a flag — the test suite runs the same way', () => {
    const rec = join(sb.dir, 'rec-flags.txt');
    const p = fakeNode(join(sb.dir, 'flagnode'), '24.20.0', rec);
    runLauncher(['--test', 'harness/test/x.test.ts'], sb, { CLAUDE_HARNESS_NODE: p });
    assert.deepEqual(readFileSync(rec, 'utf8').trim().split('\n'), ['v24.20.0', '--disable-warning=ExperimentalWarning', '--test', 'harness/test/x.test.ts']);
  });

  it('answers rc 64 and names the path when the script exists neither as given nor under harness/', () => {
    const r = runLauncher(['scripts/no-such-script.ts'], sb, { CLAUDE_HARNESS_NODE: NODE_BIN });
    assert.equal(r.rc, 64);
    assert.match(r.stderr, /no-such-script\.ts/);
    assert.equal(runLauncher([], sb, { CLAUDE_HARNESS_NODE: NODE_BIN }).rc, 64);
  });

  it('runs the real script under the runtime and passes its exit code through — a usage error is 64 here as on the command line', () => {
    const r = runLauncher(['scripts/export.ts'], sb, { CLAUDE_HARNESS_NODE: NODE_BIN });
    assert.equal(r.rc, 64, r.stderr);
    assert.match(r.stderr, /использование: export\.ts/);
  });

  it('works through the ~/.claude/harness symlink install.sh creates — the root is the physical harness', () => {
    mkdirSync(join(sb.home, '.claude'), { recursive: true });
    const link = join(sb.home, '.claude', 'harness');
    symlinkSync(HARNESS_ROOT, link);
    const rec = join(sb.dir, 'rec-link.txt');
    const p = fakeNode(join(sb.dir, 'linknode'), '24.20.0', rec);
    const r = runLauncher(['scripts/export.ts', '--env', 'prod', '--kind', 'config'], sb, { CLAUDE_HARNESS_NODE: p }, { bin: join(link, 'bin', 'run') });
    assert.equal(r.rc, 0, r.stderr);
    assert.ok(readFileSync(rec, 'utf8').includes(join(HARNESS_ROOT, 'scripts', 'export.ts')));
  });

  it('exports NODE_COMPILE_CACHE under CLAUDE_STATE_DIR and HARNESS_ROOT as the physical harness path, like bin/hook', () => {
    const rec = join(sb.dir, 'rec-envvars.txt');
    const bin = join(sb.dir, 'envprobe');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'node'), `#!/bin/sh\n[ "$1" = "-v" ] && { echo v24.20.0; exit 0; }\nprintf '%s\\n%s\\n' "$NODE_COMPILE_CACHE" "$HARNESS_ROOT" > '${rec}'\n`, { mode: 0o755 });
    runLauncher(['scripts/due.ts'], sb, { CLAUDE_HARNESS_NODE: join(bin, 'node') });
    assert.deepEqual(readFileSync(rec, 'utf8').trim().split('\n'), [join(sb.stateDir, 'compile-cache'), HARNESS_ROOT]);
  });
});
