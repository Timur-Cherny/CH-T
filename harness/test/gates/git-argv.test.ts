// A script sets W=/path on one line and runs `git -C "$W" push` on the next: the replay of 22.09 found 71 such commands in
// a week reaching pre-push as «directory not determined» — a silent pass while ask meant nothing in bypass, a deny now.
// INVARIANT: a variable assigned earlier in the same command expands for the segments after it; a value from a
// substitution stays unknown; a prefix assignment does not change the expansion of its own command (shell semantics).
// A `cd` inside `( … )`, `$( … )`, `sh -c` or a background job leaked into later segments, so `(cd /other); git push`
// was judged in /other while it ran in the caller's directory; `$PWD` expanded to the hook's own directory; a git call
// inside `bash -lc` or behind `sudo -u` was not a segment at all.
// INVARIANT: a segment gets a directory only when every path to it leaves the shell in that one directory; otherwise null.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../../src/parsers/shell.ts';
import { segmentsWithCwd, parseGit } from '../../src/gates/git-argv.ts';

const gitCwd = (command: string, env: NodeJS.ProcessEnv = {}): (string | null)[] =>
  segmentsWithCwd(tokenize(command), '/start', env).filter((s) => s.name === 'git').map((s) => parseGit(s.rest, s.cwd, s.env)?.cwd ?? null);

describe('git-argv: script-local variables', () => {
  it('expands a variable assigned on an earlier line, by export, local and declare', () => {
    assert.deepEqual(gitCwd('W=/r/x\nC=/r/y\ngit -C "$W" push source fix/a'), ['/r/x']);
    assert.deepEqual(gitCwd('export W=/r/x; git -C $W push'), ['/r/x']);
    assert.deepEqual(gitCwd('local W=/r/x; git -C "${W}" status'), ['/r/x']);
    assert.deepEqual(gitCwd('declare -x W=/r/x; cd "$W" && git push'), ['/r/x']);
  });
  it('builds a value from earlier variables and the hook environment', () => {
    assert.deepEqual(gitCwd('B=/r; W=$B/x; git -C "$W" push', {}), ['/r/x']);
    assert.deepEqual(gitCwd('W=$ROOT/x; git -C "$W" push', { ROOT: '/home' }), ['/home/x']);
  });
  it('keeps a value from a substitution unknown, and does not let a prefix assignment expand its own command (both sides)', () => {
    assert.deepEqual(gitCwd('W=$(pwd); git -C "$W" push'), [null]);
    assert.deepEqual(gitCwd('W=/r/x git -C "$W" push'), [null]);
    assert.deepEqual(gitCwd('W=/r/x; W=`pwd`; git -C "$W" push', { W: '/stale' }), [null], 'a re-assignment from a substitution forgets the old value');
  });
});

const at = (command: string, env: NodeJS.ProcessEnv = {}): (string | null)[] =>
  segmentsWithCwd(tokenize(command), null, env).filter((s) => s.name === 'git').map((s) => parseGit(s.rest, s.cwd, s.env)?.cwd ?? null);

describe('git-argv: segmentsWithCwd — scope of cd and assignments', () => {
  it('keeps a cd inside a child shell there — subshell, $(…), sh -c, background job, pipe element', () => {
    assert.deepEqual(gitCwd('(cd /r/x); git push'), ['/start'], 'Miss this and the push is judged in /r/x while it runs in /start');
    assert.deepEqual(gitCwd('(cd /r/x && git push)'), ['/r/x']);
    assert.deepEqual(gitCwd('echo $(cd /r/x) && git push'), ['/start']);
    assert.deepEqual(gitCwd('bash -c "cd /r/x" && git push'), ['/start']);
    assert.deepEqual(gitCwd('cd /r/x & git push'), ['/start']);
    assert.deepEqual(gitCwd('cd /r/x | cat; git push'), ['/start']);
    assert.deepEqual(gitCwd('(W=/r/x); git -C "$W" push'), [null]);
  });
  it('finds git inside a shell behind an option cluster or a wrapper — bash -lc, sudo -u, xargs, a path to the shell', () => {
    assert.deepEqual(gitCwd("bash -lc 'git push'"), ['/start'], 'Miss this and a push inside bash -lc is no segment at all, so no gate sees it');
    assert.deepEqual(gitCwd("sudo -u me bash -c 'git push'"), ['/start']);
    assert.deepEqual(gitCwd("ls | xargs -I{} sh -c 'cd /r/x && git push'"), ['/r/x']);
    assert.deepEqual(gitCwd("/bin/zsh -fc 'git push'"), ['/start']);
  });
  it('leaves the directory unknown when a path to the segment may skip or repeat a cd', () => {
    assert.deepEqual(gitCwd('true | cd /r/x; git push'), [null], 'zsh runs the last pipe element in the caller, bash does not');
    assert.deepEqual(gitCwd('if test -d /r/x; then cd /r/x; fi; git push'), [null]);
    assert.deepEqual(gitCwd('test -d /r/x && cd /r/x; git push'), [null]);
    assert.deepEqual(gitCwd('git fetch && cd /r/x; git push'), ['/start', null]);
    assert.deepEqual(gitCwd('test -d /r/y || cd /r/y && git push'), [null]);
    assert.deepEqual(gitCwd('git fetch && true || cd /r/x && git push'), ['/start', null]);
    assert.deepEqual(gitCwd('for d in 1; do cd /r/x; done; git push'), [null]);
    assert.deepEqual(gitCwd('for i in 1 2; do git push; cd /r/x; done'), [null]);
    assert.deepEqual(gitCwd('for i in 1 2; do cd sub; git push; done'), [null]);
    assert.deepEqual(gitCwd('f() { cd /r/x; }; f; git push'), [null]);
    assert.deepEqual(gitCwd('cd "$(pwd)/x" && git push'), [null], 'a target built by a substitution is not a path the gate may resolve');
    assert.deepEqual(gitCwd('if true; then W=/r/x; fi; git -C "$W" push', { W: '/stale' }), [null]);
    assert.deepEqual(gitCwd('cd /r/x; X=$(false) && cd /r/y; git push'), [null], 'a bare assignment fails when its substitution fails');
  });
  it('makes the directory and variables unknown after an eval of text it cannot read', () => {
    assert.deepEqual(gitCwd('cd /r/gh && eval "$(echo cd /r/corp)"; git push'), [null], 'Miss this and the push is judged in gh while eval moved it to corp');
    assert.deepEqual(gitCwd('C="cd /r/corp"; cd /r/gh && eval $C; git push'), [null]);
    assert.deepEqual(gitCwd('W=/r/x; eval "$(ssh-agent -s)"; git -C "$W" push'), [null]);
  });
  it('still follows a cd every path runs — first step, && chain, branch body, eval text, before || exit (no regression)', () => {
    assert.deepEqual(gitCwd('cd /r/x && git push'), ['/r/x']);
    assert.deepEqual(gitCwd('cd /r && cd x && git push'), ['/r/x']);
    assert.deepEqual(gitCwd('W=/r/x && cd "$W" && git push'), ['/r/x']);
    assert.deepEqual(gitCwd('cd /r/x || exit 1; git push'), ['/r/x']);
    assert.deepEqual(gitCwd('{ cd /r/x; }; git push'), ['/r/x']);
    assert.deepEqual(gitCwd('pushd /r/x && git push; popd; git push'), ['/r/x', '/start']);
    assert.deepEqual(gitCwd('git fetch && cd /r/x && git push'), ['/start', '/r/x'], 'Miss this and a push that runs only after the cd is refused as undetermined');
    assert.deepEqual(gitCwd('cd /r/a && git push && cd /r/b && git push'), ['/r/a', '/r/b']);
    assert.deepEqual(gitCwd('S=/r/s && cd /r && git worktree add /r/wt && cd /r/wt && git merge x && git push source HEAD:release/1.27.0'), ['/r', '/r/wt', '/r/wt']);
    assert.deepEqual(gitCwd('if test -d /r/x; then cd /r/x && git push; fi'), ['/r/x']);
    assert.deepEqual(gitCwd('for i in 1 2; do cd /r/x && git push; done'), ['/r/x']);
    assert.deepEqual(gitCwd('eval "cd /r/x"; git push'), ['/r/x']);
  });
  it('expands $PWD and $OLDPWD from the tracked directory, never from the hook process', () => {
    const hook = { PWD: '/hook', OLDPWD: '/old', HOME: '/home' };
    assert.deepEqual(gitCwd('git -C "$PWD" push', hook), ['/start'], 'Miss this and $PWD names the hook directory while the shell runs elsewhere');
    assert.deepEqual(gitCwd('cd /r/x && git -C "$PWD" push', hook), ['/r/x']);
    assert.deepEqual(gitCwd('cd /r/a && cd /r/b && git -C "$OLDPWD" push', hook), ['/r/a']);
    assert.deepEqual(gitCwd('git -C "$OLDPWD" push', hook), [null]);
    assert.deepEqual(gitCwd('cd /r/a && cd /r/b && cd - && git push', hook), ['/r/a']);
    assert.deepEqual(at('git -C "$PWD" push', hook), [null]);
    assert.deepEqual(at('cd "$PWD" && git push', hook), [null]);
  });
  it('reads the directory forms of cd, pushd and assignment the shell has — builtin, chdir, ~user, --, stack index, -n, +=, loop and function variables', () => {
    const home = { HOME: '/home' };
    assert.deepEqual(gitCwd('builtin cd /r/x && git push'), ['/r/x']);
    assert.deepEqual(gitCwd('chdir /r/x && git push'), ['/r/x']);
    assert.deepEqual(gitCwd('cd ~root && git push', home), [null]);
    assert.deepEqual(gitCwd('cd -- -x && git push', home), ['/start/-x']);
    assert.deepEqual(gitCwd('cd -1 && git push', home), [null]);
    assert.deepEqual(gitCwd('pushd -n /r/x && git push'), ['/start']);
    assert.deepEqual(gitCwd('W=/r; W+=/x; git -C "$W" push'), ['/r/x']);
    assert.deepEqual(gitCwd('W=/r/gh; for W in /r/corp; do git -C $W push; done'), [null]);
    assert.deepEqual(gitCwd('W=/r/gh; f() { git -C "$W" push; }; W=/r/corp; f'), [null]);
  });
  it('starts from an unknown directory when the caller does not know it, and an absolute cd or -C still settles it', () => {
    assert.deepEqual(at('git push'), [null]);
    assert.deepEqual(at('cd sub && git push'), [null]);
    assert.deepEqual(at('git -C sub push'), [null]);
    assert.deepEqual(at('cd /r/x && git push; git -C /r/y push'), ['/r/x', '/r/y']);
  });
});
