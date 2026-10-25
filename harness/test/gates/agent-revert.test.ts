// INVARIANT: a subagent's Bash never destroys an uncommitted change of a tracked file in a repository outside the scratch
// area — by restore, stash, clean, reverse patch, removal or committed content written over it — and its Write/Edit
// never turns such a file back into HEAD unless the change appeared after the agent started. The root passes everything,
// the scratch area passes everything but stash, clean files pass, and what the gate cannot resolve is unknown.
// REGRESSION 19.09 / 05.10 (INC-SUBAGENT-REVERTS-WORKING-FILES): an interrupted verifier left the root's fix reverted to
// HEAD, and `cp` from a wiped backup wrote HEAD over three fixes; the only guard was a line of skill text.
// REGRESSION race-auditor round 2 (10.10): «any object» counted the root's staged fix as a revert target, so an agent could
// not take its own debug line out of a file whose fix the root had staged; and friction credits an agent's long Bash with
// the root's edit made meanwhile — taken as authorship, it let the agent write HEAD over the root's fix.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, bashPayload, payload, runHook, HARNESS_ROOT } from '../_env.ts';
import { decide, NAME } from '../../src/gates/agent-revert.ts';
import { GATES } from '../../src/gates/registry.ts';
import { route } from '../../src/main.ts';
import { resetConfigCache } from '../../src/config.ts';
import { State } from '../../src/state.ts';
import { windowDigest } from '../../src/window.ts';
import { expandWord } from '../../src/parsers/expand.ts';
import type { GateContext, HarnessEvent, HookPayload, Verdict } from '../../src/types.ts';

const sb = sandbox('harness-agent-revert-');
after(() => sb.cleanup());
const at = (...p: string[]): string => join(sb.dir, ...p);
const repo = at('repo'); const scratch = at('scratch'); const copy = at('scratch', 'copy'); const pad = at('pad'); const padCopy = at('pad', 'copy');
const cfgPath = at('harness.config.json');
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' };
const HEAD_A = 'export const a = 1;\n';
const ROOT_FIX = 'export const a = 2; // the fix nobody committed yet\n';
const Q0 = 'export const q = 0;\n';
const Q1 = 'export const q = 1; // the root staged this fix\n';
const repo2 = join(sb.dir, 'repo2');

function g(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}
function seedRepo(dir: string): void {
  mkdirSync(join(dir, 'src'), { recursive: true });
  g(at(), 'init', '-q', dir);
  for (const f of ['a', 'b', 'c', 's']) writeFileSync(join(dir, 'src', `${f}.ts`), f === 'a' ? HEAD_A : `export const ${f} = 1;\n`);
  writeFileSync(join(dir, '.gitignore'), 'dist/\n');
  mkdirSync(join(dir, 'pkg'), { recursive: true });
  writeFileSync(join(dir, 'p.json'), '{"root":1}\n'); writeFileSync(join(dir, 'pkg', 'p.json'), '{"pkg":1}\n');
  writeFileSync(join(dir, 'src', 'd.ts'), 'export const d = 0;\n'); writeFileSync(join(dir, 'src', 'e.ts'), 'export const e = 0;\n');
  writeFileSync(join(dir, 'src', 'q.ts'), Q0);
  g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'base');
  writeFileSync(join(dir, 'src', 'd.ts'), 'export const d = 1;\n'); writeFileSync(join(dir, 'src', 'e.ts'), 'export const e = 1;\n');
  g(dir, 'commit', '-q', '-am', 'd and e move on');
  writeFileSync(join(dir, 'src', 'e.ts'), 'export const e = 2; // work in progress\n');
  writeFileSync(join(dir, 'pkg', 'p.json'), '{"pkg":2}\n');
  writeFileSync(join(dir, 'src', 'q.ts'), Q1); g(dir, 'add', 'src/q.ts');
  writeFileSync(join(dir, 'src', 'q.ts'), `${Q1}console.log('agent debug');\n`);
  writeFileSync(join(dir, 'src', 'a.ts'), ROOT_FIX);
  writeFileSync(join(dir, 'src', 'c.ts'), 'export const c = 2;\n');
  writeFileSync(join(dir, 'src', 's.ts'), 'export const s = 2;\n'); g(dir, 'add', 'src/s.ts');
  writeFileSync(join(dir, 'src', 'u.ts'), 'new file of the root\n');
}
function writeConfig(cfg: Record<string, unknown>): void { writeFileSync(cfgPath, JSON.stringify(cfg)); resetConfigCache(); }

const ENV = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  HOME: sb.home, PATH: process.env.PATH ?? '', CLAUDE_HARNESS_CONFIG: cfgPath, HARNESS_SCRATCH_DEFAULTS: scratch, ...extra,
});
function ctx(event: HarnessEvent, p: HookPayload, env = ENV()): GateContext {
  return { event, payload: p, env, root: HARNESS_ROOT, stateDir: sb.stateDir, now: () => 1_000_000 };
}
const agentBash = (command: string, cwd = repo, extra: Record<string, unknown> = {}): HookPayload =>
  bashPayload(command, { cwd, agent_id: 'agent-1', agent_type: 'workflow-subagent', ...extra }) as unknown as HookPayload;
const rootBash = (command: string, cwd = repo): HookPayload => bashPayload(command, { cwd }) as unknown as HookPayload;
const judge = (command: string, cwd = repo, env = ENV()): Verdict => decide(ctx('pre-bash', agentBash(command, cwd), env));
const reasonOf = (v: Verdict): string => ('reason' in v ? v.reason : 'text' in v ? v.text : '');

function verdicts(kind: Verdict['kind'], commands: string[], cwd = repo, env = ENV()): void {
  for (const c of commands) {
    const v = judge(c, cwd, env);
    assert.equal(v.kind, kind, `${kind} expected for: ${c}\n${reasonOf(v)}`);
  }
}

before(() => {
  seedRepo(repo); seedRepo(copy); seedRepo(padCopy);
  g(repo, 'worktree', 'add', '-q', at('wt'), '-b', 'side');
  writeFileSync(join(at('wt'), 'src', 'b.ts'), 'export const b = 9;\n');
  mkdirSync(at('head', 'src'), { recursive: true }); mkdirSync(at('backup'), { recursive: true });
  writeFileSync(at('head', 'a.ts'), HEAD_A); writeFileSync(at('head', 'src', 'a.ts'), HEAD_A);
  writeFileSync(at('backup', 'a.ts'), ROOT_FIX);
  writeFileSync(at('head', 's.ts'), 'export const s = 1;\n');
  writeFileSync(at('backup', 'q1.ts'), Q1);
  seedRepo(repo2);
  mkdirSync(join(repo, 'node_modules', 'dep', '.git'), { recursive: true });
  symlinkSync(at('wt'), join(repo, 'lnk'));
  mkdirSync(at('old'), { recursive: true }); writeFileSync(at('old', 'e.ts'), 'export const e = 0;\n');
  writeFileSync(join(repo, '.git', 'info', 'exclude'), '.wt/\n');
  g(repo, 'worktree', 'add', '-q', join(repo, '.wt', 'inner'), '-b', 'inner');
  writeFileSync(join(repo, '.wt', 'inner', 'src', 'b.ts'), 'export const b = 7; // a session works here\n');
  const diff = spawnSync('git', ['diff', '--', 'src/a.ts'], { cwd: repo, encoding: 'utf8', env: GIT_ENV }).stdout;
  writeFileSync(at('fix.diff'), diff);
  mkdirSync(join(sb.home, '.claude', 'env'), { recursive: true });
  writeFileSync(join(sb.home, '.claude', 'env', 'paths.sh'), `export APP_TREES='${sb.dir}'\n`);
  writeConfig({ shellPaths: { file: '.claude/env/paths.sh', vars: ['APP_TREES'] } });
});

describe(NAME, () => {
  it('denies every restore of a dirty file in a protected repository — the 19.09 verifier form and its git equivalents', () => {
    verdicts('deny', [
      'git checkout -- src/a.ts', 'git checkout src/a.ts', 'git checkout HEAD -- src/a.ts', 'git checkout -- .',
      'git restore src/a.ts', 'git restore --source=HEAD --staged --worktree src/s.ts', 'git restore -SW src/s.ts',
      'git reset --hard', 'git reset --merge HEAD', 'git checkout -f', 'git rm -f src/a.ts', 'git clean -fd', 'git clean -xdf',
      'git -C src checkout -- a.ts', 'cd src && git checkout -- a.ts', 'bash -c "git checkout -- src/a.ts"',
    ]);
  });

  it('expands unquoted braces before asking git — the 19.09 pair restored by one checkout is denied, not read as a missing path', () => {
    verdicts('deny', ['git checkout HEAD -- src/{a,c}.ts', 'git checkout -- src/{a..c}.ts', 'rm src/{a,b}.ts', 'git checkout -- src/*.ts']);
    verdicts('silent', ['git checkout -- "src/{a,c}.ts"', 'git checkout -- src/{b,x}.ts']);
  });

  it('denies committed content written over a dirty file whatever carries it — the 05.10 cp form, redirects, tee, cat, recursive copies', () => {
    verdicts('deny', [
      `cp ${at('head', 'a.ts')} src/a.ts`, `cp ${at('head', 'a.ts')} src/`, `install -m 644 ${at('head', 'a.ts')} src/a.ts`,
      `cp -R ${at('head', 'src')} .`, `ditto ${at('head', 'src')} src`, `rsync -a ${at('head', 'src')}/ src`,
      'git show HEAD:src/a.ts > src/a.ts', 'git --no-pager show HEAD:src/a.ts | tee src/a.ts >/dev/null', 'git cat-file -p HEAD:src/c.ts > src/c.ts',
      `cat ${at('head', 'a.ts')} > src/a.ts`,
    ]);
  });

  it('lets a backup back over a dirty file and a dirty file out to a backup — content that is not HEAD is a restore, not a revert', () => {
    verdicts('silent', [
      `cp ${at('backup', 'a.ts')} src/a.ts`, `cp src/a.ts ${at('backup', 'a2.ts')}`, `cp ${at('head', 'a.ts')} src/b.ts`,
      `cat ${at('backup', 'a.ts')} > src/a.ts`, "sed -i '' 's/2/3/' src/a.ts", 'npm run gen > src/a.ts',
    ]);
  });

  it('denies removing a dirty file or carrying it out of its repository, and passes the same for clean and untracked files', () => {
    verdicts('deny', ['rm src/a.ts', 'rm -rf src', 'unlink src/c.ts', `mv src/a.ts ${at('backup', 'moved.ts')}`, `git worktree remove --force ${at('wt')}`]);
    verdicts('silent', ['rm src/b.ts', 'rm -f src/u.ts', 'rm src', 'mv src/a.ts src/a2.ts', `git worktree remove ${at('wt')}`]);
  });

  it('denies a reverse patch over dirty files, asks about a forward one, and passes read-only patch modes', () => {
    verdicts('deny', [`git apply -R ${at('fix.diff')}`, `patch -R -p1 < ${at('fix.diff')}`, 'git diff | git apply -R']);
    verdicts('unknown', [`git apply ${at('fix.diff')}`]);
    verdicts('silent', [`git apply -R --check ${at('fix.diff')}`, `git apply --stat ${at('fix.diff')}`, `patch -R --dry-run -p1 < ${at('fix.diff')}`]);
  });

  it('denies every stash form but list and show, in any tree — refs/stash is shared by all worktrees of the session', () => {
    verdicts('deny', ['git stash', 'git stash push -m wip', 'git stash -u', 'git stash pop', 'git stash drop', 'git stash clear']);
    verdicts('deny', ['git stash', 'git stash pop'], copy);
    verdicts('silent', ['git stash list', 'git stash show -p']);
  });

  it('passes clean files, index-only restores, dry runs and branch switches without force (I4)', () => {
    verdicts('silent', [
      'git checkout -- src/b.ts', 'git checkout HEAD~0 -- src/b.ts', 'git restore --staged src/a.ts', 'git clean -n', 'git clean -fX',
      'git rm --cached -f src/a.ts', 'git status', 'git diff', 'git show HEAD:src/a.ts', `git show HEAD:src/a.ts > ${at('backup', 'base.ts')}`,
      'git checkout -b feature', 'git reset --soft HEAD', 'git log --format=%H -- src/a.ts',
    ]);
  });

  it('passes the scratch area for everything but stash: the copy the deny message names stays open (I3)', () => {
    verdicts('silent', ['git checkout -- src/a.ts', 'git reset --hard', `cp ${at('head', 'a.ts')} src/a.ts`, 'rm src/a.ts'], copy);
    assert.equal(decide(ctx('pre-bash', agentBash('git checkout -- src/a.ts', padCopy, { scratchpad_dir: pad }))).kind, 'silent', 'scratchpad_dir from the payload is a scratch area');
    assert.equal(judge('git checkout -- src/a.ts', padCopy).kind, 'deny', 'without the payload field the same tree is protected');
  });

  it('is silent for the root session on every command it denies to an agent (I2)', () => {
    for (const c of ['git checkout -- src/a.ts', 'git stash', `cp ${at('head', 'a.ts')} src/a.ts`, 'rm src/a.ts', 'git show HEAD:src/a.ts > src/a.ts']) {
      assert.equal(decide(ctx('pre-bash', rootBash(c))).kind, 'silent', c);
    }
  });

  it('resolves $VAR paths through shellPaths of the site config instead of answering unknown — the hook env has no such variable', () => {
    verdicts('deny', ['cd "$APP_TREES/repo" && git checkout -- src/a.ts', 'git -C "$APP_TREES/repo" restore src/a.ts'], at());
  });

  it('answers unknown, never silent, where the target cannot be known before the run (I6)', () => {
    verdicts('unknown', [
      'git checkout -- "$(cat list.txt)"', 'cd "$NOPE" && git checkout -- src/a.ts', 'git --work-tree=/x checkout -- src/a.ts',
      'GIT_WORK_TREE=/x git checkout -- src/a.ts', "cat <<'EOF' | bash\ngit checkout -- src/a.ts\nEOF",
      `git diff > ${at('fresh.diff')} && git apply -R ${at('fresh.diff')}`, 'xargs git checkout -- < list.txt',
      'find src -name "*.ts" -exec git checkout -- {} \\;', `cp "$(mktemp)" src/a.ts`,
    ]);
  });

  it('turns unknown into a note at rollout stage one and stays a deny on proven destruction; enabled:false switches it off', () => {
    writeConfig({ shellPaths: { file: '.claude/env/paths.sh', vars: ['APP_TREES'] }, agentRevert: { unknown: 'note' } });
    try {
      assert.equal(judge('git checkout -- "$(cat list.txt)"').kind, 'context');
      assert.equal(judge('git checkout -- src/a.ts').kind, 'deny');
      writeConfig({ agentRevert: { enabled: false } });
      assert.equal(judge('git checkout -- src/a.ts').kind, 'silent');
    } finally { writeConfig({ shellPaths: { file: '.claude/env/paths.sh', vars: ['APP_TREES'] } }); }
  });

  it('closes the forms race-auditor found silent: empty pathspec under force, a -fb cluster, -p with piped answers, a glob read from git -C', () => {
    verdicts('deny', [
      'git checkout -f HEAD --', 'git checkout -f --', 'git checkout -fb tmp-branch', 'yes | git checkout -p -- src/a.ts',
      "printf 'a\\n' | git restore -p src/a.ts", 'git -C pkg checkout -- *.json',
    ]);
  });

  it('denies removing a directory that holds a worktree with changes — the outer status marks it ignored and says nothing', () => {
    verdicts('deny', ['git clean -ffdX', 'git clean -ffdx', 'rm -rf .wt']);
    verdicts('silent', ['git clean -fdX', 'rm -rf dist']);
  });

  it('denies any committed version of the path over an uncommitted change, a staged-only fix included — the next git add would lose it', () => {
    verdicts('deny', [
      `cp ${at('old', 'e.ts')} src/e.ts`, 'git show HEAD:src/a.ts | cat > src/a.ts', `cat < ${at('head', 'a.ts')} > src/a.ts`,
      `tee src/a.ts < ${at('head', 'a.ts')}`, `cp ${at('head', 's.ts')} src/s.ts`,
      "cat > src/a.ts <<'EOF'\nexport const a = 1;\nEOF", "tee src/a.ts >/dev/null <<'EOF'\nexport const a = 1;\nEOF",
    ]);
    verdicts('silent', ['git stash create', "cat > src/a.ts <<'EOF'\nexport const a = 3;\nEOF"]);
  });

  it('lets an agent bring back the staged fix of the root over its own debug edit — the index is no history of the path', () => {
    verdicts('silent', [`cp ${at('backup', 'q1.ts')} src/q.ts`]);
  });

  it('closes what round two of race-auditor found: -p with no pathspec, a stash push named create, clean -ff over a repository without nested trees', () => {
    verdicts('deny', ['yes | git checkout -p', 'yes | git restore -p', 'yes | git checkout -p HEAD', 'git stash -m create']);
    verdicts('silent', ['git clean -ffdX', 'git clean -ff src/a.ts'], repo2);
    verdicts('silent', ['rm -rf node_modules', 'rm -rf lnk']);
  });

  it('lets a committed revision reach a clean file — committed content is not lost, and lockfile resets are real work', () => {
    verdicts('silent', ['git restore -s HEAD~1 src/d.ts', 'git checkout HEAD~1 -- src/d.ts', 'git checkout HEAD~1 src/d.ts']);
  });

  it('answers unknown for a work tree set by export earlier in the command and for a copy from stdin over a change', () => {
    verdicts('unknown', ['export GIT_WORK_TREE=/x; git checkout -- src/a.ts', 'cp /dev/stdin src/a.ts']);
  });

  it('reads a path in another case as the file it names on a case-insensitive disk', { skip: !existsSync(join(repo, 'SRC', 'A.TS')) && 'case-sensitive file system' }, () => {
    verdicts('deny', ['rm SRC/A.TS', `cp ${at('head', 'a.ts')} SRC/A.TS`]);
  });

  it('counts a judged call that stays silent, so the rollout share of unknown has a denominator', () => {
    judge('git checkout -- src/b.ts');
    const st = State.open(sb.stateDir);
    try {
      const n = (st.db.prepare("SELECT count(*) AS n FROM agent_revert_events WHERE kind = 'silent' AND op = 'git checkout'").get() as { n: number }).n;
      assert.ok(n >= 1, 'a silent judged call left no row');
    } finally { st.close(); }
  });

  it('names the files, the incident and both right paths in the deny', () => {
    const r = reasonOf(judge('git checkout -- src/a.ts src/c.ts'));
    for (const part of ['src/a.ts', 'src/c.ts', 'INC-SUBAGENT-REVERTS-WORKING-FILES', 'git worktree add', 'Edit/Write']) assert.ok(r.includes(part), `${part} missing from: ${r}`);
  });
});

describe(`${NAME} on Write and Edit`, () => {
  const write = (file: string, content: string, agent = 'agent-w'): Verdict =>
    decide(ctx('pre-write', payload('PreToolUse', { tool_name: 'Write', tool_input: { file_path: join(repo, file), content }, tool_use_id: 't', cwd: repo, agent_id: agent }) as unknown as HookPayload));
  const edit = (file: string, from: string, to: string, agent = 'agent-w'): Verdict =>
    decide(ctx('pre-write', payload('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: join(repo, file), old_string: from, new_string: to }, tool_use_id: 't', cwd: repo, agent_id: agent }) as unknown as HookPayload));
  function snapshot(agent: string, dirty: string[]): void {
    const st = State.open(sb.stateDir);
    try {
      const snap = { [repo]: Object.fromEntries(dirty.map((d) => [d, 'digest'])) };
      st.db.prepare('INSERT OR REPLACE INTO agent_window(session_id, agent_id, agent_type, started_at, stopped_at, snapshot) VALUES(?,?,?,?,NULL,?)')
        .run('session-1', agent, 'general-purpose', 1, JSON.stringify(snap));
    } finally { st.close(); }
  }

  it('denies Write and Edit that turn a file back into HEAD when the change was there before the agent started (I10)', () => {
    snapshot('agent-w', ['src/a.ts', 'src/c.ts']);
    assert.equal(write('src/a.ts', HEAD_A).kind, 'deny');
    assert.equal(edit('src/a.ts', ROOT_FIX, HEAD_A).kind, 'deny');
  });

  function wrote(agent: string, file: string, since: number | null = null): void {
    const st = State.open(sb.stateDir);
    try {
      st.db.exec('CREATE TABLE IF NOT EXISTS tool_write(session_id TEXT, writer TEXT, repo TEXT, path TEXT, digest TEXT, at INTEGER, since INTEGER, PRIMARY KEY(session_id, writer, repo, path, at))');
      st.db.prepare('INSERT INTO tool_write(session_id, writer, repo, path, digest, at, since) VALUES(?,?,?,?,?,?,?)').run('session-1', agent, repo, file, windowDigest(join(repo, file)), 5, since);
    } finally { st.close(); }
  }

  it('denies the revert of a change made after the agent started by someone else — clean at start is not authorship', () => {
    snapshot('agent-late', ['src/c.ts']);
    assert.equal(write('src/a.ts', HEAD_A, 'agent-late').kind, 'deny');
  });

  it('takes no Bash-attributed write as authorship, only the agent\'s own Write or Edit', () => {
    snapshot('agent-bash', ['src/c.ts']);
    wrote('agent-bash', 'src/a.ts', 5);
    assert.equal(write('src/a.ts', HEAD_A, 'agent-bash').kind, 'deny');
  });

  it('lets an agent write back the root\'s staged fix over its own debug edit through Write and Edit', () => {
    snapshot('agent-dbg', ['src/q.ts', 'src/c.ts']);
    assert.equal(decide(ctx('pre-write', payload('PreToolUse', { tool_name: 'Write', tool_input: { file_path: join(repo, 'src/q.ts'), content: Q1 }, tool_use_id: 't', cwd: repo, agent_id: 'agent-dbg' }) as unknown as HookPayload)).kind, 'silent');
    assert.equal(decide(ctx('pre-write', payload('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: join(repo, 'src/q.ts'), old_string: "console.log('agent debug');\n", new_string: '' }, tool_use_id: 't', cwd: repo, agent_id: 'agent-dbg' }) as unknown as HookPayload)).kind, 'silent');
  });

  it('lets an agent undo its own change — clean in its start snapshot and its own last write — and passes content that is not HEAD', () => {
    snapshot('agent-own', ['src/c.ts']);
    wrote('agent-own', 'src/a.ts');
    assert.equal(write('src/a.ts', HEAD_A, 'agent-own').kind, 'silent');
    snapshot('agent-w', ['src/a.ts']);
    assert.equal(write('src/a.ts', 'export const a = 3;\n').kind, 'silent');
    assert.equal(edit('src/a.ts', 'no such text', HEAD_A).kind, 'silent');
  });

  it('answers unknown when no start snapshot covers the repository, and stays silent for the root', () => {
    assert.equal(write('src/a.ts', HEAD_A, 'agent-without-window').kind, 'unknown');
    const root = payload('PreToolUse', { tool_name: 'Write', tool_input: { file_path: join(repo, 'src/a.ts'), content: HEAD_A }, cwd: repo });
    assert.equal(decide(ctx('pre-write', root as unknown as HookPayload)).kind, 'silent');
  });
});

describe(`${NAME} delivery`, () => {
  it('speaks from the shim observe mode alone: route() under HARNESS_OBSERVE=1 keeps its deny and silences every other gate', async () => {
    const other = GATES.find((x) => !x.observe && x.events.includes('pre-bash') && x.name !== NAME) as (typeof GATES)[number];
    const original = other.run;
    other.run = () => ({ kind: 'deny', reason: 'other gate', gate: other.name });
    try {
      const env = { ...ENV(), CLAUDE_STATE_DIR: sb.stateDir, HARNESS_ROOT };
      const observed = await route('pre-bash', agentBash('ls src'), { ...env, HARNESS_OBSERVE: '1' });
      assert.equal(observed.kind, 'silent', 'a gate without observe spoke from the observe mode');
      const denied = await route('pre-bash', agentBash('git checkout -- src/a.ts'), { ...env, HARNESS_OBSERVE: '1' });
      assert.equal(denied.kind, 'deny');
      assert.ok(reasonOf(denied).startsWith(NAME), reasonOf(denied));
      assert.equal((await route('pre-bash', agentBash('ls src'), env)).kind, 'deny', 'outside the observe mode every gate still speaks');
    } finally { other.run = original; }
  });

  it('ignores an inherited HARNESS_OBSERVE: the root keeps every gate, it is no kill switch outside the CLAUDE_SKIP_* registry', () => {
    const env = { CLAUDE_HARNESS_NODE: process.execPath, CLAUDE_HARNESS_CONFIG: cfgPath, HARNESS_OBSERVE: '1' };
    const r = runHook('pre-bash', rootBash('echo x > harness/owner/pre-push-exceptions.json'), sb, env, { path: process.env.PATH });
    assert.equal(r.rc, 2, `owner-files was silenced by an inherited HARNESS_OBSERVE: ${r.stderr}`);
    assert.match(r.stderr, /owner-files/);
  });

  it('reaches the agent through bin/hook without a trigger word, and the root command passes the same shim (I7)', () => {
    const env = { CLAUDE_HARNESS_NODE: process.execPath, CLAUDE_HARNESS_CONFIG: cfgPath, HARNESS_SCRATCH_DEFAULTS: scratch };
    const agent = runHook('pre-bash', agentBash('git checkout -- src/a.ts'), sb, env, { path: process.env.PATH });
    assert.equal(agent.rc, 2, agent.stderr);
    assert.match(agent.stderr, /agent-revert/);
    const root = runHook('pre-bash', rootBash('git checkout -- src/a.ts'), sb, env, { path: process.env.PATH });
    assert.deepEqual([root.rc, root.stdout], [0, '']);
    assert.equal(readFileSync(join(repo, 'src', 'a.ts'), 'utf8'), ROOT_FIX, 'the gate itself changed the tree');
  });
});

describe('expandWord', () => {
  it('pads a range the way zsh does when an end carries a leading zero, and keeps a plain range unpadded', () => {
    assert.deepEqual(expandWord('part{01..03}.ts', {}, null, { glob: false }), ['part01.ts', 'part02.ts', 'part03.ts']);
    assert.deepEqual(expandWord('p{8..10}', {}, null, { glob: false }), ['p8', 'p9', 'p10']);
  });
});
