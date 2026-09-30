// Silently broke: the Stop hook read commits of toplevel(cwd) only — a session opened in one repository that
// committed in two others through `cd` in Bash left those commits out of the journal. It also handed every
// unjournaled commit reachable from cwd to whichever session stopped first: a fresh worktree off main took
// main's backlog, a merge took the merged branch.
// INVARIANT: every commit of the git user in a root any session touched reaches the journal exactly once;
// `attribution: session` names the one session whose git call named that worktree while HEAD became the commit, and
// no other session had a git call there then; nothing is decided before every post that could cover the move has landed.
// git reads the wall clock (`--since`, reflog stamps of fast-forwards), so time is anchored once per file.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, payload, HARNESS_ROOT, onlyGate } from '../_env.ts';
import { initRepo, commit, sh } from './_git.ts';
import { adopt, attribute, creates, decide, finishPass, journalPath, parseReflog, DEFER_MS, GRACE_MS } from '../../src/session/capture-commits.ts';
import { collectRoots } from '../../src/sweep.ts';
import { callIntent, expandPathVar } from '../../src/commit-evidence.ts';
import { shortHash } from '../../src/session/common.ts';
import { State } from '../../src/state.ts';
import { route } from '../../src/main.ts';
import { WHITELIST } from '../../src/journal.ts';
import type { Attribution, Decision, Evidence } from '../../src/session/capture-commits.ts';
import type { GateContext } from '../../src/types.ts';

process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const ANCHOR_S = Math.floor(Date.now() / 1000) - 3 * 86_400;
type Sb = ReturnType<typeof sandbox>;
interface Row { session: string | null; attribution: Attribution; candidates?: string[]; commit_hash: string; repo_hash: string }

function stopCtx(sb: Sb, session: string, cwd: string, nowMs: number): GateContext {
  return { event: 'stop', payload: payload('Stop', { session_id: session }, cwd) as never, env: { HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir }, root: HARNESS_ROOT, stateDir: sb.stateDir, now: () => nowMs };
}
function rows(sb: Sb): Row[] { const p = journalPath(sb.home); return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Row) : []; }
function lineOf(sb: Sb, hash: string): Array<[string | null, Attribution, string[] | undefined]> { return rows(sb).filter((r) => r.commit_hash === hash).map((r) => [r.session, r.attribution, r.candidates]); }
/** A cwd that exists and is no repository: a Stop of a session that works elsewhere. */
function plainCwd(sb: Sb): string { const d = join(sb.dir, 'plain-cwd'); mkdirSync(d, { recursive: true }); return d; }
function top(dir: string): string { return sh(dir, 'git', ['rev-parse', '--show-toplevel']).trim(); }
function gitPath(dir: string, p: string): string { return sh(dir, 'git', ['rev-parse', '--path-format=absolute', '--git-path', p]).trim(); }

function withState<T>(sb: Sb, fn: (st: State) => T): T { const st = State.open(sb.stateDir); try { return fn(st); } finally { st.close(); } }
/** Evidence the tree sweep writes on post: a call of `session` ran from `fromS` to `toS` while HEAD of `repo` moved. */
function covered(sb: Sb, repo: string, session: string, fromS: number, toS: number, named = true): void {
  withState(sb, (st) => st.db.prepare('INSERT INTO head_moves(repo, session_id, started_at, ended_at, named) VALUES(?,?,?,?,?)').run(top(repo), session, fromS * 1000, toS * 1000, named ? 1 : 0));
}
function forget(sb: Sb, session: string): void { withState(sb, (st) => st.db.prepare('DELETE FROM head_moves WHERE session_id = ?').run(session)); }
function headMoves(sb: Sb, session: string): Array<[string, number]> {
  return withState(sb, (st) => (st.db.prepare('SELECT repo, named FROM head_moves WHERE session_id = ? ORDER BY repo').all(session) as { repo: string; named: number }[]).map((r) => [r.repo, r.named]));
}

async function post(sb: Sb, session: string, cwd: string, tool: { tool_name: string; tool_input: Record<string, unknown> }, id: string, durationMs: number, env: Record<string, string> = {}): Promise<void> {
  const base = { HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, HARNESS_ROOT, PATH: process.env.PATH ?? '', ...onlyGate('sweep'), ...env };
  await route('post', payload('PostToolUse', { session_id: session, ...tool, tool_use_id: id, duration_ms: durationMs }, cwd) as never, base);
}

describe('attribute', () => {
  const T = 1_000_000_000_000;
  const settled = T + DEFER_MS;
  const ev = (session: string, named = true): Evidence => ({ session, named });
  const cases: Array<[string, Evidence[], number, Decision]> = [
    ['one session named the worktree, before every post could land', [ev('A')], settled - 1, { write: false, dueAt: settled, kind: 'made', movedAt: T }],
    ['one session named the worktree and nobody else was there', [ev('A')], settled, { write: true, attribution: 'session', session: 'A' }],
    ['one session named it and another only knew it — the other may be the maker behind `cd "$VAR"`', [ev('S', false), ev('A')], settled, { write: true, attribution: 'overlapping', session: null, candidates: ['A', 'S'] }],
    ['two sessions named it', [ev('B'), ev('A'), ev('B')], settled, { write: true, attribution: 'overlapping', session: null, candidates: ['A', 'B'] }],
    ['only a session that knew the worktree without naming it', [ev('S', false)], settled, { write: true, attribution: 'window', session: null, candidates: ['S'] }],
    ['nobody, while a post may still land', [], settled - 1, { write: false, dueAt: settled, kind: 'made', movedAt: T }],
    ['nobody, settled', [], settled, { write: true, attribution: 'window', session: null }],
  ];
  for (const [name, evidence, now, want] of cases) it(`decides when ${name}`, () => assert.deepEqual(attribute(evidence, T, now), want));
});

describe('adopt', () => {
  it('waits a day for the creating worktree before writing a commit this root did not create, then writes it as window', () => {
    assert.deepEqual(adopt(1_000_000, 1_000_000 + GRACE_MS - 1), { write: false, dueAt: 1_000_000 + GRACE_MS, kind: 'adopt', movedAt: 1_000_000 });
    assert.deepEqual(adopt(1_000_000, 1_000_000 + GRACE_MS), { write: true, attribution: 'window', session: null });
  });
});

describe('creates', () => {
  const cases: Array<[string, boolean]> = [
    ['commit: SUBJ-x', true], ['commit (initial): SUBJ-x', true], ['commit (amend): SUBJ-x', true], ['commit (merge): SUBJ-x', true],
    ['cherry-pick: SUBJ-x', true], ['revert: SUBJ-x', true], ['rebase (pick): SUBJ-x', true], ['rebase (continue): SUBJ-x', true],
    ['rebase -i (squash): SUBJ-x', true], ["merge feat: Merge made by the 'ort' strategy.", true],
    ['merge feat: Fast-forward', false], ['pull: Fast-forward', false], ['checkout: moving from main to feat', false],
    ['reset: moving to HEAD~1', false], ['rebase (finish): returning to refs/heads/feat', false], ['rebase (start): checkout main', false],
    ['commit: Merge made by hand', true], ['branch: Created from HEAD', false],
    ['pull -q --rebase (pick): SUBJ-x', true], ['pull (pick): SUBJ-x', true], ['rebase (merge): SUBJ-x', true],
    ['cherry-pick: fast-forward', false], ['rebase (abort): returning to refs/heads/x', false],
  ];
  for (const [message, want] of cases) it(`reads «${message}» as ${want ? 'a creation' : 'a move'}`, () => assert.equal(creates(message), want));
});

describe('finishPass', () => {
  it('keeps a commit a neighbour deferred during this pass and never moves the marker back', () => {
    const sb2 = sandbox('harness-commits-finish-');
    const st = State.open(sb2.stateDir);
    try {
      st.db.prepare("INSERT INTO pending_commits(repo, hash, due_at, kind, moved_at, common) VALUES('/r', 'c2', 9, 'made', 1, '/r/.git')").run();
      st.setMarker('k', 'T2', 2);
      finishPass(st, { root: '/r', key: 'k', markerBefore: 'T1', token: 'T1', pendingBefore: [], decisions: new Map(), common: null, now: 3 });
      assert.deepEqual((st.db.prepare('SELECT hash FROM pending_commits').all() as { hash: string }[]).map((r) => r.hash), ['c2'], 'a stale pass erased a deferral it never saw — nobody writes that commit a day later');
      assert.equal(st.marker('k'), 'T2', 'a stale pass moved the marker back');
    } finally { st.close(); sb2.cleanup(); }
  });
});

describe('parseReflog', () => {
  it('takes a creating entry at committer time as the creation; a later move, or a fast-forward in the same second, as not one', () => {
    const a = 'a'.repeat(40); const b = 'b'.repeat(40); const c = 'c'.repeat(40);
    const d = 'd'.repeat(40);
    const out = [`${a}\x1fHEAD@{1000}\x1f1000\x1fcommit: SUBJ-a`, `${b}\x1fHEAD@{2000}\x1f1500\x1fcheckout: moving`, `${c}\x1fHEAD@{3003}\x1f3000\x1fcherry-pick: SUBJ-c`, `${d}\x1fHEAD@{4000}\x1f4000\x1fmerge feat: Fast-forward`].join('\n');
    const { entries, made } = parseReflog(out);
    assert.equal(entries, 4);
    assert.deepEqual([...made.entries()], [[a, 1_000_000], [c, 3_003_000]], 'a fast-forward in the same second as its commit was taken for the creation');
  });
});

describe('expandPathVar', () => {
  const env = { W: '/work/trees', REL: 'trees', HOME: '/home/u' };
  const cases: Array<[string, string]> = [['$W/wms', '/work/trees/wms'], ['${W}/wms', '/work/trees/wms'], ['$W', '/work/trees'], ['$NOPE/wms', '$NOPE/wms'], ['$REL/wms', '$REL/wms'], ['$W-x', '$W-x'], ['a$W', 'a$W'], ['~/repo', '/home/u/repo'], ['~', '/home/u'], ['~other/x', '~other/x']];
  for (const [token, want] of cases) it(`reads ${token} as ${want}`, () => assert.equal(expandPathVar(token, env), want));
});

describe('callIntent', () => {
  const env = { HOME: '/home/u', W: '/work' };
  const cases: Array<[string, { proof: string[]; presence: string[]; opaque: boolean }]> = [
    ['cd /w && git commit -m x', { proof: ['/w'], presence: [], opaque: false }],
    ['git -C /w merge --no-ff x', { proof: ['/w'], presence: [], opaque: false }],
    ['cd /w; cd sub && git -c a=b commit', { proof: ['/w/sub'], presence: [], opaque: false }],
    ['cd "$W/app" && git rebase main', { proof: ['/work/app'], presence: [], opaque: false }],
    ['git status && git log -1 && ls /w', { proof: [], presence: [], opaque: false }],
    ['git ci -m x', { proof: [], presence: ['/cwd'], opaque: false }],
    ['npm test', { proof: [], presence: ['/cwd'], opaque: false }],
    ["bash -lc 'cd /w && git commit'", { proof: ['/w'], presence: ['/cwd', '/w'], opaque: false }],
    ["bash -lc 'cd /w' && git commit", { proof: ['/cwd'], presence: ['/cwd', '/w'], opaque: false }],
    ['(cd /w && git commit); git commit', { proof: ['/w', '/cwd'], presence: [], opaque: false }],
    ['test -d /w && cd /w; git commit', { proof: [], presence: [], opaque: true }],
    ["python3 -c \"import os; os.system('cd /w && git commit')\"", { proof: [], presence: ['/cwd', '/w'], opaque: false }],
    ['cd "$UNSET/x" && git commit', { proof: [], presence: [], opaque: true }],
    ['git -C "$UNSET" commit', { proof: [], presence: [], opaque: true }],
    ['find /w -name x', { proof: [], presence: [], opaque: false }],
    ['find /w -exec git commit \\;', { proof: [], presence: ['/cwd', '/w'], opaque: false }],
  ];
  for (const [command, want] of cases) it(`reads «${command}»`, () => assert.deepEqual(callIntent(command, '/cwd', env), want));
});

describe('capture-commits across session roots', () => {
  const sb = sandbox('harness-commits-roots-');
  after(() => sb.cleanup());

  async function wmsCommit(name: string, command: (dir: string) => string, env: Record<string, string> = {}): Promise<{ home: string; hash: string }> {
    const home = initRepo(join(sb.dir, `${name}-brain`)); commit(home, 'spec.md', `${name}\n`);
    const wms = initRepo(join(sb.dir, name)); commit(wms, 'base.txt', `${name} base\n`);
    writeFileSync(join(wms, 'feature.txt'), 'draft\n');
    await post(sb, name, home, { tool_name: 'Edit', tool_input: { file_path: join(wms, 'feature.txt') } }, `${name}-edit`, 0);
    forget(sb, name); // within one reflog second the Edit window would cover the commit too; only the Bash call may
    const hash = commit(wms, 'feature.txt', 'feature\n', 'SUBJ-packing by scan');
    await post(sb, name, home, { tool_name: 'Bash', tool_input: { command: `${command(wms)} && git commit -qam feat` } }, `${name}-bash`, 60_000, env);
    return { home, hash };
  }

  it('writes the commit the session made in a second repository it named, as its own, at the next Stop', async () => {
    const { home, hash } = await wmsCommit('abs', (dir) => `cd ${dir}`);
    assert.equal(decide(stopCtx(sb, 'abs', home, Date.now())).kind, 'silent');
    assert.deepEqual(lineOf(sb, hash), [], 'decided before every post that could cover the commit had landed');
    assert.equal(decide(stopCtx(sb, 'abs', home, Date.now() + DEFER_MS)).kind, 'silent');
    assert.deepEqual(lineOf(sb, hash), [['abs', 'session', undefined]], 'a commit in a foreign root of the session never reached the journal — the report for the session would be missing it');
    const before = rows(sb).length;
    assert.equal(decide(stopCtx(sb, 'abs', home, Date.now() + DEFER_MS)).kind, 'silent');
    assert.equal(rows(sb).length, before, 'a repeated Stop appended a second line for the same commits');
  });

  it('reads `cd "$VAR/…"` through the hook environment: with the variable set the call names the worktree', async () => {
    const { home, hash } = await wmsCommit('var', (dir) => `cd "$TREES/${dir.split('/').pop()}"`, { TREES: sb.dir });
    decide(stopCtx(sb, 'var', home, Date.now() + DEFER_MS));
    assert.deepEqual(lineOf(sb, hash), [['var', 'session', undefined]]);
  });

  it('keeps a commit behind a variable the hook cannot see unproven: known root, window, the session as candidate', async () => {
    const { home, hash } = await wmsCommit('hidden', (dir) => `cd "$TREES_UNSET/${dir.split('/').pop()}"`);
    decide(stopCtx(sb, 'hidden', home, Date.now() + DEFER_MS));
    assert.deepEqual(lineOf(sb, hash), [[null, 'window', ['hidden']]], 'evidence of a known root was read as proof, or the commit was lost');
  });

  it('writes a merge made with `git -C` in a clean repository the session never edited', async () => {
    const cwd = initRepo(join(sb.dir, 'cwd-m'));
    const rel = initRepo(join(sb.dir, 'release'));
    commit(rel, 'base', 'release base\n');
    sh(rel, 'git', ['checkout', '-q', '-b', 'fix']);
    commit(rel, 'fix', 'fix\n', 'SUBJ-fix');
    sh(rel, 'git', ['checkout', '-q', 'main']);
    sh(rel, 'git', ['merge', '-q', '--no-ff', '-m', 'SUBJ-merge fix', 'fix']);
    const merge = sh(rel, 'git', ['rev-parse', 'HEAD']).trim();
    await post(sb, 'M', cwd, { tool_name: 'Bash', tool_input: { command: `git -C ${rel} merge --no-ff fix` } }, 'm-bash', 60_000);
    decide(stopCtx(sb, 'M', cwd, Date.now() + DEFER_MS));
    assert.deepEqual(lineOf(sb, merge), [['M', 'session', undefined]], 'a clean repository touched only by git -C stayed invisible to the journal');
  });

  it('takes a worktree under <repo>/.claude/worktrees named in Bash as a place of work, not as own config', async () => {
    const cwd = initRepo(join(sb.dir, 'cwd-c'));
    const wt = initRepo(join(sb.dir, 'brain', '.claude', 'worktrees', 'x'));
    commit(wt, 'f', 'x\n');
    await post(sb, 'C', cwd, { tool_name: 'Bash', tool_input: { command: `cd ${wt} && git commit -qm x` } }, 'c-bash', 60_000);
    assert.deepEqual(headMoves(sb, 'C').filter(([r]) => r === top(wt)), [[top(wt), 1]]);
  });

  it('takes no evidence from a read, and only presence — never proof — from a command that could have run git unseen', async () => {
    const w = initRepo(join(sb.dir, 'build')); commit(w, 'f', 'build\n');
    await post(sb, 'READ', w, { tool_name: 'Bash', tool_input: { command: 'git status --short && ls' } }, 'r-bash', 60_000);
    assert.deepEqual(headMoves(sb, 'READ'), [], 'a read that ran beside a commit became evidence about who made it');
    await post(sb, 'BUILD', w, { tool_name: 'Bash', tool_input: { command: 'npm run build' } }, 'b-bash', 60_000);
    assert.deepEqual(headMoves(sb, 'BUILD'), [[top(w), 0]], 'a build that could have committed was read as proof, or was not seen at all');
  });

  it('does not name a bystander whose read ran in the worktree while a wrapped commit the parser cannot open moved HEAD', async () => {
    const w = initRepo(join(sb.dir, 'wrapped')); commit(w, 'base', 'wrapped base\n');
    const elsewhere = initRepo(join(sb.dir, 'wrapped-cwd'));
    const c = commit(w, 'f', 'wrapped\n', 'SUBJ-wrapped');
    await post(sb, 'WRAPPER', elsewhere, { tool_name: 'Bash', tool_input: { command: `python3 -c "import os; os.system('cd ${w} && git commit -qam feat')"` } }, 'wr-bash', 60_000);
    await post(sb, 'BYSTANDER', w, { tool_name: 'Bash', tool_input: { command: 'git status --short' } }, 'by-bash', 60_000);
    decide(stopCtx(sb, 'BYSTANDER', w, Date.now() + DEFER_MS));
    assert.deepEqual(lineOf(sb, c), [[null, 'window', ['WRAPPER']]], 'the session that only read the worktree was named the maker of a commit it never made');
  });

  it('takes no evidence for a known root from a git call whose every path is visible and elsewhere', async () => {
    const x = initRepo(join(sb.dir, 'fetch-x')); commit(x, 'x', 'fetch x\n');
    const w = initRepo(join(sb.dir, 'fetch-w')); commit(w, 'w', 'fetch w\n');
    writeFileSync(join(w, 'w'), 'edited\n');
    await post(sb, 'K', x, { tool_name: 'Edit', tool_input: { file_path: join(w, 'w') } }, 'k-edit', 0);
    commit(w, 'w', 'someone else commits here\n');
    await post(sb, 'K', x, { tool_name: 'Bash', tool_input: { command: `git -C ${x} fetch` } }, 'k-fetch', 60_000);
    assert.deepEqual(headMoves(sb, 'K').filter(([r]) => r === top(w)), [], 'a git call in another repository stood beside a commit in a worktree the session once edited');
  });

  it('keeps a known root whose HEAD did not move during the call out of the evidence', async () => {
    const a = initRepo(join(sb.dir, 'quiet-a')); commit(a, 'x', '1\n');
    const b = initRepo(join(sb.dir, 'quiet-b')); commit(b, 'y', '1\n');
    await post(sb, 'Q', a, { tool_name: 'Edit', tool_input: { file_path: join(b, 'y') } }, 'q-edit', 0);
    const hourAgo = Math.floor(Date.now() / 1000) - 3600;
    for (const r of [a, b]) utimesSync(gitPath(r, 'logs/HEAD'), hourAgo, hourAgo);
    forget(sb, 'Q');
    await post(sb, 'Q', a, { tool_name: 'Bash', tool_input: { command: 'cd "$X" && git status' } }, 'q-bash', 60_000);
    assert.deepEqual(headMoves(sb, 'Q'), [], 'a root with an old HEAD became evidence — any call would then claim every commit made there');
  });

  it('opens the call window before the hook cold start, so a commit at the very start of a call is covered', () => {
    const w = initRepo(join(sb.dir, 'lag')); commit(w, 'x', 'lag\n');
    const moved = statSync(gitPath(w, 'logs/HEAD')).mtimeMs;
    const durationMs = 4000;
    const ctx: GateContext = { event: 'post', payload: payload('PostToolUse', { session_id: 'L', tool_name: 'Bash', tool_input: { command: 'git commit && git push' }, tool_use_id: 'l1', duration_ms: durationMs }, w) as never, env: { HOME: sb.home }, root: HARNESS_ROOT, stateDir: sb.stateDir, now: () => moved + durationMs + 3000 };
    withState(sb, (st) => collectRoots(ctx, st));
    assert.deepEqual(headMoves(sb, 'L'), [[top(w), 1]], 'a commit made in the first second of a call was lost to the time the hook took to start');
  });
});

describe('capture-commits attribution between sessions', () => {
  const sb = sandbox('harness-commits-attr-');
  after(() => sb.cleanup());
  const T = ANCHOR_S;
  const settled = T * 1000 + DEFER_MS;
  const repo = (name: string): { w: string; c: string } => {
    const w = initRepo(join(sb.dir, name)); commit(w, 'base', `${w}\n`, 'base', undefined, T - 100);
    return { w, c: commit(w, 'f', `${name}\n`, 'SUBJ-feat', undefined, T) };
  };

  it('writes a commit under the name of the session that made it, whoever stops first, and only once', () => {
    const { w, c } = repo('w1');
    covered(sb, w, 'MAKER', T - 5, T + 5);
    decide(stopCtx(sb, 'OBSERVER', w, settled));
    decide(stopCtx(sb, 'MAKER', w, settled + 1000));
    assert.deepEqual(lineOf(sb, c), [['MAKER', 'session', undefined]], 'the observer took the commit as its own, or it was written twice');
  });

  it('does not hand the commit to a session whose own git call ran in the worktree while the maker post was still on its way', () => {
    const { w, c } = repo('w2');
    covered(sb, w, 'NEIGHBOUR', T - 10, T + 20);
    decide(stopCtx(sb, 'NEIGHBOUR', w, (T + 30) * 1000));
    assert.deepEqual(lineOf(sb, c), [], 'the commit was settled on the only evidence present before the maker post landed');
    covered(sb, w, 'MAKER2', T - 1, T + 240);
    decide(stopCtx(sb, 'NEIGHBOUR', w, settled));
    assert.deepEqual(lineOf(sb, c), [[null, 'overlapping', ['MAKER2', 'NEIGHBOUR']]], 'one of two sessions with a git call in the worktree was named as the proven maker');
  });

  it('does not settle a commit on the window of a call that only knew the worktree', () => {
    const { w, c } = repo('w2b');
    covered(sb, w, 'SIDE', T - 10, T + 20, false);
    decide(stopCtx(sb, 'SIDE', w, settled));
    assert.deepEqual(lineOf(sb, c), [[null, 'window', ['SIDE']]], 'evidence of a known root was read as proof');
  });

  it('finishes a deferred commit at the Stop of an unrelated session once it is due — its own session may never stop again', () => {
    const { w, c } = repo('w4');
    decide(stopCtx(sb, 'GONE', w, (T + 30) * 1000));
    assert.deepEqual(lineOf(sb, c), [], 'a commit was settled before the post of its maker could land');
    const elsewhere = initRepo(join(sb.dir, 'elsewhere'));
    decide(stopCtx(sb, 'OTHER', elsewhere, settled));
    assert.deepEqual(lineOf(sb, c), [[null, 'window', undefined]], 'the deferred commit waited for a session that is gone');
  });

  it('leaves a commit fast-forwarded in the same second to the worktree that created it, and writes it once', () => {
    const main = initRepo(join(sb.dir, 'm5')); commit(main, 'base', `${main}\n`, 'base', undefined, T - 1000);
    const wt = join(sb.dir, 'w5');
    sh(main, 'git', ['worktree', 'add', '-q', '-b', 'feat', wt], { GIT_COMMITTER_DATE: `@${T - 900} +0000` });
    const c = commit(wt, 'f', 'w5\n', 'SUBJ-feat', undefined, T);
    sh(main, 'git', ['merge', '-q', '--ff-only', 'feat'], { GIT_COMMITTER_DATE: `@${T} +0000` });
    covered(sb, main, 'MERGER', T - 5, T + 5);
    covered(sb, wt, 'AUTHOR', T - 5, T + 5);
    decide(stopCtx(sb, 'MERGER', main, settled));
    assert.deepEqual(lineOf(sb, c), [], 'the checkout it was fast-forwarded into took the commit as created there');
    decide(stopCtx(sb, 'AUTHOR', wt, settled));
    decide(stopCtx(sb, 'MERGER', main, T * 1000 + GRACE_MS + 1000));
    assert.deepEqual(lineOf(sb, c), [['AUTHOR', 'session', undefined]], 'one commit seen from two worktrees of one repository must stay one line');
    assert.equal(rows(sb).find((r) => r.commit_hash === c)?.repo_hash, shortHash(top(wt)), 'the line names the checkout it was merged into, not the worktree that made it');
  });

  it('writes a merged commit whose worktree is gone as window after a day — before, it was simply lost', () => {
    const main = initRepo(join(sb.dir, 'm6')); commit(main, 'base', `${main}\n`, 'base', undefined, T - 1000);
    const wt = join(sb.dir, 'w6');
    sh(main, 'git', ['worktree', 'add', '-q', '-b', 'gone', wt], { GIT_COMMITTER_DATE: `@${T - 900} +0000` });
    const c = commit(wt, 'f', 'w6\n', 'SUBJ-feat', undefined, T);
    sh(main, 'git', ['merge', '-q', '--no-ff', '-m', 'SUBJ-merge', 'gone']);
    sh(main, 'git', ['worktree', 'remove', '--force', wt]);
    decide(stopCtx(sb, 'KEEPER', main, settled));
    assert.deepEqual(lineOf(sb, c), []);
    decide(stopCtx(sb, 'ANYONE', plainCwd(sb), T * 1000 + GRACE_MS + 1000));
    assert.deepEqual(lineOf(sb, c), [[null, 'window', undefined]], 'a commit whose creating worktree was removed never reached the journal');
  });

  it('keeps the maker and the origin of a commit whose worktree was removed before the commit settled', () => {
    const main = initRepo(join(sb.dir, 'm10')); commit(main, 'base', `${main}\n`, 'base', undefined, T - 1000);
    const wt = join(sb.dir, 'w10');
    sh(main, 'git', ['worktree', 'add', '-q', '-b', 'shortlived', wt], { GIT_COMMITTER_DATE: `@${T - 900} +0000` });
    const c = commit(wt, 'f', 'w10\n', 'SUBJ-feat', undefined, T);
    const origin = top(wt);
    covered(sb, wt, 'QUICK', T - 5, T + 5);
    decide(stopCtx(sb, 'QUICK', wt, (T + 30) * 1000));
    sh(main, 'git', ['merge', '-q', '--no-ff', '-m', 'SUBJ-merge', 'shortlived']);
    sh(main, 'git', ['worktree', 'remove', '--force', wt]);
    decide(stopCtx(sb, 'LATER', plainCwd(sb), settled));
    assert.deepEqual(lineOf(sb, c), [['QUICK', 'session', undefined]], 'the removed worktree took the evidence of its maker with it');
    assert.equal(rows(sb).find((r) => r.commit_hash === c)?.repo_hash, shortHash(origin), 'the commit was filed under the checkout it was merged into');
  });

  it('writes the commit of a removed worktree whose branch was never merged anywhere', () => {
    const main = initRepo(join(sb.dir, 'm11')); commit(main, 'base', `${main}\n`, 'base', undefined, T - 1000);
    const wt = join(sb.dir, 'w11');
    sh(main, 'git', ['worktree', 'add', '-q', '-b', 'pushed-for-mr', wt], { GIT_COMMITTER_DATE: `@${T - 900} +0000` });
    const c = commit(wt, 'f', 'w11\n', 'SUBJ-feat', undefined, T);
    decide(stopCtx(sb, 'MR', wt, (T + 30) * 1000));
    sh(main, 'git', ['worktree', 'remove', '--force', wt]);
    decide(stopCtx(sb, 'LATER2', plainCwd(sb), settled));
    assert.deepEqual(lineOf(sb, c), [[null, 'window', undefined]], 'a commit whose worktree is gone and whose branch was never merged left the journal for good');
  });

  it('finds the commit of a worktree removed in the same turn, before any Stop saw it, through the checkout of its store', async () => {
    const main = initRepo(join(sb.dir, 'm12')); commit(main, 'base', `${main}\n`, 'base', undefined, T - 1000);
    decide(stopCtx(sb, 'MAINKEEPER', main, Date.now()));
    const wt = join(sb.dir, 'w12');
    sh(main, 'git', ['worktree', 'add', '-q', '-b', 'same-turn', wt]);
    const c = commit(wt, 'f', 'w12\n', 'SUBJ-feat');
    await post(sb, 'GONE12', plainCwd(sb), { tool_name: 'Bash', tool_input: { command: `cd ${wt} && git commit -qam x` } }, 'g12', 60_000);
    sh(main, 'git', ['worktree', 'remove', '--force', wt]);
    decide(stopCtx(sb, 'GONE12', plainCwd(sb), Date.now() + 1000));
    decide(stopCtx(sb, 'ANY12', plainCwd(sb), Date.now() + GRACE_MS + 60_000));
    assert.deepEqual(lineOf(sb, c), [[null, 'window', undefined]], 'the commit of a worktree removed in the same turn hid behind the marker of the main checkout');
  });

  it('does not write a deferred commit that was amended away before its worktree was removed', () => {
    const main = initRepo(join(sb.dir, 'm13')); commit(main, 'base', `${main}\n`, 'base', undefined, T - 1000);
    const wt = join(sb.dir, 'w13');
    sh(main, 'git', ['worktree', 'add', '-q', '-b', 'amended', wt], { GIT_COMMITTER_DATE: `@${T - 900} +0000` });
    const first = commit(wt, 'f', 'w13\n', 'SUBJ-draft', undefined, T);
    covered(sb, wt, 'AMENDER', T - 5, T + 5);
    decide(stopCtx(sb, 'AMENDER', wt, (T + 30) * 1000));
    sh(wt, 'git', ['commit', '-q', '--amend', '-m', 'SUBJ-final'], { GIT_COMMITTER_DATE: `@${T + 40} +0000` });
    sh(main, 'git', ['worktree', 'remove', '--force', wt]);
    const v = decide(stopCtx(sb, 'LATER13', plainCwd(sb), settled));
    assert.deepEqual(lineOf(sb, first), [], 'a commit no branch holds any more reached the journal as proven work');
    assert.equal(v.kind, 'unknown', 'the dropped commit vanished without a word');
  });

  it('writes the deferred commits of a root whose reflog was expired, and says why once instead of on every Stop', () => {
    const { w, c } = repo('w14');
    decide(stopCtx(sb, 'EXP', w, (T + 30) * 1000));
    sh(w, 'git', ['reflog', 'expire', '--expire=now', '--all']);
    const first = decide(stopCtx(sb, 'EXP', w, settled));
    const second = decide(stopCtx(sb, 'EXP2', plainCwd(sb), settled + 60_000));
    assert.deepEqual([first.kind, second.kind], ['unknown', 'silent'], `an expired reflog was either hidden or reported by every Stop of every session: ${(second as { reason?: string }).reason ?? ''}`);
    decide(stopCtx(sb, 'EXP3', plainCwd(sb), T * 1000 + GRACE_MS + 60_000));
    assert.deepEqual(lineOf(sb, c), [[null, 'window', undefined]], 'the deferred commit of a root with an expired reflog never reached the journal');
  });

  it('writes a commit whose worktree switched to another branch before the Stop', () => {
    const { w, c } = repo('w7');
    sh(w, 'git', ['checkout', '-q', '-b', 'next', 'HEAD~1']);
    covered(sb, w, 'SWITCH', T - 5, T + 5);
    decide(stopCtx(sb, 'SWITCH', w, settled));
    assert.deepEqual(lineOf(sb, c), [['SWITCH', 'session', undefined]], 'a commit left on a branch the worktree switched away from was lost');
  });

  it('writes the amended commit and not the one it replaced', () => {
    const w = initRepo(join(sb.dir, 'w8')); commit(w, 'base', `${w}\n`, 'base', undefined, T - 100);
    const first = commit(w, 'f', '1\n', 'SUBJ-draft', undefined, T);
    sh(w, 'git', ['commit', '-q', '--amend', '-m', 'SUBJ-final'], { GIT_COMMITTER_DATE: `@${T + 10} +0000` });
    const amended = sh(w, 'git', ['rev-parse', 'HEAD']).trim();
    covered(sb, w, 'S8', T - 5, T + 15);
    decide(stopCtx(sb, 'S8', w, settled + 10_000));
    const hashes = rows(sb).map((r) => r.commit_hash);
    assert.ok(hashes.includes(amended));
    assert.equal(hashes.includes(first), false, 'an amended-away commit counted twice in the worklog');
  });

  it('keeps the lines already written when a later line is refused, and does not write them again on the next Stop', () => {
    const w = initRepo(join(sb.dir, 'w9')); commit(w, 'base', `${w}\n`, 'base', undefined, T - 100);
    const good = commit(w, 'g', 'good\n', 'SUBJ-good', undefined, T);
    const bad = commit(w, 'b', 'bad\n', 'SUBJ-bad', undefined, T + 50);
    covered(sb, w, 'S9', T - 5, T + 5);
    withState(sb, (st) => st.db.prepare('INSERT INTO head_moves(repo, session_id, started_at, ended_at, named) VALUES(?,?,?,?,1),(?,?,?,?,1)').run(top(w), 'S9', (T + 45) * 1000, (T + 55) * 1000, top(w), 'bad/id', (T + 45) * 1000, (T + 55) * 1000));
    for (const at of [settled + 60_000, settled + 120_000]) assert.equal(decide(stopCtx(sb, 'S9', w, at)).kind, 'unknown');
    assert.deepEqual(lineOf(sb, good), [['S9', 'session', undefined]], 'a refused line rolled back the index of one already appended — every Stop appends it again');
    assert.deepEqual(lineOf(sb, bad), []);
  });

  it('carries only labels: session ids in candidates, no path, subject or email anywhere in the journal', () => {
    const raw = readFileSync(journalPath(sb.home), 'utf8');
    for (const leak of ['SUBJ-', 'test@example', 'TEST', sb.dir, '/']) assert.equal(raw.includes(leak), false, `leak «${leak}»`);
    for (const r of rows(sb)) for (const k of Object.keys(r)) assert.ok(WHITELIST.commits.has(k as never), `field outside the whitelist: ${k}`);
  });
});
