// INVARIANT: a note is flagged STALE ⟺ it carries a merge-status marker — in its prose or only in its MEMORY.md
// line — and a commit cited next to that marker already sits in a live line of its repository; a landed commit cited
// elsewhere in the note (a branch base, a reference tip) makes it MAYBE; quotations and status legends are not markers; a claim about production is a question (ASKPROD), never STALE; the INFO line names what was looked at.
// It broke silently: the bash prefilter answered «0 STALE» on a corpus where git refuted seven notes — its marker
// list did not contain the words the notes are written in, it skipped seven-character hashes, never read the index
// and knew one hard-coded pair of live lines. Nothing said that the zero came from not looking.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sandbox, HARNESS_ROOT, NODE_BIN } from '../_env.ts';
import { standardCorpus } from './_memory-fixture.ts';
import type { Corpus } from './_memory-fixture.ts';
import { run, prose, mergeMarker, prodMarker, hashes, liveLines, dupPairs } from '../../scripts/memory-prefilter.ts';

const NOW = new Date(2026, 8, 20, 12, 0, 0).getTime();
const sb = sandbox('harness-memory-prefilter-');
after(() => sb.cleanup());

const c: Corpus = standardCorpus(sb, NOW);
const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: sb.home };
const rows = (flag: string, argv = [c.mem, c.engine, c.brain]): Array<[string, string]> =>
  run(argv, { env, now: () => NOW }).stdout.split('\n').filter(Boolean).map((l) => l.split('\t')).filter(([f]) => f === flag).map(([, file, evidence]) => [file, evidence]);
const flagged = (flag: string): string[] => rows(flag).map(([file]) => file).sort();

describe('run', () => {
  it('flags exactly the notes whose merge status git has refuted — by the words the notes are written in, a seven-character hash, a branch named in backticks', () => {
    assert.deepEqual([flagged('STALE'), flagged('MAYBE')], [['brain-line.md', 'index-with-hash.md', 'merged-says-not.md', 'ref-in-backticks.md', 'twin-says-not.md'], ['base-is-not-the-work.md', 'index-only.md']],
      'Miss this and the review reports «снято статусов 0» while the memory keeps telling sessions that merged work is still open');
  });

  it('says where the refuting commit lives: repository, live line and the first release tag', () => {
    const [[, evidence]] = rows('STALE').filter(([file]) => file === 'merged-says-not.md');
    assert.equal(evidence, `маркер «не влит» · «Фикс \`${c.landed7}\` в MR !1 (dev) и !2 (release), не влит.» — рядом ${c.landed7}→engine:source/rel/main [v1.0.0]`);
  });

  it('reads the status that lives only in the MEMORY.md line and says so', () => {
    const [[, evidence]] = rows('MAYBE').filter(([file]) => file === 'index-only.md');
    assert.match(evidence, /^маркер «не смёржены» \(только строка индекса\) · «- \[index-only\]\(index-only\.md\) — хотфикс чтения строк: MR !4 dev, !5 main, не смёржены» — рядом приземлившихся коммитов нет; ещё в живых линиях: /u);
  });

  it('calls it stale when the index line itself names the landed commit beside the marker', () => {
    const [[, evidence]] = rows('STALE').filter(([file]) => file === 'index-with-hash.md');
    assert.match(evidence, /^маркер «не смёржены» \(только строка индекса\) · «.+» — рядом [0-9a-f]{8}→engine:source\/rel\/main \[v1\.0\.0\]$/u);
  });

  it('sees the twin: a dev commit cherry-picked into main under another hash has landed, whatever its own hash says', () => {
    const [[, evidence]] = rows('STALE').filter(([file]) => file === 'twin-says-not.md');
    assert.equal(evidence, `маркер «не влита» · «Правка \`${c.picked.slice(0, 8)}\` из dev-ветки в MR !9, не влита.» — рядом ${c.picked.slice(0, 8)}≈${c.twin.slice(0, 7)}→engine:source/rel/main`,
      'Miss this and every fix that reached main through a release cherry-pick stays «не влит» in memory forever — ancestry never finds it');
  });

  it('does not take a namesake for a twin: the same subject with another patch has not landed, and a merge has no patch to compare', () => {
    const all = [...flagged('STALE'), ...flagged('MAYBE')];
    assert.deepEqual(['same-subject-other-patch.md', 'merge-is-not-a-patch.md'].filter((n) => all.includes(n)), []);
  });

  it('checks a repository without site lines against the branch its remote HEAD names', () => {
    const [[, evidence]] = rows('STALE').filter(([file]) => file === 'brain-line.md');
    assert.match(evidence, /— рядом [0-9a-f]{7}→brain:secret\/main$/u);
  });

  it('keeps a status that git confirms: the cited commit is only in a feature branch', () => {
    assert.ok(![...flagged('STALE'), ...flagged('MAYBE')].includes('still-open.md'));
  });

  it('does not call a note stale over the base its branch grew from — the landed commit is not the one the marker is about', () => {
    const [[, evidence]] = rows('MAYBE').filter(([file]) => file === 'base-is-not-the-work.md');
    assert.equal(evidence, `маркер «не влита» · «Сама правка \`${c.open.slice(0, 8)}\` в MR !6, не влита.» — рядом приземлившихся коммитов нет; ещё в живых линиях: ${c.landed7}→engine:source/rel/main [v1.0.0]; вне живых линий: ${c.open.slice(0, 8)}`,
      'Miss this and every note that names the tip it branched from is handed to the reviewer as stale, week after week');
  });

  it('asks about production instead of calling the note stale — git knows the tag, not what is deployed', () => {
    assert.deepEqual(rows('ASKPROD').map(([file, evidence]) => [file, evidence]), [['prod-absent.md', `маркер «на проде его нет», а коммит уже в релизном теге: ${c.landed7}→engine:source/rel/main [v1.0.0] — что на проде, git не знает`]]);
    assert.ok(!flagged('STALE').includes('prod-absent.md'));
  });

  it('reports a note without an index line and an index line without a note', () => {
    assert.deepEqual(rows('ORPHAN'), [['unindexed.md', 'нет в MEMORY.md'], ['MEMORY.md', 'строка индекса без файла: ghost.md']]);
  });

  it('flags age by the last change and heat by the worklogs of this HOME', () => {
    assert.deepEqual(rows('AGE60'), [['old-note.md', '100 дней без правки']]);
    assert.deepEqual(rows('HOT'), [['hot-note.md', '3 упоминаний в worklog']]);
  });

  it('pairs the two notes about one subject and not the notes that merely share the vocabulary of their domain', () => {
    assert.deepEqual(flagged('DUP'), ['scripts-language-a.md + scripts-language-b.md'],
      'Miss this and the reviewer is handed dozens of pairs to read where one is real');
  });

  it('names its denominators, and says outright when no repository was given — a zero is not a clean bill', () => {
    const [[, withRepos]] = rows('INFO');
    assert.match(withRepos, /^нот 22; с маркером статуса 11; хешей в них 12, известны репозиториям 12, в живых линиях 8 \(из них близнецами 1\); репозиториев 2 \(engine: source\/rel\/main,source\/rel\/dev; brain: secret\/main\)$/u);
    const [[, without]] = rows('INFO', [c.mem]);
    assert.match(without, /репозиториев 0 — STALE, MAYBE и ASKPROD не проверялись$/u);
    assert.deepEqual([...rows('STALE', [c.mem]), ...rows('MAYBE', [c.mem])], []);
  });

  it('refuses a missing memory directory out loud instead of printing nothing', () => {
    const out = run([join(sb.dir, 'nowhere')], { env });
    assert.deepEqual([out.rc, out.stdout], [2, '']);
    assert.match(out.stderr, /каталога памяти нет/u);
  });
});

describe('prose', () => {
  it('drops quotations and legends, and keeps a branch name as a reference the marker can lean on', () => {
    assert.equal(mergeMarker(prose('заголовок `fix: y [DRAFT]` из истории')), null);
    assert.equal(mergeMarker(prose('```\nне влит\n```')), null);
    assert.equal(prose('a\n```\nне влит\n```\nb').split('\n').length, 5, 'a blanked block must keep its lines, or the marker is traced to the wrong line');
    assert.equal(mergeMarker(prose('✅ done · 🔵 in progress · ⏸ parked')), null);
    assert.equal(mergeMarker(prose('основная задача ⏸ crit')), '⏸');
    assert.equal(mergeMarker(prose('в `source/rel/main` нет')), 'в §REF§ нет');
    assert.equal(mergeMarker(prose('в `tsconfig.json` нет поля')), null);
  });
});

describe('mergeMarker', () => {
  for (const said of ['не влит', 'не влита', 'Не влито', 'не смёржены', 'не смержен', 'не запушено', 'НЕ закоммичено', 'MR !50 черновиком', 'тег не заводить', 'миграция не обкатана', 'открыт !185', 'релизы !202/!114/!56 открыты', 'ждут слова Анны', 'до слова Анны']) {
    it(`hears «${said}»`, () => { assert.notEqual(mergeMarker(said), null); });
  }
  for (const said of ['влит в dev 10.09', 'смёржен в main', 'невлитых коммитов 18', 'подчерновик', 'открытый экран FBS не обновляется']) {
    it(`does not hear a status in «${said}»`, () => { assert.equal(mergeMarker(said), null); });
  }
});

describe('prodMarker', () => {
  it('hears absence on production and nothing else', () => {
    assert.deepEqual(['на проде нет', 'на проде 1.46.0 его нет', 'на прод не выкачен', 'на проде всё есть', 'прод переведён 17.09', 'на проде всё работает. Нет только логов'].map(prodMarker), ['на проде нет', 'на проде 1.46.0 его нет', 'на прод не выкачен', null, null, null]);
  });
});

describe('hashes', () => {
  it('takes seven characters and up, keeps a short hash made of digits alone, skips timestamps and plain words', () => {
    assert.deepEqual(hashes('заказ 1201157, ba0d1a9, 14b86a5d и 1789578331359; слово defaced, снова ba0d1a9; tsc 565 = базе'), ['ba0d1a9', '14b86a5d', '1201157'],
      'Miss this and one short hash in thirty — the ones without a letter — is never checked against git');
  });
});

describe('liveLines', () => {
  it('is the protected and integration branches of the site config where they exist, the remote HEAD elsewhere, and never a feature branch', () => {
    assert.deepEqual([liveLines(c.engine), liveLines(c.brain)], [['source/rel/main', 'source/rel/dev'], ['secret/main']]);
  });
});

describe('dupPairs', () => {
  it('ignores words half the corpus shares', () => {
    const notes = ['a', 'b', 'c', 'd'].map((n) => ({ name: `returns-${n}.md`, description: 'возврат короба после стадии упаковки' }));
    assert.deepEqual(dupPairs(notes), []);
  });
});

describe('memory-prefilter.ts as a command', () => {
  const script = join(HARNESS_ROOT, 'scripts', 'memory-prefilter.ts');
  const cli = (path: string): string[] => {
    const r = spawnSync(NODE_BIN, ['--disable-warning=ExperimentalWarning', path, c.mem, c.engine, c.brain], { encoding: 'utf8', env: { PATH: env.PATH, HOME: sb.home } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.split('\n').filter((l) => l.startsWith('STALE\t')).map((l) => l.split('\t')[1]).sort();
  };

  it('hears Cyrillic markers with no locale in the environment', () => {
    assert.deepEqual(cli(script), ['brain-line.md', 'index-with-hash.md', 'merged-says-not.md', 'ref-in-backticks.md', 'twin-says-not.md'],
      'Miss this and the tool shell, which has no LANG at all, compares Cyrillic byte by byte and hears nothing');
  });

  it('runs when it is reached through a symlinked directory — silence there would read as «nothing to review»', () => {
    const link = join(sb.dir, 'linked-harness'); symlinkSync(HARNESS_ROOT, link);
    assert.deepEqual(cli(join(link, 'scripts', 'memory-prefilter.ts')), ['brain-line.md', 'index-with-hash.md', 'merged-says-not.md', 'ref-in-backticks.md', 'twin-says-not.md']);
  });
});
