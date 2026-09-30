// INVARIANT: every statement of «what changed» that reaches business or users is backed by a fact read from git —
// a UI text added or removed, an API route, a migration, a test title, a commit — and an EMPTY range is never green.
// What broke silently: release notes written from memory called things «added» that were never merged and kept quiet
// about what was removed; an empty range (swapped tags) read as «nothing changed» instead of an error.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { sandbox } from '../_env.ts';
import { collect, run, classify, flattenKeys, routesOf, testTitles, shareOf, sessionRanges, type RangeFacts, type SessionFacts, type Share } from '../../scripts/change-facts.ts';
import { State } from '../../src/state.ts';
import { shortHash } from '../../src/session/common.ts';

const sb = sandbox('change-facts-');
after(() => sb.cleanup());

function repo(name: string): { dir: string; git: (...a: string[]) => string; put: (p: string, text: string) => void; del: (p: string) => void; commit: (msg: string, date: string) => string } {
  const dir = join(sb.dir, name);
  mkdirSync(dir, { recursive: true });
  const git = (...a: string[]): string => {
    const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
    assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'fixture');
  return {
    dir, git,
    put: (p, text) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), text); },
    del: (p) => rmSync(join(dir, p)),
    commit: (msg, date) => { git('add', '-A'); spawnSync('git', ['commit', '-q', '-m', msg], { cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }); return git('rev-parse', 'HEAD'); },
  };
}

const CONTROLLER = (routes: string) => `@Controller({ path: '/admin/orders' })\nexport class OrdersController {\n${routes}}\n`;

const r = repo('app');
r.put('package.json', JSON.stringify({ name: 'app', version: '4.2.3' }));
r.put('src/i18n/ru/ru.json', JSON.stringify({ wms: { wrongBarcode: 'Неверный штрихкод', addUnitload: 'Добавить тару', tabs: { choose: 'Выбрать' } } }));
r.put('src/orders.controller.ts', CONTROLLER("  @Get('/:id/unitloads')\n  list() {}\n  @Delete('/:id/legacy')\n  legacy() {}\n"));
r.put('src/screens/Scan.screen.tsx', 'export const Scan = 1;\n');
r.commit('chore: baseline (NO-JS)', '2026-09-18T10:00:00+06:00');
r.git('tag', 'v4.2.3');

r.put('package.json', JSON.stringify({ name: 'app', version: '4.3.0' }));
r.put('src/i18n/ru/ru.json', JSON.stringify({ wms: { wrongBarcode: 'Неверный штрихкод', addUnitload: 'Добавить новую', scanCarrierFirst: 'Сначала отсканируйте короб' } }));
r.put('src/orders.controller.ts', CONTROLLER("  @Get('/:id/unitloads')\n  list() {}\n  @Post('/dispatch')\n  dispatch() {}\n"));
r.put('src/migration/1789823538932-add-fast-dispatch-option.ts', 'export class AddFastDispatchOption1789823538932 {\n  async up() { return 1; }\n  async down() {}\n}\n');
r.put('src/screens/packingGate.test.ts', "it('holds goods back until a box is bound', () => {});\nit.each([[1]])('never holds goods back where packing is %s', () => {});\n");
r.put('src/screens/Scan.screen.tsx', 'export const Scan = 2;\n');
const feature = r.commit('feat(packing): bind a box from the scan field (NO-JS)\n\nbody', '2026-09-19T12:00:00+06:00');
r.del('src/screens/Scan.screen.tsx');
r.put('docs/notes.md', '# notes\n');
r.commit('fix(scan)!: drop the legacy scan screen (APP-1234)', '2026-09-19T13:00:00+06:00');
r.git('tag', 'v4.3.0');

const memory = join(sb.dir, 'memory');
mkdirSync(memory, { recursive: true });
writeFileSync(join(memory, 'packing.md'), `---\nname: packing-by-scan\ndescription: "упаковка сканом"\nmetadata:\n  type: project\n---\n\nветка от main, коммит \`${feature.slice(0, 7)}\` — тело ноты наружу не уходит\n`);
writeFileSync(join(memory, 'other.md'), '---\nname: unrelated\ndescription: "про другое"\nmetadata:\n  type: project\n---\n\nничего общего\n');

const facts = (): RangeFacts => {
  const out = collect({ ranges: [{ repo: r.dir, from: 'v4.2.3', to: 'v4.3.0' }], memoryDir: memory });
  assert.equal(out.ranges.length, 1);
  return out.ranges[0]!;
};

describe('change-facts: what a range changed, read from git', () => {
  it('lists the commits of the range with their type, scope, task and breaking mark, and leaves the baseline out', () => {
    const f = facts();
    assert.deepEqual(f.commits.map((c) => [c.type, c.scope, c.task, c.breaking, c.subject]), [
      ['fix', 'scan', 'APP-1234', true, 'fix(scan)!: drop the legacy scan screen (APP-1234)'],
      ['feat', 'packing', 'NO-JS', false, 'feat(packing): bind a box from the scan field (NO-JS)'],
    ]);
    assert.deepEqual(f.version, { from: '4.2.3', to: '4.3.0' });
  });

  it('reports UI texts added, removed and reworded — the words an operator actually reads', () => {
    const texts = facts().texts.filter((t) => t.file.endsWith('ru.json'));
    assert.deepEqual(texts.map((t) => [t.change, t.key, t.before, t.after]), [
      ['changed', 'wms.addUnitload', 'Добавить тару', 'Добавить новую'],
      ['added', 'wms.scanCarrierFirst', null, 'Сначала отсканируйте короб'],
      ['removed', 'wms.tabs.choose', 'Выбрать', null],
    ]);
  });

  it('reports API routes added and removed, never the ones that stayed', () => {
    assert.deepEqual(facts().routes, [
      { change: 'added', route: 'POST /admin/orders/dispatch', file: 'src/orders.controller.ts' },
      { change: 'removed', route: 'DELETE /admin/orders/:id/legacy', file: 'src/orders.controller.ts' },
    ]);
  });

  it('names an added migration and says when its down() restores nothing', () => {
    assert.deepEqual(facts().migrations, [{ file: 'src/migration/1789823538932-add-fast-dispatch-option.ts', down: 'empty' }]);
  });

  it('carries the titles of added tests — in this codebase they are statements of behaviour', () => {
    assert.deepEqual(facts().tests, ['holds goods back until a box is bound', 'never holds goods back where packing is %s']);
  });

  it('sorts changed files into layers and counts a deleted screen as a removal', () => {
    const f = facts();
    assert.equal(f.layers.ui, 1); assert.equal(f.layers.texts, 1); assert.equal(f.layers.api, 1);
    assert.equal(f.layers.migration, 1); assert.equal(f.layers.test, 1); assert.equal(f.layers.docs, 1);
    assert.deepEqual(f.removedFiles, ['src/screens/Scan.screen.tsx']);
  });

  it('says where the end of the range lives: the tags on it and the branches that contain it', () => {
    const f = facts();
    assert.deepEqual(f.containment.tags, ['v4.3.0']);
    assert.deepEqual(f.containment.branches, ['main']);
  });

  it('finds the memory notes that name a commit of the range, and hands back only their name and description', () => {
    assert.deepEqual(facts().memory, [{ name: 'packing-by-scan', description: 'упаковка сканом' }]);
  });
});

describe('change-facts: a branch is compared with the point it left, not with where the mainline went since', () => {
  // main: v4.3.0 → (branch leaves here) → main adds a route and a screen. The branch only rewords one text.
  r.git('checkout', '-q', '-b', 'feature/rewording', 'v4.3.0');
  r.put('src/i18n/ru/ru.json', JSON.stringify({ wms: { wrongBarcode: 'Не тот штрихкод', addUnitload: 'Добавить новую', scanCarrierFirst: 'Сначала отсканируйте короб' } }));
  const reworded = r.commit('fix(texts): say which barcode was wrong (NO-JS)', '2026-09-20T09:00:00+06:00');
  r.git('checkout', '-q', 'main');
  r.put('src/orders.controller.ts', CONTROLLER("  @Get('/:id/unitloads')\n  list() {}\n  @Post('/dispatch')\n  dispatch() {}\n  @Post('/handover')\n  handover() {}\n"));
  r.put('src/screens/Handover.screen.tsx', 'export const Handover = 1;\n');
  r.commit('feat(handover): hand a cell over (NO-JS)', '2026-09-20T10:00:00+06:00');
  writeFileSync(join(memory, 'mainline.md'), '---\nname: mainline-chatter\ndescription: "упоминает main"\nmetadata:\n  type: project\n---\n\nветка от main, мерж в main\n');

  const branch = (): RangeFacts => collect({ ranges: [{ repo: r.dir, from: 'main', to: 'feature/rewording' }], memoryDir: memory }).ranges[0]!;

  it('never reports what the mainline added after the fork as removed by the branch — that would tell business a shipped feature was deleted', () => {
    const f = branch();
    assert.deepEqual(f.routes, []);
    assert.deepEqual(f.removedFiles, []);
    assert.deepEqual(f.texts.map((t) => [t.change, t.key]), [['changed', 'wms.wrongBarcode']]);
    assert.deepEqual(f.commits.map((c) => c.sha), [reworded]);
  });

  it('says that the range diverged and by how many commits, so the notes can warn that the mainline moved', () => {
    assert.deepEqual(branch().diverged, { behind: 1 });
    assert.equal(facts().diverged, null);
  });

  it('matches memory notes by commits, tags and the branch itself — never by the name of a mainline every note mentions', () => {
    assert.deepEqual(branch().memory, []);
    writeFileSync(join(memory, 'rewording.md'), '---\nname: rewording-work\ndescription: "правка текстов"\nmetadata:\n  type: project\n---\n\nветка feature/rewording\n');
    assert.deepEqual(branch().memory.map((m) => m.name), ['rewording-work']);
  });
});

describe('change-facts: an empty or broken range is not green', () => {
  it('exits 1 on a range without commits — swapped tags must not read as «nothing changed»', () => {
    const out = run(['--repo', r.dir, '--from', 'v4.3.0', '--to', 'v4.2.3']);
    assert.equal(out.rc, 1);
    assert.match(out.stderr, /пуст/);
  });

  it('exits 2 on a ref that does not resolve, naming it', () => {
    const out = run(['--repo', r.dir, '--from', 'v9.9.9', '--to', 'v4.3.0']);
    assert.equal(out.rc, 2);
    assert.match(out.stderr, /v9\.9\.9/);
  });

  it('exits 64 on an incomplete triplet instead of guessing the range', () => {
    assert.equal(run(['--repo', r.dir, '--from', 'v4.2.3']).rc, 64);
    assert.equal(run([]).rc, 64);
  });

  it('prints one JSON document on success', () => {
    const out = run(['--repo', r.dir, '--from', 'v4.2.3', '--to', 'v4.3.0']);
    assert.equal(out.rc, 0);
    assert.equal((JSON.parse(out.stdout) as { ranges: unknown[] }).ranges.length, 1);
  });
});

describe('shareOf', () => {
  const cases: Array<[string, Record<string, unknown>, Share | null]> = [
    ['a commit proven to be the session\'s', { session: 'S', attribution: 'session' }, 'session'],
    ['a commit proven to be another session\'s', { session: 'X', attribution: 'session' }, null],
    ['an overlap the session is named in', { session: null, attribution: 'overlapping', candidates: ['S', 'X'] }, 'shared'],
    ['a window that names the session as a candidate', { session: null, attribution: 'window', candidates: ['S'] }, 'shared'],
    ['a window with no evidence at all', { session: null, attribution: 'window' }, null],
    ['a line written before attribution existed, by the session', { session: 'S' }, 'legacy'],
  ];
  for (const [name, row, want] of cases) it(`reads ${name} as ${want}`, () => assert.equal(shareOf(row, 'S'), want));
});

describe('change-facts --session: ranges come from the commits journal, not from what the session remembers', () => {
  // base ← c1 ← c2 (proven) ← f (another session) ← c4 (shared) ← c5 (made in its worktree, not settled yet)
  const w = repo('session-app');
  w.put('a.txt', '0\n'); const base = w.commit('chore: base', '2026-09-20T10:00:00+06:00');
  w.put('a.txt', '1\n'); const c1 = w.commit('feat: one', '2026-09-20T10:01:00+06:00');
  w.put('a.txt', '2\n'); const c2 = w.commit('feat: two', '2026-09-20T10:02:00+06:00');
  w.put('a.txt', '3\n'); const f = w.commit('feat: someone else', '2026-09-20T10:03:00+06:00');
  w.put('a.txt', '4\n'); const c4 = w.commit('feat: four', '2026-09-20T10:04:00+06:00');
  w.put('a.txt', '5\n'); const c5 = w.commit('feat: five', '2026-09-20T10:05:00+06:00');
  const state = join(sb.dir, 'session-state');
  const st = State.open(state);
  st.db.prepare('INSERT INTO session_roots(session_id, repo, first_seen) VALUES(?,?,?)').run('S', w.dir, 1);
  st.db.prepare('INSERT INTO head_moves(repo, session_id, started_at, ended_at, named) VALUES(?,?,?,?,1)').run(w.dir, 'S', 1, 2);
  st.db.prepare("INSERT INTO pending_commits(repo, hash, due_at, kind) VALUES(?,?,?,'made')").run(w.dir, c5, 9);
  st.close();
  const journal = join(sb.dir, 'session-commits.jsonl');
  const line = (o: Record<string, unknown>): string => JSON.stringify({ ts: 't', adapter: 'harness-v4', repo_hash: shortHash(w.dir), ...o });
  writeFileSync(journal, [
    line({ session: 'S', attribution: 'session', commit_hash: c1 }), line({ session: 'S', attribution: 'session', commit_hash: c2 }),
    line({ session: 'X', attribution: 'session', commit_hash: f }),
    line({ session: null, attribution: 'overlapping', candidates: ['S', 'X'], commit_hash: c4 }),
    line({ session: null, attribution: 'window', commit_hash: base }),
    line({ session: 'S', attribution: 'session', commit_hash: c1 }),
  ].join('\n') + '\n');

  it('chains the session commits along first parents, leaving out the foreign commit between them and a commit nobody can be named for', () => {
    const { facts, ranges } = sessionRanges('S', journal, state);
    assert.deepEqual(ranges.map((r) => [r.from, r.to]), [[base, c2], [f, c5]], 'the ranges swallowed a commit the session did not make, or lost one it did');
    assert.deepEqual(facts.commits.map((c) => [c.sha, c.share]), [[c1, 'session'], [c2, 'session'], [c4, 'shared'], [c5, 'pending']]);
  });

  it('answers 1 for a session with no commit of its own in the journal — an empty session is not «nothing changed»', () => {
    const out = run(['--session', 'NOBODY', '--journal', journal, '--state', state]);
    assert.equal(out.rc, 1, out.stderr);
  });

  it('prints the facts of the derived ranges with the session attribution beside them', () => {
    const out = run(['--session', 'S', '--journal', journal, '--state', state]);
    assert.equal(out.rc, 0, out.stderr);
    const doc = JSON.parse(out.stdout) as { session: SessionFacts; ranges: RangeFacts[] };
    assert.equal(doc.session.commits.length, 4);
    assert.deepEqual(doc.ranges.map((r) => r.commits.map((c) => c.sha)), [[c2, c1], [c5, c4]]);
  });
});

describe('change-facts: the small parsers', () => {
  it('classify puts a file into one layer, tests before everything else', () => {
    assert.equal(classify('src/screens/WMS/packingGate.test.ts'), 'test');
    assert.equal(classify('src/screens/WMS/FixedScanning.screen.tsx'), 'ui');
    assert.equal(classify('src/components/WMS/UnitLoad.component.tsx'), 'ui');
    assert.equal(classify('src/i18n/ru/ru.json'), 'texts');
    assert.equal(classify('src/module/order/order-admin.controller.ts'), 'api');
    assert.equal(classify('src/module/order/dto/add-unitload-body.dto.ts'), 'contract');
    assert.equal(classify('src/migration/1-x.ts'), 'migration');
    assert.equal(classify('.gitlab-ci.yml'), 'ci');
    assert.equal(classify('README.md'), 'docs');
    assert.equal(classify('src/module/order/service/order.service.ts'), 'logic');
  });

  it('flattenKeys keeps only leaf strings under dotted keys', () => {
    assert.deepEqual(flattenKeys({ a: { b: 'x', c: { d: 'y' } }, n: 1, arr: ['z'] }), new Map([['a.b', 'x'], ['a.c.d', 'y']]));
  });

  it('routesOf joins the controller path with each verb, for both decorator forms', () => {
    assert.deepEqual(routesOf("@Controller('/admin/units')\nclass C {\n  @Get('/')\n  a() {}\n  @Patch('/mobile/:id')\n  b() {}\n}"), ['GET /admin/units', 'PATCH /admin/units/mobile/:id']);
    assert.deepEqual(routesOf("@Controller({\n  path: '/admin/orders',\n})\nclass C {\n  @Post()\n  a() {}\n}"), ['POST /admin/orders']);
  });

  it('testTitles reads added test titles only, from it, test and their each forms', () => {
    const diff = "+it('a box is bound', () => {});\n-it('removed one', () => {});\n+  test(\"double quoted\", () => {});\n+it.each<[string]>([['x']])('each %s form', () => {});\n+const notATest = it;\n";
    assert.deepEqual(testTitles(diff), ['a box is bound', 'double quoted', 'each %s form']);
  });
});
