// INVARIANT: the site config in force is, in order, CLAUDE_HARNESS_CONFIG, then ~/.claude/harness.config.json (any
// entry there, even a dangling link, is the user's choice), then harness.config.json next to the harness root — the
// shims resolve it, so a repo-level session finds the checkout's own config and in-process callers stay hermetic.
// REGRESSION 25.09: the site moved out of code into config, nothing installed the file, and a push from a feature
// branch into the owner's protected branch went through silently on a machine without ~/.claude/harness.config.json.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, realpathSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, bashPayload, HARNESS_ROOT, NODE_BIN } from './_env.ts';

const sb = sandbox('harness-site-config-');
after(() => sb.cleanup());

function pinned(root: string, home: string, env: Record<string, string> = {}): string {
  const r = spawnSync('sh', ['-c', `. "$1/bin/node-pin.sh"; root="$2"; harness_pin_config; printf '%s' "\${CLAUDE_HARNESS_CONFIG:-}"`, 'sh', HARNESS_ROOT, root],
    { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: home, ...env } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

describe('site config resolution at the entry point', () => {
  const checkout = join(sb.dir, 'repo'); const root = join(checkout, 'harness'); mkdirSync(root, { recursive: true });
  const emptyHome = join(sb.dir, 'home-empty'); mkdirSync(emptyHome);

  it('exports the checkout config when HOME has none, and nothing when the checkout has none (both sides)', () => {
    assert.equal(pinned(root, emptyHome), '');
    writeFileSync(join(checkout, 'harness.config.json'), '{}');
    assert.equal(pinned(root, emptyHome), join(realpathSync(checkout), 'harness.config.json'));
  });

  it('leaves the choice to ~/.claude when anything is there — a file or a dangling link — and to an explicit path', () => {
    const withFile = join(sb.dir, 'home-file'); mkdirSync(join(withFile, '.claude'), { recursive: true });
    writeFileSync(join(withFile, '.claude', 'harness.config.json'), '{}');
    assert.equal(pinned(root, withFile), '');
    const withLink = join(sb.dir, 'home-link'); mkdirSync(join(withLink, '.claude'), { recursive: true });
    symlinkSync(join(sb.dir, 'gone.json'), join(withLink, '.claude', 'harness.config.json'));
    assert.equal(pinned(root, withLink), '');
    assert.equal(pinned(root, emptyHome, { CLAUDE_HARNESS_CONFIG: '/x/explicit.json' }), '/x/explicit.json');
  });

  it('protects the checkout-configured branch through the real shim with an empty HOME', () => {
    const fake = join(sb.dir, 'fake'); const fh = join(fake, 'harness'); mkdirSync(join(fh, 'bin'), { recursive: true });
    for (const f of ['hook', 'node-pin.sh', 'prefilter.regex']) copyFileSync(join(HARNESS_ROOT, 'bin', f), join(fh, 'bin', f));
    chmodSync(join(fh, 'bin', 'hook'), 0o755);
    for (const d of ['src', 'vendor', 'scripts', 'owner']) symlinkSync(join(HARNESS_ROOT, d), join(fh, d));
    writeFileSync(join(fake, 'harness.config.json'), JSON.stringify({ protectedBranches: ['product/main'] }));
    const repo = join(sb.dir, 'work'); mkdirSync(repo);
    const genv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' };
    const g = (...a: string[]): void => { execFileSync('git', a, { cwd: repo, env: genv }); };
    g('init', '-q', '-b', 'feature/x'); writeFileSync(join(repo, 'a.txt'), '1\n'); g('add', '.'); g('commit', '-qm', 'feat: a');
    const p = bashPayload('git push origin HEAD:product/main', { permission_mode: 'default' }) as { cwd: string }; p.cwd = repo;
    const r = spawnSync('sh', [join(fh, 'bin', 'hook'), 'pre-bash'], { input: JSON.stringify(p), encoding: 'utf8', timeout: 30000,
      env: { PATH: '/usr/bin:/bin', HOME: emptyHome, CLAUDE_STATE_DIR: join(sb.dir, 'state'), CLAUDE_HARNESS_NODE: NODE_BIN } });
    assert.equal(r.status, 2, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /product\/main разрешён только с release/);
  });
});
