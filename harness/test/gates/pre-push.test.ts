// Молча ломалось: push в защищённую ветку с фичевой, MR фичевой в main, серия с обвязкой стенда (chore(env));
// плюс два класса из матрицы покрытия — одна миграция под двумя штампами после мержа и release/<N+1>, срезанный
// при незамкнутом в main хотфиксе. Гейт спрашивает git о серии и refs, а не разбирает текст.
// INVARIANT: push/MR в защищённую ветку только с release/*|hotfix/*; серия наружу без локальной обвязки;
// H1 — новая миграция ветки не совпадает телом с миграцией таргета под другим штампом и не несёт штамп «…00000»;
// H2 — перед release/<N+1> вершины remote release/<меньше> и hotfix/* — предки remote product/main.
// Нет данных (цель push не разобрана, detached HEAD, вне git, remote без refs, нет remote/product/main) → unknown.
// REGRESSION: bash-оригинал пропускал неразобранную цель с предупреждением; `cd X && git push` и `git -C X push`
// зависели от префикса матчера settings.json, не подтверждённого пробой.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { sandbox, bashPayload, HARNESS_ROOT } from '../_env.ts';
import { decide, NAME } from '../../src/gates/pre-push.ts';
import { resetConfigCache } from '../../src/config.ts';
import { route } from '../../src/main.ts';
import type { GateContext, HookPayload, Verdict } from '../../src/types.ts';
import { misses } from '../_equivalence.ts';

const sb = sandbox();
after(() => sb.cleanup());
const remote = join(sb.dir, 'remote.git');
const repo = join(sb.dir, 'repo');
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' };

function g(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function commit(files: Record<string, string>, subject: string): void {
  for (const [p, c] of Object.entries(files)) { mkdirSync(join(repo, dirname(p)), { recursive: true }); writeFileSync(join(repo, p), c); }
  g(repo, 'add', '-A'); g(repo, 'commit', '-q', '-m', subject);
}
function run(command: string, branch: string | null, env: NodeJS.ProcessEnv = {}, cwd = repo, root = HARNESS_ROOT): Verdict {
  if (branch) g(repo, 'checkout', '-q', branch);
  const payload = bashPayload(command) as unknown as HookPayload;
  (payload as { cwd: string }).cwd = cwd;
  // Защищённая ветка — свойство площадки: фикстуры корпуса живут на product/main, поэтому корпус задаёт её
  // явно через env. Дженерик-дефолт (main) проверяется отдельным кейсом ниже, без env и без конфига.
  const ctx: GateContext = { event: 'pre-bash', payload, env: { PREPUSH_PROTECTED: 'product/main', ...env }, root, stateDir: sb.stateDir, now: Date.now };
  return decide(ctx);
}
const reason = (v: Verdict): string => (v as { reason?: string }).reason ?? '';
const migration = (stamp: string, cls: string, table: string): string =>
  `import { MigrationInterface, QueryRunner } from 'typeorm';\n\nexport class ${cls}${stamp} implements MigrationInterface {\n  name = '${cls}${stamp}';\n  async up(q: QueryRunner): Promise<void> { await q.query('CREATE TABLE ${table}(id int)'); }\n  async down(q: QueryRunner): Promise<void> { await q.query('DROP TABLE ${table}'); }\n}\n`;

before(() => {
  g(sb.dir, 'init', '-q', '--bare', remote);
  g(sb.dir, 'init', '-q', repo);
  g(repo, 'remote', 'add', 'origin', remote);
  commit({ 'src/app.ts': 'export const a = 1;\n' }, 'feat: base');
  g(repo, 'branch', '-M', 'product/main');
  g(repo, 'push', '-q', 'origin', 'product/main');
  g(repo, 'checkout', '-q', '-b', 'product/dev'); g(repo, 'push', '-q', 'origin', 'product/dev');
  g(repo, 'checkout', '-q', '-b', 'feature/js-1', 'product/main'); commit({ 'src/feat.ts': 'export const b = 2;\n' }, 'feat: work');
  g(repo, 'checkout', '-q', '-b', 'release/1.45.3', 'product/main'); commit({ 'src/rel.ts': 'export const c = 3;\n' }, 'feat: release content');
  g(repo, 'checkout', '-q', '-b', 'hotfix/js-2', 'product/main'); commit({ 'src/hot.ts': 'export const d = 4;\n' }, 'fix: hotfix');
  g(repo, 'checkout', '-q', '-b', 'feature/js-3', 'product/main'); commit({ 'src/ok.ts': 'export const e = 5;\n' }, 'feat: clean work');
  commit({ 'env/.env.stand': 'API=http://127.0.0.1:8080\n' }, 'chore(env): стенд');
  g(repo, 'checkout', '-q', '-b', 'feature/js-4', 'product/main'); commit({ 'skills/local-stand-up/SKILL.md': '# skill\n' }, 'docs(skills): local-stand-up');
  g(repo, 'checkout', '-q', '-b', 'feature/js-5', 'product/main'); commit({ 'skills/local-stand-up/SKILL.md': '# skill\n', 'env/.env.stand': 'A=1\n' }, 'docs: skill and env');
});

describe(NAME, () => {
  describe('bash corpus (pre-push-guard.test.sh 1-13)', () => {
    it('1. feature branch → push to product/main is denied', () => {
      const v = run('git push origin HEAD:product/main', 'feature/js-1');
      assert.equal(v.kind, 'deny', reason(v)); assert.match(reason(v), /только с release\/\* или hotfix\/\*/);
    });
    it('2. release/* → product/main passes (I7: a wall gets switched off)', () => { assert.equal(run('git push origin HEAD:product/main', 'release/1.45.3').kind, 'silent'); });
    it('3. hotfix/* → product/main passes', () => { assert.equal(run('git push origin HEAD:product/main', 'hotfix/js-2').kind, 'silent'); });
    it('4. feature → product/dev passes', () => { assert.equal(run('git push origin HEAD:product/dev', 'feature/js-1').kind, 'silent'); });
    it('5. explicit branch name in the refspec is denied', () => { assert.equal(run('git push origin feature/js-1:product/main', 'feature/js-1').kind, 'deny'); });
    it('6. `-u remote branch` form is denied', () => { assert.equal(run('git push -u origin product/main', 'feature/js-1').kind, 'deny'); });
    it('7. MR from a feature branch into product/main is denied', () => {
      const v = run('glab mr create --target-branch product/main --title x', 'feature/js-1');
      assert.equal(v.kind, 'deny'); assert.match(reason(v), /MR в product\/main/);
    });
    it('8. MR from a feature branch into product/dev passes', () => { assert.equal(run('glab mr create --target-branch product/dev --title x', 'feature/js-1').kind, 'silent'); });
    it('9. MR from release/* into product/main passes', () => { assert.equal(run('glab mr create --target-branch=product/main --title rel', 'release/1.45.3').kind, 'silent'); });
    // REGRESSION 22.09: the source came from HEAD only, so a feature MR into main opened from a release checkout passed.
    it('9a. judges the branch named by --source-branch, not the checkout (both sides)', () => {
      assert.equal(run('glab mr create --source-branch feature/js-1 --target-branch product/main --title x', 'release/1.45.3').kind, 'deny');
      assert.equal(run('glab mr create -s release/1.45.3 --target-branch product/main --title rel', 'feature/js-1').kind, 'silent');
    });
    it('10. a series carrying chore(env) is denied with the offending commit', () => {
      const v = run('git push origin HEAD:product/dev', 'feature/js-3');
      assert.equal(v.kind, 'deny'); assert.match(reason(v), /chore\(env\): стенд/); assert.match(reason(v), /rebase --onto origin\/product\/dev/);
      assert.match(reason(v), /из своего терминала/, 'the bypass belongs to the owner');
      assert.match(reason(v), /префикс команды гейт не читает/, 'an agent reads a bare VAR=1 as a command prefix it can add');
    });
    it('11. a clean series passes', () => { assert.equal(run('git push origin HEAD:product/dev', 'feature/js-1').kind, 'silent'); });
    // REGRESSION 23.09: a commit touching only skills/local-stand-up/ counted as stand wiring (the substring «stand»).
    // The owner's exception list (harness/owner/pre-push-exceptions.json) excuses named paths for a named remote only.
    it('11a. an owner exception excuses its paths on its remote and nothing else (both sides)', () => {
      const root = join(sb.dir, 'harness-root');
      mkdirSync(join(root, 'owner'), { recursive: true });
      writeFileSync(join(root, 'owner', 'pre-push-exceptions.json'), JSON.stringify({ 'local-wiring': [{ remote: 'remote.git', paths: ['skills/local-stand-*/**'], reason: 'проба', added: '2026-09-23' }] }));
      assert.equal(run('git push origin HEAD:product/dev', 'feature/js-4').kind, 'deny', 'без списка путь скилла — обвязка');
      assert.equal(run('git push origin HEAD:product/dev', 'feature/js-4', {}, repo, root).kind, 'silent');
      assert.equal(run('git push origin HEAD:product/dev', 'feature/js-5', {}, repo, root).kind, 'silent', 'коммит несёт и не-обвязку после исключения');
      assert.equal(run('git push origin HEAD:product/dev', 'feature/js-3', {}, repo, root).kind, 'deny', 'chore(env) исключением не снимается');
      writeFileSync(join(root, 'owner', 'pre-push-exceptions.json'), JSON.stringify({ 'local-wiring': [{ remote: 'github.com/other/repo', paths: ['skills/local-stand-*/**'], reason: 'проба', added: '2026-09-23' }] }));
      assert.equal(run('git push origin HEAD:product/dev', 'feature/js-4', {}, repo, root).kind, 'deny', 'исключение чужого remote не действует');
      writeFileSync(join(root, 'owner', 'pre-push-exceptions.json'), '{ broken');
      const v = run('git push origin HEAD:product/dev', 'feature/js-4', {}, repo, root);
      assert.equal(v.kind, 'deny'); assert.match(reason(v), /pre-push-exceptions\.json не прочитан/);
    });
    it('12. `git push` without a target and without upstream → unknown (bash warned and passed; unknown never collapses to silent)', () => {
      const v = run('git push', 'feature/js-1');
      assert.equal(v.kind, 'unknown'); assert.match(reason(v), /upstream/);
    });
    it('13. a non-git command passes instantly', () => { assert.equal(run('npm run build', 'feature/js-1').kind, 'silent'); });
  });

  describe('new: the push is found by argv and cwd, not by a prefix over the line', () => {
    it('`cd <repo> && git push …` from another cwd is a push in <repo>', () => {
      assert.equal(run(`cd ${repo} && git push origin HEAD:product/main`, 'feature/js-1', {}, '/').kind, 'deny');
    });
    it('`git -C <repo> push …` is a push in <repo>', () => {
      assert.equal(run(`git -C ${repo} push origin HEAD:product/main`, 'feature/js-1', {}, '/').kind, 'deny');
      assert.equal(run(`git -C ${repo} push origin HEAD:product/dev`, 'feature/js-1', {}, '/').kind, 'silent');
    });
    it('a push after `;` and inside `sh -c` is still seen', () => {
      assert.equal(run('echo x; git push origin HEAD:product/main', 'feature/js-1').kind, 'deny');
      assert.equal(run(`sh -c "git push origin HEAD:product/main"`, 'feature/js-1').kind, 'deny');
    });
    it('`git push origin` and bare `git push` resolve the target through the configured upstream', () => {
      g(repo, 'checkout', '-q', 'feature/js-1'); g(repo, 'branch', '-u', 'origin/product/main');
      try {
        assert.equal(run('git push origin', null).kind, 'deny');
        assert.equal(run('git push', null).kind, 'deny');
        g(repo, 'branch', '-u', 'origin/product/dev');
        assert.equal(run('git push', null).kind, 'silent');
      } finally { g(repo, 'branch', '--unset-upstream'); }
    });
    it('a target given through a variable is expanded from env; unset → unknown; $(…) → unknown', () => {
      assert.equal(run('git push origin HEAD:$TARGET', 'feature/js-1', { TARGET: 'product/main' }).kind, 'deny');
      assert.equal(run('git push origin HEAD:$TARGET', 'feature/js-1', {}).kind, 'unknown');
      assert.equal(run('git push origin HEAD:$(git branch --show-current)', 'feature/js-1').kind, 'unknown');
    });
    it('cwd outside any git repository → unknown, not a pass', () => {
      const v = run('git push origin HEAD:product/main', 'feature/js-1', {}, sb.dir);
      assert.equal(v.kind, 'unknown'); assert.match(reason(v), /вне git/);
    });
    it('detached HEAD → unknown: the source branch is not determined', () => {
      g(repo, 'checkout', '-q', '--detach', 'feature/js-1');
      try { const v = run('git push origin HEAD:product/main', null); assert.equal(v.kind, 'unknown'); assert.match(reason(v), /detached/); }
      finally { g(repo, 'checkout', '-q', 'feature/js-1'); }
    });
    it('PREPUSH_PROTECTED widens the protected set', () => {
      assert.equal(run('git push origin HEAD:product/dev', 'feature/js-1', { PREPUSH_PROTECTED: 'product/main,product/dev' }).kind, 'deny');
    });
  });

  describe('H1: migration bodies against the target branch', () => {
    before(() => {
      g(repo, 'checkout', '-q', 'product/dev');
      commit({ 'src/migration/1700000000001-add-users.ts': migration('1700000000001', 'AddUsers', 'users') }, 'feat: users migration');
      g(repo, 'push', '-q', 'origin', 'product/dev');
      g(repo, 'checkout', '-q', '-b', 'feature/mig-dup', 'product/dev~1');
      commit({ 'src/migration/1700000000777-add-users-again.ts': migration('1700000000777', 'AddUsers', 'users') }, 'feat: users migration again');
      g(repo, 'checkout', '-q', '-b', 'feature/mig-same', 'product/dev~1');
      commit({ 'src/migration/1700000000001-add-users.ts': migration('1700000000001', 'AddUsers', 'users') }, 'feat: same migration same name');
      g(repo, 'checkout', '-q', '-b', 'feature/mig-round', 'product/dev');
      commit({ 'src/migration/1700000100000-add-orders.ts': migration('1700000100000', 'AddOrders', 'orders') }, 'feat: orders migration');
      g(repo, 'checkout', '-q', '-b', 'feature/mig-ok', 'product/dev');
      commit({ 'src/migration/1700000000555-add-orders.ts': migration('1700000000555', 'AddOrders', 'orders') }, 'feat: orders migration');
    });
    it('the same body under another stamp → deny naming both files', () => {
      const v = run('git push origin HEAD:product/dev', 'feature/mig-dup');
      assert.equal(v.kind, 'deny', reason(v));
      assert.match(reason(v), /1700000000777-add-users-again\.ts/); assert.match(reason(v), /1700000000001-add-users\.ts/);
    });
    it('the same rule guards `glab mr create` into that target', () => {
      assert.equal(run('glab mr create --target-branch product/dev --title x', 'feature/mig-dup').kind, 'deny');
    });
    it('a stamp ending in 00000 → deny naming the stamp', () => {
      const v = run('git push origin HEAD:product/dev', 'feature/mig-round');
      assert.equal(v.kind, 'deny'); assert.match(reason(v), /круглый штамп 1700000100000/);
    });
    it('the same body under the same name is not a new migration → pass', () => { assert.equal(run('git push origin HEAD:product/dev', 'feature/mig-same').kind, 'silent'); });
    it('a genuinely new migration → pass', () => { assert.equal(run('git push origin HEAD:product/dev', 'feature/mig-ok').kind, 'silent'); });
    it('first push of a new branch has no target to collide with → pass', () => { assert.equal(run('git push -u origin feature/mig-dup', 'feature/mig-dup').kind, 'silent'); });
    it('a remote with no local refs → unknown (fetch first), never a pass', () => {
      const empty = join(sb.dir, 'empty.git'); g(sb.dir, 'init', '-q', '--bare', empty); g(repo, 'remote', 'add', 'empty', empty);
      const v = run('git push empty HEAD:product/dev', 'feature/mig-dup');
      assert.equal(v.kind, 'unknown'); assert.match(reason(v), /нет локальных refs/);
    });
  });

  describe('H2: release/hotfix closure into main before release/<N+1>', () => {
    before(() => {
      g(repo, 'push', '-q', 'origin', 'release/1.45.3', 'hotfix/js-2');
      g(repo, 'branch', 'release/1.46.0', 'product/main');
      g(repo, 'branch', 'release/1.40.0', 'product/main');
    });
    it('release/1.46.0 while origin/release/1.45.3 and origin/hotfix/js-2 tips are not in origin/product/main → deny naming the tips', () => {
      const v = run('git push -u origin release/1.46.0', 'release/1.46.0');
      assert.equal(v.kind, 'deny', reason(v));
      assert.match(reason(v), /release\/1\.45\.3 \([0-9a-f]{9}\)/); assert.match(reason(v), /hotfix\/js-2 \([0-9a-f]{9}\)/);
    });
    it('only releases with a smaller number count: release/1.40.0 is stopped by the hotfix, not by release/1.45.3', () => {
      const v = run('git push -u origin release/1.40.0', 'release/1.40.0');
      assert.equal(v.kind, 'deny'); assert.match(reason(v), /hotfix\/js-2/); assert.doesNotMatch(reason(v), /release\/1\.45\.3/);
    });
    it('a remote without product/main → unknown', () => {
      const nomain = join(sb.dir, 'nomain.git'); g(sb.dir, 'init', '-q', '--bare', nomain); g(repo, 'remote', 'add', 'nomain', nomain);
      g(repo, 'push', '-q', 'nomain', 'release/1.45.3');
      const v = run('git push nomain release/1.46.0', 'release/1.46.0');
      assert.equal(v.kind, 'unknown'); assert.match(reason(v), /product\/main/);
    });
    it('after the release and the hotfix are merged into origin/product/main the same push passes', () => {
      g(repo, 'checkout', '-q', 'product/main');
      g(repo, 'merge', '-q', '--no-edit', 'release/1.45.3'); g(repo, 'merge', '-q', '--no-edit', 'hotfix/js-2');
      g(repo, 'push', '-q', 'origin', 'product/main');
      assert.equal(run('git push -u origin release/1.46.0', 'release/1.46.0').kind, 'silent');
    });
    // REGRESSION 22.09: 17 branches abandoned cycles ago (a 2025 vendor hotfix/demo among them) and cherry-picked fixes
    // blocked every release push of the engine once pushes with $W resolved their directory.
    it('does not count a branch older than the window, and does once the window is widened (both sides)', () => {
      const old = { ...GIT_ENV, GIT_AUTHOR_DATE: '2025-03-20T10:00:00', GIT_COMMITTER_DATE: '2025-03-20T10:00:00' };
      g(repo, 'checkout', '-q', '-b', 'hotfix/ancient', 'product/main');
      writeFileSync(join(repo, 'src/ancient.ts'), 'export const z = 0;\n');
      spawnSync('git', ['add', '-A'], { cwd: repo, env: old }); spawnSync('git', ['commit', '-q', '-m', 'fix: ancient'], { cwd: repo, env: old });
      g(repo, 'push', '-q', 'origin', 'hotfix/ancient');
      assert.equal(run('git push -u origin release/1.46.0', 'release/1.46.0').kind, 'silent');
      const wide = run('git push -u origin release/1.46.0', 'release/1.46.0', { H2_WINDOW_DAYS: '100000' });
      assert.equal(wide.kind, 'deny'); assert.match(reason(wide), /hotfix\/ancient/);
      g(repo, 'push', '-q', 'origin', '--delete', 'hotfix/ancient');
    });
    it('counts a hotfix cherry-picked into main as closed, and a fresh unpicked one as open (both sides)', () => {
      g(repo, 'checkout', '-q', '-b', 'hotfix/picked', 'product/main'); commit({ 'src/picked.ts': 'export const p = 1;\n' }, 'fix: picked');
      g(repo, 'checkout', '-q', '-b', 'hotfix/unpicked', 'product/main'); commit({ 'src/unpicked.ts': 'export const u = 1;\n' }, 'fix: unpicked');
      g(repo, 'checkout', '-q', 'product/main'); commit({ 'src/main-moves.ts': 'export const m = 1;\n' }, 'feat: main moves on');
      g(repo, 'cherry-pick', 'hotfix/picked'); g(repo, 'push', '-q', 'origin', 'product/main');
      assert.notEqual(spawnSync('git', ['merge-base', '--is-ancestor', 'hotfix/picked', 'product/main'], { cwd: repo }).status, 0, 'the pick must have a new SHA, or the test proves ancestry, not patch identity');
      g(repo, 'push', '-q', 'origin', 'hotfix/picked', 'hotfix/unpicked');
      const v = run('git push -u origin release/1.46.0', 'release/1.46.0');
      assert.equal(v.kind, 'deny'); assert.match(reason(v), /hotfix\/unpicked/); assert.doesNotMatch(reason(v), /hotfix\/picked /);
    });
  });

  describe('through the router', () => {
    const env = { HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, HARNESS_ROOT, PREPUSH_PROTECTED: 'product/main' };
    const payload = (): HookPayload => { const p = bashPayload('git push origin HEAD:product/main') as unknown as HookPayload; (p as { cwd: string }).cwd = repo; return p; };
    it('kill-switch CLAUDE_SKIP_PREPUSH_GUARD=1 → silent and nothing written to state or journals', async () => {
      g(repo, 'checkout', '-q', 'feature/js-1');
      const v = await route('pre-bash', payload(), { ...env, CLAUDE_SKIP_PREPUSH_GUARD: '1' });
      assert.equal(v.kind, 'silent');
      assert.deepEqual(readdirSync(sb.stateDir), []); assert.deepEqual(readdirSync(sb.home), []);
    });
    it('without the switch the same payload is denied with the gate name', async () => {
      const v = await route('pre-bash', payload(), env);
      assert.equal(v.kind, 'deny'); assert.equal((v as { gate: string }).gate, NAME);
    });
    it('unknown (no upstream) becomes ask on the pre-event in a session a human watches', async () => {
      const p = bashPayload('git push') as unknown as HookPayload; (p as { cwd: string }).cwd = repo;
      assert.equal((await route('pre-bash', p, env)).kind, 'ask');
    });
    // REGRESSION 22.09: the same bare `git push` ran without a prompt in bypassPermissions — an ask there is a pass.
    it('the same unknown is a deny in bypassPermissions and auto, where no prompt reaches a human', async () => {
      for (const mode of ['bypassPermissions', 'auto']) {
        const p = bashPayload('git push', { permission_mode: mode }) as unknown as HookPayload; (p as { cwd: string }).cwd = repo;
        assert.equal((await route('pre-bash', p, env)).kind, 'deny', mode);
      }
    });
  });

  // Переносимость: свежая установка обязана иметь защищённую ветку БЕЗ настройки, иначе первый же push
  // в main на новой машине проходит молча. Дефолт — main; product/main задаётся конфигом площадки.
  describe('generic default with neither env nor config', () => {
    const noConfig = { PREPUSH_PROTECTED: undefined, HOME: sb.home };
    it('denies a direct push to main from a feature branch out of the box', () => {
      resetConfigCache();
      const v = run('git push origin HEAD:main', 'feature/js-1', noConfig);
      assert.equal(v.kind, 'deny', 'на свежей машине main обязан быть защищён без конфига');
    });
    it('does not deny the same push from a release branch — the rule is the source, not the word main', () => {
      resetConfigCache();
      assert.notEqual(run('git push origin HEAD:main', 'release/1.45.3', noConfig).kind, 'deny');
    });
    it('leaves product/main unprotected until the site config names it', () => {
      resetConfigCache();
      assert.notEqual(run('git push origin HEAD:product/main', 'feature/js-1', noConfig).kind, 'deny');
    });
    it('answers unknown when the site config exists and does not read — the defaults would guard the wrong branch (both sides)', () => {
      const broken = join(sb.dir, 'broken.config.json');
      writeFileSync(broken, '{ "protectedBranches": ["product/main"');
      resetConfigCache();
      const v = run('git push origin HEAD:product/main', 'feature/js-1', { ...noConfig, CLAUDE_HARNESS_CONFIG: broken });
      assert.equal(v.kind, 'unknown', JSON.stringify(v));
      assert.match(reason(v), /конфиг площадки не прочитан/);
      resetConfigCache();
      assert.equal(run('git push origin HEAD:product/main', 'feature/js-1', { PREPUSH_PROTECTED: 'product/main', CLAUDE_HARNESS_CONFIG: broken }).kind, 'deny', 'явный env главнее конфига');
    });
  });
});

// REGRESSION 19.10 (lines renamed to main/dev): an MR was read against `origin`, the legacy upstream, whose old `dev`
// made 150 migrations of the company dev look new; the protected-branch rule ignored the host and refused a personal
// repository's push of its main to GitHub.
// INVARIANT: with ownerHosts set, an MR's series is read from the company-host remote, and the protected rule holds a
// push whose remote is on a company host or unresolved; without ownerHosts both behave as before.
describe('pre-push: company host decides which remote and which push the line rules read', () => {
  const corpRemote = join(sb.dir, 'gitlab.corp.test', 'engine.git');
  const legacyRemote = join(sb.dir, 'legacy.example', 'engine.git');
  const ownRemote = join(sb.dir, 'github.com', 'me', 'brain.git');
  const lines = join(sb.dir, 'lines');
  const own = join(sb.dir, 'own');
  const hostsConfig = join(sb.dir, 'hosts.json');
  const HOSTS_ENV = { CLAUDE_HARNESS_CONFIG: hostsConfig, PREPUSH_PROTECTED: 'main' };
  const write = (dir: string, files: Record<string, string>, subject: string): void => {
    for (const [p, c] of Object.entries(files)) { mkdirSync(join(dir, dirname(p)), { recursive: true }); writeFileSync(join(dir, p), c); }
    g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', subject);
  };
  const at = (dir: string, branch: string, command: string): Verdict => { g(dir, 'checkout', '-q', branch); return run(command, null, HOSTS_ENV, dir); };

  before(() => {
    writeFileSync(hostsConfig, JSON.stringify({ protectedBranches: ['main'], ownerHosts: ['gitlab.corp.test'] }));
    resetConfigCache();
    for (const r of [corpRemote, legacyRemote, ownRemote]) { mkdirSync(dirname(r), { recursive: true }); g(sb.dir, 'init', '-q', '--bare', r); }
    g(sb.dir, 'init', '-q', lines);
    g(lines, 'remote', 'add', 'origin', legacyRemote); g(lines, 'remote', 'add', 'source', corpRemote);
    write(lines, { 'src/app.ts': 'export const a = 1;\n' }, 'feat: base');
    g(lines, 'branch', '-M', 'main');
    g(lines, 'push', '-q', 'origin', 'main:dev');
    write(lines, { 'src/migration/1760480000000-create-user-warehouses.ts': migration('1760480000000', 'CreateUserWarehouses', 'user_warehouses') }, 'feat: a migration the company line already ran');
    g(lines, 'push', '-q', 'source', 'main', 'main:dev');
    g(lines, 'checkout', '-q', '-b', 'hotfix/ci-lines', 'main'); write(lines, { '.gitlab-ci.yml': 'stages: [build]\n' }, 'fix(ci): key the lines on main and dev');
    g(lines, 'checkout', '-q', '-b', 'fix/round-stamp', 'main');
    write(lines, { 'src/migration/1790000000000-add-flag.ts': migration('1790000000000', 'AddFlag', 'flags') }, 'feat: a migration with a hand-made stamp');
    g(lines, 'checkout', '-q', '-b', 'feature/x', 'main');
    g(lines, 'fetch', '-q', 'origin'); g(lines, 'fetch', '-q', 'source');
    g(sb.dir, 'init', '-q', own);
    g(own, 'remote', 'add', 'secret', ownRemote);
    write(own, { 'notes.md': '# notes\n' }, 'docs: notes');
    g(own, 'branch', '-M', 'main'); g(own, 'push', '-q', 'secret', 'main');
  });
  after(() => resetConfigCache());

  it('reads an MR into dev against the company remote — the legacy origin/dev, older than the company line, invents no new migrations', () => {
    const v = at(lines, 'hotfix/ci-lines', 'glab mr create --target-branch dev --title x');
    assert.equal(v.kind, 'silent', reason(v));
  });
  it('still refuses a round stamp the MR itself brings, and names only that one — the check moved, it did not go away', () => {
    const v = at(lines, 'fix/round-stamp', 'glab mr create --target-branch dev --title x');
    assert.equal(v.kind, 'deny', reason(v));
    assert.match(reason(v), /1790000000000/);
    assert.doesNotMatch(reason(v), /1760480000000/, 'a migration already on source/dev was read as new: the series came from origin');
  });
  it('lets a personal repository push its own main to a host outside ownerHosts', () => {
    const v = at(own, 'main', 'git push secret main');
    assert.equal(v.kind, 'silent', reason(v));
  });
  it('still refuses a feature push into main on the company remote (guard: fails if the rule is dropped instead of scoped)', () => {
    const v = at(lines, 'feature/x', 'git push source HEAD:main');
    assert.equal(v.kind, 'deny', reason(v)); assert.match(reason(v), /push в main разрешён только с release\/\* или hotfix\/\*/);
  });
  it('refuses a push into main through a remote it cannot resolve — an unknown host is not a foreign host', () => {
    const v = at(own, 'main', 'git push nowhere main');
    assert.equal(v.kind, 'deny', reason(v)); assert.match(reason(v), /push в main разрешён только/);
  });
});

// REGRESSION 19.10: a migration renamed 048→051 by git mv, pushed to its own branch, was denied as a duplicate of 048 —
// H1 read the remote tip of the pushed branch as a merge target, though the push replaces it and drops 048.
// INVARIANT: H1 judges the tree the push leaves: the pushed tree, plus each merge target minus the files the branch
// removed since it left that line; both files in the pushed tree, or the line holding the body under another stamp, deny.
describe('pre-push H1: the pushed tree, not the files it removes', () => {
  const remoteDir = join(sb.dir, 'gitlab.corp.test', 'app.git');
  const app = join(sb.dir, 'app');
  const cfg = join(sb.dir, 'integration.json');
  const ENV = { CLAUDE_HARNESS_CONFIG: cfg, PREPUSH_PROTECTED: 'main' };
  const write = (files: Record<string, string>, subject: string): void => {
    for (const [p, c] of Object.entries(files)) { mkdirSync(join(app, dirname(p)), { recursive: true }); writeFileSync(join(app, p), c); }
    g(app, 'add', '-A'); g(app, 'commit', '-q', '-m', subject);
  };
  const at = (branch: string, command: string): Verdict => { g(app, 'checkout', '-q', branch); return run(command, null, ENV, app); };
  const M = 'src/migration';
  const op = (s: string): string => `${M}/18040000000${s}-add-cargo-inbound-operation-type.ts`;
  const reg = (s: string): string => `${M}/18040000000${s}-create-cargo-inbound-registry.ts`;
  const opBody = (s: string): string => migration(`18040000000${s}`, 'AddCargoInboundOperationType', 'cargo_op');
  const regBody = (s: string): string => migration(`18040000000${s}`, 'CreateCargoInboundRegistry', 'cargo_registry');
  const zone = (s: string): Record<string, string> => ({ [`${M}/18040000000${s}-add-zone-kind.ts`]: migration(`18040000000${s}`, 'AddZoneKind', 'zone_kind') });

  before(() => {
    writeFileSync(cfg, JSON.stringify({ protectedBranches: ['main'], integrationBranches: ['dev'] }));
    resetConfigCache();
    mkdirSync(dirname(remoteDir), { recursive: true }); g(sb.dir, 'init', '-q', '--bare', remoteDir);
    g(sb.dir, 'init', '-q', app); g(app, 'remote', 'add', 'source', remoteDir);
    write({ 'src/app.ts': 'export const a = 1;\n' }, 'feat: base');
    g(app, 'branch', '-M', 'main'); g(app, 'push', '-q', 'source', 'main', 'main:dev');
    g(app, 'checkout', '-q', '-b', 'feature/cargo-inbound-registry', 'main');
    write({ [op('48')]: opBody('48'), [reg('49')]: regBody('49') }, 'feat(cargo): inbound registry migrations');
    g(app, 'push', '-q', 'source', 'feature/cargo-inbound-registry');
    g(app, 'checkout', '-q', 'dev');
    write({
      [`${M}/1804000000048-add-sku-dimensions.ts`]: migration('1804000000048', 'AddSkuDimensions', 'sku_dim'),
      [`${M}/1804000000049-add-sku-weights.ts`]: migration('1804000000049', 'AddSkuWeights', 'sku_w'),
      ...zone('50'),
    }, 'feat: APP-2972 and 050 on dev');
    g(app, 'push', '-q', 'source', 'dev');
    g(app, 'checkout', '-q', '-b', 'feature/cargo-copy', 'feature/cargo-inbound-registry'); g(app, 'push', '-q', 'source', 'feature/cargo-copy');
    write({ [op('51')]: opBody('51') }, 'feat(cargo): the same migration under 051');
    g(app, 'checkout', '-q', 'feature/cargo-inbound-registry');
    g(app, 'mv', op('48'), op('51')); g(app, 'mv', reg('49'), reg('52'));
    write({ [op('51')]: opBody('51'), [reg('52')]: regBody('52') }, 'fix(cargo): renumber migrations 048/049 → 051/052');
    g(app, 'checkout', '-q', '-b', 'feature/cargo-squashed', 'main');
    g(app, 'push', '-q', 'source', 'source/feature/cargo-inbound-registry:refs/heads/feature/cargo-squashed');
    write({ [op('51')]: opBody('51'), [reg('52')]: regBody('52') }, 'feat(cargo): inbound registry migrations');
    g(app, 'checkout', '-q', '-b', 'feature/zone-again', 'main'); g(app, 'push', '-q', 'source', 'feature/zone-again');
    write(zone('53'), 'feat: zone kind again');
    g(app, 'checkout', '-q', '-b', 'fix/zone-renumber', 'dev');
    g(app, 'mv', `${M}/1804000000050-add-zone-kind.ts`, `${M}/1804000000054-add-zone-kind.ts`);
    write(zone('54'), 'fix: renumber zone kind');
    g(app, 'fetch', '-q', 'source');
  });
  after(() => resetConfigCache());

  it('passes the rename 048→051, 049→052 pushed to the same branch — the pushed tree no longer holds 048/049', () => {
    const v = at('feature/cargo-inbound-registry', 'git push source feature/cargo-inbound-registry');
    assert.equal(v.kind, 'silent', reason(v));
  });
  it('passes the same rename squashed into the first commit and force-pushed — the push replaces the old tip', () => {
    const v = at('feature/cargo-squashed', 'git push --force-with-lease source feature/cargo-squashed');
    assert.equal(v.kind, 'silent', reason(v));
  });
  it('denies the copy under 051 while 048 stays in the pushed tree, naming both files', () => {
    const v = at('feature/cargo-copy', 'git push source feature/cargo-copy');
    assert.equal(v.kind, 'deny', reason(v));
    assert.match(reason(v), /1804000000051-add-cargo-inbound-operation-type\.ts/); assert.match(reason(v), /1804000000048-add-cargo-inbound-operation-type\.ts/);
    assert.match(reason(v), /в отправляемом дереве/);
  });
  it('denies a feature push whose new migration the integration line already holds under another stamp', () => {
    const v = at('feature/zone-again', 'git push source feature/zone-again');
    assert.equal(v.kind, 'deny', reason(v));
    assert.match(reason(v), /1804000000053-add-zone-kind\.ts/); assert.match(reason(v), /1804000000050-add-zone-kind\.ts на source\/dev/);
  });
  it('denies the same branch as an MR into dev — the line keeps 050, which the branch never had', () => {
    const v = at('feature/zone-again', 'glab mr create --target-branch dev --title x');
    assert.equal(v.kind, 'deny', reason(v)); assert.match(reason(v), /1804000000050-add-zone-kind\.ts на source\/dev/);
  });
  it('passes a renumber pushed into the line itself — the file the branch removed is gone after the push', () => {
    const v = at('fix/zone-renumber', 'git push source HEAD:dev');
    assert.equal(v.kind, 'silent', reason(v));
  });
});

// INVARIANT: a wrapper that does not change what the shell runs does not let a feature branch into product/main, and
// the shim lets every wrapped form reach Node (test/_equivalence.ts).
describe('pre-push: equivalence classes', () => {
  it('never passes a feature push into product/main under any wrapper, and every form reaches Node', async () => {
    const payloadOf = (c: string): unknown => { const p = bashPayload(c) as Record<string, unknown>; p.cwd = repo; return p; };
    assert.deepEqual(await misses(['git push origin HEAD:product/main'], (c) => run(c, 'feature/js-1'), payloadOf, new Set(['deny', 'unknown'])), []);
  });
});
