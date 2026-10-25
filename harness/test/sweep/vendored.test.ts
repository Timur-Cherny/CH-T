// INVARIANT: a path with a segment that is a dependency tree — `node_modules`, or a macOS copy of one named by a suffix
// after a space — is not an authored change: no checker sees it, and it does not take a place under the file cap.
// REGRESSION: Finder copies of node_modules in a monorepo slipped past a .gitignore that names only the exact directory;
// tens of thousands of untracked vendored files blocked Stop with sync-deadline unknowns and filled the file cap ahead
// of the authored files.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { route } from '../../src/main.ts';
import { changedFiles, advanceCursor } from '../../src/sweep.ts';
import { State } from '../../src/state.ts';
import { sandbox, payload, HARNESS_ROOT, frozenClock } from '../_env.ts';

const BROKEN = '#!/bin/bash\nif [ 1 ]; then\n  echo x\n';
const NNBSP = ' ';
const COPIES = [`node_modules 3.11.04${NNBSP}PM 3.11.04${NNBSP}PM`, 'node_modules 2', 'node_modules copy', 'node_modules'];
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

function gitIn(repo: string, ...args: string[]): void { execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: repo, env: GIT_ENV }); }

function repoAt(dir: string): string {
  mkdirSync(dir, { recursive: true });
  gitIn(dir, 'init', '-q');
  writeFileSync(join(dir, 'ok.sh'), '#!/bin/bash\necho x\n');
  gitIn(dir, 'add', '.');
  gitIn(dir, 'commit', '-qm', 'init');
  return dir;
}

function put(repo: string, rel: string, text = BROKEN): void {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), text);
}

function registered(stateDir: string, repo: string): State {
  const st = State.open(stateDir);
  st.db.prepare('INSERT OR IGNORE INTO repos(repo, registered_at) VALUES(?,?)').run(repo, 0);
  return st;
}

describe('vendored dependency trees are not authored', () => {
  const sb = sandbox('harness-vendored-');
  const env = { HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, HARNESS_ROOT, PATH: process.env.PATH ?? '' };
  after(() => sb.cleanup());

  it('reports the broken authored file and nothing under node_modules or its Finder copies, though .gitignore names none of them', async () => {
    const repo = repoAt(join(sb.dir, 'route'));
    for (const [i, copy] of COPIES.entries()) put(repo, `apps/svc${i}/${copy}/pkg/bin.sh`);
    put(repo, 'src/run.sh');
    const v = await route('post', payload('PostToolUse', { session_id: 'vendored-route', tool_name: 'Bash', tool_input: { command: 'printf x > src/run.sh' }, tool_use_id: 'v1' }, repo) as never, env, frozenClock);
    assert.equal(v.kind, 'context', `verdict ${v.kind}: the authored broken file went unreported`);
    const text = (v as { text: string }).text;
    assert.match(text, /src\/run\.sh \[syntax\] fail/);
    assert.doesNotMatch(text, /node_modules/, 'a vendored file reached the checkers');
  });

  it('keeps an authored file under the cap when vendored files outnumber it and sort first', () => {
    const repo = repoAt(join(sb.dir, 'cap'));
    for (let i = 0; i < 5; i++) put(repo, `apps/a/node_modules 2/pkg${i}/i.sh`);
    put(repo, 'src/z.sh');
    const st = registered(sb.stateDir, repo);
    try {
      const out = changedFiles(st, repo, 3);
      assert.deepEqual(out.files.map((f) => f.path), ['src/z.sh']);
      assert.equal(out.truncated, false);
    } finally { st.close(); }
  });

  it('drops vendored files that arrive through a HEAD move as well as through the working tree', () => {
    const repo = repoAt(join(sb.dir, 'head'));
    const st = registered(sb.stateDir, repo);
    try {
      const first = changedFiles(st, repo, 50);
      advanceCursor(st, '', repo, first.from, first.head, false, Date.now());
      put(repo, 'lib/node_modules copy/x.sh');
      put(repo, 'src/y.sh');
      gitIn(repo, 'add', '.');
      gitIn(repo, 'commit', '-qm', 'vendored and authored together');
      assert.deepEqual(changedFiles(st, repo, 50).files.map((f) => f.path), ['src/y.sh']);
    } finally { st.close(); }
  });

  it('still checks names that only start with node_modules or contain it without being the directory', () => {
    const repo = repoAt(join(sb.dir, 'near'));
    const near = ['docs/node_modules.md', 'my_node_modules/b.sh', 'node_modulesX/a.sh', 'src/node_modules.sh'];
    for (const p of near) put(repo, p);
    const st = registered(sb.stateDir, repo);
    try { assert.deepEqual(changedFiles(st, repo, 50).files.map((f) => f.path).sort(), near); } finally { st.close(); }
  });
});
