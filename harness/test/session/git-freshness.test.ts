// Молча ломалось (24.08): трекер прочитан на коммит позади — правило «стянуть перед чтением» жило в памяти.
// Ложное срабатывание опаснее молчания: свой коммит внутри хода кричал как чужой, пока не появилась печать (seal).
// INVARIANT: чужой сдвиг HEAD между ходами — доложен; свой сдвиг внутри хода — нет; отставание от upstream
// докладывается один раз на изменение; fetch не чаще 600 с и не в этом процессе; явный путь без git → unknown.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, utimesSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, payload, HARNESS_ROOT } from '../_env.ts';
import { initRepo, commit, headShort, sh } from './_git.ts';
import { decide, runFetch, syncBranches, resolveRepos, resolveRoots, FETCH_EVERY_MS, KILL, NAME } from '../../src/session/git-freshness.ts';
import type { SyncSpec } from '../../src/session/git-freshness.ts';
import { State } from '../../src/state.ts';
import { route } from '../../src/main.ts';
import type { GateContext, HarnessEvent } from '../../src/types.ts';

process.env.GIT_CONFIG_GLOBAL = '/dev/null';
const cfgSb = sandbox('harness-fresh-cfg-');
after(() => cfgSb.cleanup());
const CONFIG = join(cfgSb.dir, 'harness.config.json');
writeFileSync(CONFIG, JSON.stringify({
  freshness: { vaultVar: 'APP_VAULT', repoVars: ['APP_ENGINE', 'APP_FE', 'APP_CONN'], trackerRel: 'work-docs/TRACKER.md' },
  shellPaths: { file: '.claude/env/paths.sh', vars: ['APP_VAULT', 'APP_ENGINE'] },
}));
process.env.GIT_CONFIG_NOSYSTEM = '1';

type Sb = ReturnType<typeof sandbox>;
// toplevel() отдаёт физический путь (macOS: /var → /private/var) — фикстуры сравниваются в той же форме.
const real = (p: string) => realpathSync(p);
function ctxFor(sb: Sb, event: HarnessEvent, env: Record<string, string>, now: number): GateContext {
  const hook = event === 'stop' ? 'Stop' : 'UserPromptSubmit';
  return { event, payload: payload(hook, { prompt: 'x' }, sb.dir) as never, env: { HOME: sb.home, CLAUDE_HARNESS_CONFIG: CONFIG, ...env }, root: HARNESS_ROOT, stateDir: sb.stateDir, now: () => now };
}
function rows(sb: Sb): Array<{ repo: string; head_seen: string | null; behind: string; behind_said: string; fetch_started_at: number }> {
  const st = State.open(sb.stateDir);
  try {
    const has = st.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='git_freshness'").get();
    return has ? st.db.prepare('SELECT repo, head_seen, behind, behind_said, fetch_started_at FROM git_freshness ORDER BY repo').all() as never : [];
  } finally { st.close(); }
}
function setBehind(sb: Sb, repo: string, text: string): void {
  const st = State.open(sb.stateDir);
  try { st.db.prepare('UPDATE git_freshness SET behind = ? WHERE repo = ?').run(text, repo); } finally { st.close(); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe(NAME, () => {
  const sb = sandbox('harness-freshness-');
  after(() => sb.cleanup());
  const engine = real(initRepo(join(sb.dir, 'engine'))); commit(engine, 'a.txt', '1\n', 'first engine commit');
  const vaultRepo = real(initRepo(join(sb.dir, 'vault-repo'))); commit(vaultRepo, 'README.md', 'v\n');
  const vault = join(vaultRepo, 'docs', 'vault'); mkdirSync(join(vault, 'work-docs'), { recursive: true });
  const tracker = join(vault, 'work-docs', 'TRACKER.md'); writeFileSync(tracker, '# tracker\n'); utimesSync(tracker, 1_700_000_000, 1_700_000_000);
  const env = { APP_ENGINE: engine, APP_VAULT: vault };
  const spawned: string[] = [];
  const stub = (root: string) => { spawned.push(root); };
  let now = 1_800_000_000_000;

  it('stays silent on the first prompt, records HEAD per repo root (vault subdir resolves to its repo) and starts one fetch each', () => {
    const v = decide(ctxFor(sb, 'prompt', env, now), { spawnFetch: stub });
    assert.equal(v.kind, 'silent');
    const r = rows(sb);
    assert.deepEqual(r.map((x) => x.repo).sort(), [engine, vaultRepo].sort());
    assert.equal(r.find((x) => x.repo === engine)?.head_seen, headShort(engine));
    assert.deepEqual([...spawned].sort(), [engine, vaultRepo].sort());
  });

  it('reports a HEAD moved between prompts by someone else with old → new and the top subject, then falls quiet', () => {
    const was = headShort(engine);
    commit(engine, 'b.txt', '2\n', 'foreign session commit');
    now += 1000;
    const v = decide(ctxFor(sb, 'prompt', env, now), { spawnFetch: stub });
    assert.equal(v.kind, 'context');
    const text = (v as { text: string }).text;
    assert.match(text, /СВЕЖЕСТЬ ЧЕКАУТОВ/);
    assert.match(text, new RegExp(`engine: HEAD сдвинулся ${was} → ${headShort(engine)}`));
    assert.match(text, /Верх: foreign session commit/);
    now += 1000;
    assert.equal(decide(ctxFor(sb, 'prompt', env, now), { spawnFetch: stub }).kind, 'silent');
  });

  it('does not report my own commit when the stop-seal ran after it — the seal is what keeps the alarm honest', () => {
    commit(engine, 'c.txt', '3\n', 'my own commit inside the turn');
    now += 1000;
    assert.equal(decide(ctxFor(sb, 'stop', env, now)).kind, 'silent');
    now += 1000;
    assert.equal(decide(ctxFor(sb, 'prompt', env, now), { spawnFetch: stub }).kind, 'silent');
  });

  it('throttles the background fetch: none within 600 s of the last start, one more after it', () => {
    spawned.length = 0;
    now += 1000;
    decide(ctxFor(sb, 'prompt', env, now), { spawnFetch: stub });
    assert.deepEqual(spawned, []);
    now += FETCH_EVERY_MS;
    decide(ctxFor(sb, 'prompt', env, now), { spawnFetch: stub });
    assert.deepEqual([...spawned].sort(), [engine, vaultRepo].sort());
  });

  it('reports "behind upstream" exactly once per change, resets when the lag clears and speaks again on a new lag', () => {
    setBehind(sb, engine, 'позади origin/main на 2 коммит(ов) — стянуть до чтения');
    now += 1000;
    const first = decide(ctxFor(sb, 'prompt', env, now), { spawnFetch: stub });
    assert.equal(first.kind, 'context');
    assert.match((first as { text: string }).text, /engine: позади origin\/main на 2/);
    now += 1000;
    assert.equal(decide(ctxFor(sb, 'prompt', env, now), { spawnFetch: stub }).kind, 'silent', 'повтор того же отставания — шум');
    setBehind(sb, engine, '');
    now += 1000;
    assert.equal(decide(ctxFor(sb, 'prompt', env, now), { spawnFetch: stub }).kind, 'silent');
    assert.equal(rows(sb).find((x) => x.repo === engine)?.behind_said, '');
    setBehind(sb, engine, 'позади origin/main на 5 коммит(ов) — стянуть до чтения');
    now += 1000;
    assert.match((decide(ctxFor(sb, 'prompt', env, now), { spawnFetch: stub }) as { text: string }).text, /на 5/);
  });

  it('reports an uncommitted change of TRACKER.md since the last prompt and is quiet after the seal', () => {
    utimesSync(tracker, 1_700_000_500, 1_700_000_500);
    now += 1000;
    const v = decide(ctxFor(sb, 'prompt', env, now), { spawnFetch: stub });
    assert.equal(v.kind, 'context');
    assert.match((v as { text: string }).text, /TRACKER\.md изменён/);
    utimesSync(tracker, 1_700_000_900, 1_700_000_900);
    now += 1000;
    assert.equal(decide(ctxFor(sb, 'stop', env, now)).kind, 'silent');
    now += 1000;
    assert.equal(decide(ctxFor(sb, 'prompt', env, now), { spawnFetch: stub }).kind, 'silent');
  });

  it('answers unknown naming the variable when an explicit path is not a git repository; an unset variable is skipped silently', () => {
    const sb2 = sandbox('harness-freshness-unknown-');
    const plain = join(sb2.dir, 'plain'); mkdirSync(plain);
    const v = decide(ctxFor(sb2, 'prompt', { APP_ENGINE: plain, APP_VAULT: join(sb2.dir, 'gone') }, now), { spawnFetch: stub });
    assert.equal(v.kind, 'unknown');
    assert.match((v as { reason: string }).reason, /APP_ENGINE: каталог исчез или не git/);
    assert.match((v as { reason: string }).reason, /APP_VAULT/);
    // Ничего не задано, дефолтного вольта нет — не о чем говорить.
    assert.equal(decide(ctxFor(sb2, 'prompt', {}, now), { spawnFetch: stub }).kind, 'silent');
    sb2.cleanup();
  });

  it('visits a repository once even when two variables point into it, and reads paths from paths.sh when env is empty', () => {
    const sb3 = sandbox('harness-freshness-dedup-');
    const repo = real(initRepo(join(sb3.dir, 'one'))); commit(repo, 'a', '1\n');
    const sub = join(repo, 'packages', 'x'); mkdirSync(sub, { recursive: true });
    const r = resolveRoots({ HOME: sb3.home, CLAUDE_HARNESS_CONFIG: CONFIG, APP_FE: repo, APP_CONN: sub });
    assert.deepEqual(r.roots, [repo]);
    assert.deepEqual(r.problems, []);
    mkdirSync(join(sb3.home, '.claude', 'env'), { recursive: true });
    writeFileSync(join(sb3.home, '.claude', 'env', 'paths.sh'), `export APP_VAULT="${sb3.dir}/vault"\nexport APP_ENGINE="${repo}"\n`);
    const spec = resolveRepos({ HOME: sb3.home, CLAUDE_HARNESS_CONFIG: CONFIG });
    assert.deepEqual(spec.specs.map((s) => [s.source, s.path, s.explicit]), [['APP_VAULT', `${sb3.dir}/vault`, true], ['APP_ENGINE', repo, true]]);
    sb3.cleanup();
  });

  it('watches nothing without a site config, even when the variables are set (both sides with the fixture above)', () => {
    const sb7 = sandbox('harness-freshness-noconfig-');
    const repo = real(initRepo(join(sb7.dir, 'one'))); commit(repo, 'a', '1\n');
    assert.deepEqual(resolveRepos({ HOME: sb7.home, APP_ENGINE: repo }).specs, []);
    assert.deepEqual(resolveRepos({ HOME: sb7.home, CLAUDE_HARNESS_CONFIG: CONFIG, APP_ENGINE: repo }).specs.map((s) => s.source), ['APP_ENGINE']);
    sb7.cleanup();
  });

  it('runFetch records the lag behind upstream after a real fetch from a local origin, and clears it when caught up', () => {
    const sb4 = sandbox('harness-freshness-fetch-');
    const origin = initRepo(join(sb4.dir, 'origin')); commit(origin, 'a', '1\n');
    const local = join(sb4.dir, 'local');
    sh(sb4.dir, 'git', ['clone', '-q', origin, local]);
    commit(origin, 'b', '2\n', 'upstream moved');
    assert.match(runFetch(local, sb4.stateDir), /позади origin\/main на 1 коммит\(ов\)/);
    assert.match(rows(sb4)[0].behind, /на 1/);
    sh(local, 'git', ['merge', '-q', '--ff-only', 'origin/main']);
    assert.equal(runFetch(local, sb4.stateDir), '');
    assert.equal(rows(sb4)[0].behind, '');
    sb4.cleanup();
  });

  it('starts the real detached fetch child on prompt and the lag appears in state without the hook waiting for it', async () => {
    const sb5 = sandbox('harness-freshness-detached-');
    const origin = initRepo(join(sb5.dir, 'origin')); commit(origin, 'a', '1\n');
    const local = join(sb5.dir, 'local'); sh(sb5.dir, 'git', ['clone', '-q', origin, local]);
    const localReal = real(local);
    commit(origin, 'b', '2\n');
    const t0 = Date.now();
    assert.equal(decide(ctxFor(sb5, 'prompt', { APP_ENGINE: local, APP_VAULT: join(sb5.dir, 'none') }, Date.now())).kind, 'unknown', 'вольт задан явно и отсутствует');
    assert.ok(Date.now() - t0 < 5000, 'хук ждал fetch');
    let behind = '';
    for (let i = 0; i < 100 && !behind; i++) { await sleep(150); behind = rows(sb5).find((x) => x.repo === localReal)?.behind ?? ''; }
    assert.match(behind, /позади origin\/main на 1/);
    sb5.cleanup();
  });

  it('is skipped by its kill-switch through route(): silent and no freshness state written', async () => {
    const sb6 = sandbox('harness-freshness-kill-');
    const v = await route('prompt', payload('UserPromptSubmit', { prompt: 'x' }, engine) as never, { HOME: sb6.home, CLAUDE_HARNESS_CONFIG: CONFIG, CLAUDE_STATE_DIR: sb6.stateDir, HARNESS_ROOT, APP_ENGINE: engine, [KILL]: '1' });
    assert.equal(v.kind, 'silent');
    assert.deepEqual(rows(sb6), []);
    assert.equal(existsSync(join(sb6.stateDir, 'harness.db')) && (() => { const st = State.open(sb6.stateDir); try { return st.marker('git-freshness:tracker.mtime') !== null; } finally { st.close(); } })(), false);
    sb6.cleanup();
  });
});

// Silently broke (28.09): the frontend's local release/main trailed source/release/main by a month and `git show release/main:…`
// read it. INVARIANT: after a successful fetch of the sync remote a listed local branch moves only fast-forward, only when no
// worktree holds it, only by CAS on the value read; no working tree is touched; ahead/diverged/held — left, one owner note per state.
describe(`${NAME}: перемотка локальных release/* на ремоут`, () => {
  const SYNC: SyncSpec = { remote: 'source', branches: ['release/main', 'release/dev'] };
  const SYNC_CONFIG = join(cfgSb.dir, 'harness.sync.config.json');
  writeFileSync(SYNC_CONFIG, JSON.stringify({
    freshness: { repoVars: ['APP_ENGINE'], sync: SYNC },
  }));
  const rev = (dir: string, ref: string) => sh(dir, 'git', ['rev-parse', '--verify', '-q', ref]).trim();
  const ok = (dir: string, args: string[]) => { try { sh(dir, 'git', args); return true; } catch { return false; } };

  /** Bare remote `source` with release/main and release/dev; a local clone holding both, HEAD on feature/x. */
  function world(prefix: string) {
    const sb = sandbox(prefix);
    const bare = join(sb.dir, 'remote.git'); mkdirSync(bare);
    sh(bare, 'git', ['init', '-q', '--bare', '-b', 'release/main']);
    const up = initRepo(join(sb.dir, 'upstream'), { branch: 'release/main' });
    commit(up, 'a', '1\n', 'base');
    sh(up, 'git', ['remote', 'add', 'source', bare]);
    sh(up, 'git', ['push', '-q', 'source', 'release/main', 'release/main:release/dev']);
    const local = join(sb.dir, 'local');
    sh(sb.dir, 'git', ['clone', '-q', '-o', 'source', bare, local]);
    sh(local, 'git', ['config', 'user.email', 'test@example.invalid']); sh(local, 'git', ['config', 'user.name', 'TEST']);
    sh(local, 'git', ['branch', '-q', 'release/dev', 'source/release/dev']);
    sh(local, 'git', ['checkout', '-q', '-b', 'feature/x']);
    const advanceRemote = (branch: string, file: string) => {
      sh(up, 'git', ['checkout', '-q', '-B', branch, `source/${branch}`]);
      sh(up, 'git', ['fetch', '-q', 'source']);
      sh(up, 'git', ['reset', '-q', '--hard', `source/${branch}`]);
      commit(up, file, `${file}\n`, `remote ${branch} ${file}`);
      sh(up, 'git', ['push', '-q', 'source', branch]);
      return rev(up, 'HEAD');
    };
    const commitUnpushed = (branch: string, msg: string) => {
      const tree = rev(local, `${branch}^{tree}`);
      const c = sh(local, 'git', ['commit-tree', tree, '-p', branch, '-m', msg]).trim();
      sh(local, 'git', ['update-ref', `refs/heads/${branch}`, c]);
      return c;
    };
    return { sb, bare, local: real(local), advance: advanceRemote, localCommit: commitUnpushed };
  }
  function syncRows(sb: Sb): Array<{ repo: string; branch: string; state: string; note: string; said: string }> {
    const st = State.open(sb.stateDir);
    try {
      const has = st.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='git_sync'").get();
      return has ? st.db.prepare('SELECT repo, branch, state, note, said FROM git_sync ORDER BY branch').all() as never : [];
    } finally { st.close(); }
  }
  const stopCtx = (sb: Sb, repo: string) => ctxFor(sb, 'stop', { APP_ENGINE: repo }, Date.now());

  it('перематывает свободную отставшую ветку fast-forward на ремоут после fetch и не трогает HEAD и рабочее дерево', () => {
    const w = world('harness-sync-ff-');
    const head = rev(w.local, 'HEAD');
    const target = w.advance('release/main', 'm1');
    runFetch(w.local, w.sb.stateDir, SYNC);
    assert.equal(rev(w.local, 'refs/heads/release/main'), target);
    assert.equal(rev(w.local, 'HEAD'), head);
    assert.equal(sh(w.local, 'git', ['symbolic-ref', 'HEAD']).trim(), 'refs/heads/feature/x');
    assert.equal(sh(w.local, 'git', ['status', '--porcelain']).trim(), '');
    assert.match(sh(w.local, 'git', ['reflog', '-1', '--format=%gs', 'refs/heads/release/main']), /git-freshness/);
    assert.deepEqual(syncRows(w.sb).map((r) => r.note), ['', ''], 'перемотка и совпадение — не о чем говорить');
    w.sb.cleanup();
  });

  it('не трогает ветку, занятую воркtree (и корневым чекаутом), и отдаёт владельцу заметку один раз на состояние', () => {
    const w = world('harness-sync-wt-');
    const wt = join(w.sb.dir, 'wt-dev');
    sh(w.local, 'git', ['worktree', 'add', '-q', wt, 'release/dev']);
    const before = rev(w.local, 'refs/heads/release/dev');
    w.advance('release/dev', 'd1');
    runFetch(w.local, w.sb.stateDir, SYNC);
    assert.equal(rev(w.local, 'refs/heads/release/dev'), before);
    assert.equal(sh(wt, 'git', ['status', '--porcelain']).trim(), '', 'рабочее дерево воркtree не испорчено');
    const v = decide(ctxFor(w.sb, 'stop', { APP_ENGINE: w.local }, Date.now()));
    assert.equal(v.kind, 'context');
    assert.match((v as { text: string }).text, /release\/dev позади source\/release\/dev на 1.*занята воркtree/);
    assert.equal(decide(stopCtx(w.sb, w.local)).kind, 'silent', 'повтор того же состояния — шум');
    sh(w.local, 'git', ['checkout', '-q', 'release/main']);
    const mm = rev(w.local, 'refs/heads/release/main');
    w.advance('release/main', 'm2');
    runFetch(w.local, w.sb.stateDir, SYNC);
    assert.equal(rev(w.local, 'refs/heads/release/main'), mm);
    assert.equal(sh(w.local, 'git', ['status', '--porcelain']).trim(), '');
    w.sb.cleanup();
  });

  it('не трогает ветку с неотправленными коммитами (впереди и разошлась), заметка на новое состояние — снова', () => {
    const w = world('harness-sync-div-');
    const ahead = w.localCommit('release/main', 'local unpushed');
    runFetch(w.local, w.sb.stateDir, SYNC);
    assert.equal(rev(w.local, 'refs/heads/release/main'), ahead);
    let v = decide(stopCtx(w.sb, w.local));
    assert.match((v as { text: string }).text, /release\/main впереди source\/release\/main на 1/);
    w.advance('release/main', 'm3');
    runFetch(w.local, w.sb.stateDir, SYNC);
    assert.equal(rev(w.local, 'refs/heads/release/main'), ahead, 'разошедшаяся не перемотана');
    v = decide(stopCtx(w.sb, w.local));
    assert.equal(v.kind, 'context', 'новое состояние — новая заметка');
    assert.match((v as { text: string }).text, /release\/main разошлась с source\/release\/main \(своих 1, с ремоута 1\)/);
    assert.equal(decide(stopCtx(w.sb, w.local)).kind, 'silent');
    const p = decide(ctxFor(w.sb, 'prompt', { APP_ENGINE: w.local }, Date.now()), { spawnFetch: () => {} });
    assert.doesNotMatch(p.kind === 'context' ? p.text : '', /разошлась/);
    w.sb.cleanup();
  });

  it('CAS: ветка, сдвинутая между чтением и записью, остаётся за тем, кто её сдвинул', () => {
    const w = world('harness-sync-cas-');
    w.advance('release/main', 'm4');
    sh(w.local, 'git', ['fetch', '-q', 'source']);
    let concurrent = '';
    const out = syncBranches(w.local, SYNC, { beforeUpdate: (b) => { if (b === 'release/main') concurrent = w.localCommit('release/main', 'raced in'); } });
    assert.equal(rev(w.local, 'refs/heads/release/main'), concurrent);
    assert.equal(out.find((o) => o.branch === 'release/main')?.outcome, 'raced');
    w.sb.cleanup();
  });

  it('ничего не трогает, когда fetch ремоута упал, ремоута нет или ветки нет; исчезнувший каталог — без исключения', () => {
    const w = world('harness-sync-fail-');
    w.advance('release/main', 'm5');
    sh(w.local, 'git', ['fetch', '-q', 'source']);
    const stale = rev(w.local, 'refs/heads/release/main');
    assert.notEqual(stale, rev(w.local, 'refs/remotes/source/release/main'), 'трекинг-ref уже впереди');
    sh(w.local, 'git', ['remote', 'set-url', 'source', join(w.sb.dir, 'gone.git')]);
    runFetch(w.local, w.sb.stateDir, SYNC);
    assert.equal(rev(w.local, 'refs/heads/release/main'), stale, 'fetch упал — ни одной перемотки');
    sh(w.local, 'git', ['remote', 'rename', 'source', 'upstream']);
    assert.deepEqual(syncBranches(w.local, SYNC).map((o) => o.outcome), ['absent', 'absent']);
    runFetch(w.local, w.sb.stateDir, SYNC);
    assert.equal(rev(w.local, 'refs/heads/release/main'), stale);
    assert.deepEqual(syncBranches(w.local, { remote: 'upstream', branches: ['release/none'] }).map((o) => o.outcome), ['absent']);
    assert.equal(ok(w.local, ['rev-parse', '--verify', '-q', 'refs/heads/release/none']), false);
    assert.doesNotThrow(() => runFetch(join(w.sb.dir, 'vanished'), w.sb.stateDir, SYNC));
    assert.deepEqual(syncBranches(join(w.sb.dir, 'vanished'), SYNC).map((o) => o.outcome), ['absent', 'absent']);
    w.sb.cleanup();
  });

  it('не трогает ветку под rebase в воркtree (list показывает detached) — отказ git доходит владельцу заметкой', () => {
    const w = world('harness-sync-rebase-');
    const wt = join(w.sb.dir, 'wt-main');
    sh(w.local, 'git', ['worktree', 'add', '-q', wt, 'release/main']);
    commit(wt, 'r', 'r\n', 'to be rebased');
    sh(wt, 'git', ['rebase', '-q', '-i', 'HEAD~1'], { GIT_SEQUENCE_EDITOR: `sed -i.bak '1i\\\nbreak\n'` });
    assert.match(sh(w.local, 'git', ['worktree', 'list', '--porcelain']), /detached/);
    sh(w.local, 'git', ['update-ref', 'refs/heads/release/main', rev(w.local, 'refs/remotes/source/release/main')]);
    const before = rev(w.local, 'refs/heads/release/main');
    w.advance('release/main', 'm6');
    runFetch(w.local, w.sb.stateDir, SYNC);
    assert.equal(rev(w.local, 'refs/heads/release/main'), before, 'ветка под rebase не сдвинута');
    const v = decide(stopCtx(w.sb, w.local));
    assert.match((v as { text: string }).text, /release\/main .*занята воркtree/);
    w.sb.cleanup();
  });

  it('не идёт по символической ссылке в чужую ветку и докладывает застрявший lock вместо молчания', () => {
    const w = world('harness-sync-symref-');
    const feat = rev(w.local, 'refs/heads/feature/x');
    sh(w.local, 'git', ['update-ref', '-d', 'refs/heads/release/main']);
    sh(w.local, 'git', ['symbolic-ref', 'refs/heads/release/main', 'refs/heads/feature/x']);
    w.advance('release/main', 'm7');
    runFetch(w.local, w.sb.stateDir, SYNC);
    assert.equal(rev(w.local, 'refs/heads/feature/x'), feat, 'HEAD чекаута не сдвинут через symref');
    assert.equal(sh(w.local, 'git', ['status', '--porcelain']).trim(), '');
    const w2 = world('harness-sync-lock-');
    w2.advance('release/dev', 'd2');
    writeFileSync(join(w2.local, '.git', 'refs', 'heads', 'release', 'dev.lock'), '');
    const stuck = rev(w2.local, 'refs/heads/release/dev');
    runFetch(w2.local, w2.sb.stateDir, SYNC);
    assert.equal(rev(w2.local, 'refs/heads/release/dev'), stuck);
    const v = decide(stopCtx(w2.sb, w2.local));
    assert.match((v as { text: string }).text, /release\/dev не перемотана/);
    w.sb.cleanup(); w2.sb.cleanup();
  });

  it('prompt передаёт фоновому fetch спецификацию синка из конфига; без блока sync — не передаёт', () => {
    const sb = sandbox('harness-sync-wire-');
    const repo = real(initRepo(join(sb.dir, 'one'))); commit(repo, 'a', '1\n');
    const got: Array<SyncSpec | undefined> = [];
    const spawnFetch = (_r: string, _s: string, sync?: SyncSpec) => { got.push(sync); };
    const base = { event: 'prompt' as const, payload: payload('UserPromptSubmit', { prompt: 'x' }, sb.dir) as never, root: HARNESS_ROOT, stateDir: sb.stateDir, now: () => FETCH_EVERY_MS * 10 };
    decide({ ...base, env: { HOME: sb.home, CLAUDE_HARNESS_CONFIG: SYNC_CONFIG, APP_ENGINE: repo } }, { spawnFetch });
    assert.deepEqual(got, [SYNC]);
    const sb2 = sandbox('harness-sync-wire2-');
    decide({ ...base, stateDir: sb2.stateDir, env: { HOME: sb2.home, CLAUDE_HARNESS_CONFIG: CONFIG, APP_ENGINE: repo } }, { spawnFetch });
    assert.deepEqual(got, [SYNC, undefined]);
    sb.cleanup(); sb2.cleanup();
  });
});
