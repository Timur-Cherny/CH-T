// A generated element that the router does not load, the shim prefilter never lets through, or the meta tests reject
// is worse than none: it looks finished. INVARIANT: every generated gate and checker is wired (index.ts, prefilter)
// and passes the registry, prefilter, lint and typecheck meta tests as generated; a generated rule is silent outside
// its target and unknown on it — never a silent pass; a failed plan writes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { main, plan, KINDS, type Options } from './new.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const opts = (kind: Options['kind'], name: string, root: string): Options => ({ kind, name, root, purpose: 'p', description: 'd', trigger: name, event: 'pre-bash', dryRun: false, today: '2026-10-25' });

function copy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'TEST-scaffold-'));
  for (const d of ['harness', 'skills', 'agents', 'runtimes', 'scaffold', 'settings.json']) if (existsSync(join(ROOT, d))) cpSync(join(ROOT, d), join(dir, d), { recursive: true, filter: (s) => !s.includes('node_modules') });
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', 'add', '-A'], { cwd: dir });
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'base'], { cwd: dir });
  return dir;
}

test('names are kebab-case and kinds are the listed ones; a refused call writes nothing', async () => {
  const out: string[] = [];
  assert.equal(await main(['gate', 'Bad_Name'], (s) => out.push(s)), 64);
  assert.equal(await main(['widget', 'x'], (s) => out.push(s)), 64);
  assert.equal(await main(['list'], (s) => out.push(s)), 0);
  assert.equal(await main(['gate', 'zz-q', '--trigger', "it's"], (s) => out.push(s)), 64, 'a quote in the trigger would break the gate module and the shim regex');
  assert.equal(await main(['skill', 'zz-q', '--description', 'a | b'], (s) => out.push(s)), 64);
  assert.match(out.join(''), new RegExp(KINDS.join(', ')));
});

test('a plan that hits an existing file fails before writing anything', () => {
  assert.throws(() => plan(opts('agent', 'spec-critic', ROOT)), /уже существует/);
});

test('every kind plans files under its own directory and nothing outside the root', () => {
  for (const kind of KINDS) {
    for (const p of plan(opts(kind, 'zz-probe', ROOT))) assert.ok(!p.path.startsWith('/') && !p.path.includes('..'), `${kind}: ${p.path}`);
  }
});

test('a generated gate and checker are wired, typecheck and pass the meta tests as generated', { timeout: 600_000 }, async () => {
  const dir = copy();
  try {
    const out: string[] = [];
    assert.equal(await main(['gate', 'zz-probe', '--trigger', 'zzprobe', '--root', dir], (s) => out.push(s)), 0, out.join(''));
    assert.equal(await main(['checker', 'zz-check', '--root', dir], (s) => out.push(s)), 0, out.join(''));
    assert.equal(await main(['gate', 'zz-write', '--event', 'pre-write', '--trigger', 'zzdir/', '--root', dir], (s) => out.push(s)), 0, out.join(''));
    assert.match(readFileSync(join(dir, 'harness/src/gates/index.ts'), 'utf8'), /import '\.\/zz-probe\.ts';\n(?:.*\n)*import '\.\/bash-writes\.ts'/);
    assert.match(readFileSync(join(dir, 'harness/bin/prefilter.regex'), 'utf8'), /zzprobe/);
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--test', '--test-reporter=tap',
      'test/gates/zz-probe.test.ts', 'test/gates/zz-write.test.ts', 'test/checks/zz-check.test.ts', 'test/gates/bash-writes.test.ts', 'test/meta/registry.test.ts', 'test/meta/prefilter.test.ts', 'test/meta/lint.test.ts', 'test/meta/typecheck.test.ts'],
    { cwd: join(dir, 'harness'), encoding: 'utf8', env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT')) });
    assert.match(r.stdout, /^# fail 0$/m, r.stdout.split('\n').filter((l) => l.startsWith('not ok')).join('\n') || r.stderr.slice(0, 2000));
    assert.match(r.stdout, /^# pass [1-9]/m);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
