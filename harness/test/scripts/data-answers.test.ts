// Порт части hooks/spec/data-boundary-guard.test.sh (22f586e) про анкету границ данных.
// INVARIANT: код возврата — функция класса «контур × вид данных», не суждения модели: DENY 2 · ANONYMIZE|SYNTHESIZE 1 ·
// ALLOW 0 · ошибка вызова 64; анкета печатает пять проверяемых вопросов и ровно одну строку `ВЕРДИКТ:`.
// Молча ломалось в черновике: `--env` без значения зацикливал `shift 2`, нечисловой `--rows` отбрасывался
// (`[ "$ROWS" -gt 1000 ] 2>/dev/null`), `--classify` с `limit 5000` на деве отвечал ANONYMIZE, пока гейт ту же
// команду блокировал. CLI-сторож без realpath (образец friction-prefilter.ts) давал rc 0 и пустой вывод при запуске
// через ~/.claude/harness — символическую ссылку на репозиторий.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { HARNESS_ROOT, NODE_BIN, sandbox } from '../_env.ts';
import { run, classify, answer, USAGE_RC, ROWS_THRESHOLD } from '../../scripts/data-answers.ts';

const QUESTIONS = ['Эти данные относятся к чувствительным', 'Могут раскрыть информацию о человеке', 'Объём похож на выкачку', 'Затрагивает секреты', 'Чем заменить'];
const verdictLine = (stdout: string): string[] => stdout.split('\n').filter((l) => l.startsWith('ВЕРДИКТ:'));

describe('scripts/data-answers', () => {
  // Семь классовых кейсов черновика — с обеих сторон каждой границы.
  const CLASSES: Array<[string, string[], number, string]> = [
    ['prod rows', ['--env', 'prod', '--kind', 'rows'], 2, 'DENY'],
    ['prod configuration', ['--env', 'prod', '--kind', 'config'], 0, 'ALLOW'],
    ['dev rows', ['--env', 'dev', '--kind', 'rows'], 1, 'ANONYMIZE'],
    ['personal fields on the stand', ['--env', 'stand', '--kind', 'pii'], 1, 'SYNTHESIZE'],
    ['a credential even in the local contour', ['--env', 'local', '--kind', 'credential'], 2, 'DENY'],
    ['a dump of the local stand', ['--env', 'local', '--kind', 'dump'], 0, 'ALLOW'],
    ['5000 rows from dev', ['--env', 'dev', '--kind', 'rows', '--rows', '5000'], 2, 'DENY'],
  ];
  for (const [what, argv, rc, verdict] of CLASSES) {
    it(`answers ${what} with ${verdict} and exit ${rc}`, () => {
      const out = run(argv);
      assert.deepEqual({ rc: out.rc, verdict: verdictLine(out.stdout).map((l) => l.split(' ')[1]) }, { rc, verdict: [verdict] });
    });
  }

  it('prints all five questions and exactly one verdict line — a lost question is a lost answer', () => {
    const out = run(['--env', 'prod', '--kind', 'pii']);
    assert.deepEqual(QUESTIONS.filter((q) => !out.stdout.includes(q)), []);
    assert.deepEqual(verdictLine(out.stdout).length, 1);
    assert.match(out.stdout, /^ВЕРДИКТ: DENY — прод-строки не читаем никогда/m);
  });

  it('keeps the threshold itself a spot check: 1000 rows from dev is ANONYMIZE, 1001 is DENY', () => {
    assert.equal(answer({ env: 'dev', kind: 'rows', dest: 'transcript', rows: ROWS_THRESHOLD }).verdict, 'ANONYMIZE');
    assert.equal(answer({ env: 'dev', kind: 'rows', dest: 'transcript', rows: ROWS_THRESHOLD + 1 }).verdict, 'DENY');
    assert.equal(answer({ env: 'local', kind: 'rows', dest: 'transcript', rows: 50000 }).verdict, 'ALLOW');
  });

  it('turns an ALLOW that leaves the team into ANONYMIZE, but lets configuration out as is', () => {
    assert.equal(run(['--env', 'dev', '--kind', 'aggregate', '--dest', 'external']).rc, 1);
    assert.equal(run(['--env', 'prod', '--kind', 'config', '--dest', 'external']).rc, 0);
  });

  it('classifies by text toward the stricter class and reads a stated LIMIT as the volume the gate would judge', () => {
    assert.deepEqual(classify('cat ~/.pgpass # see data-answers.sh'), { env: 'dev', kind: 'credential', rows: null });
    assert.equal(run(['--classify', "psql -h pg-dev -c 'select id from orders limit 5000'"]).rc, 2);
    assert.equal(run(['--classify', "psql -h pg-dev -c 'select id from orders limit 50'"]).rc, 1);
    assert.equal(run(['--classify', '~/.claude/bin/mcp-pg-prod.sh -c "select count(*) from orders"']).rc, 0);
    assert.equal(run(['--classify', "COPY orders TO stdout"]).rc, 2);
    assert.equal(run(['--classify', 'select count(*) from orders on prod', '--env', 'local']).rc, 0, 'явный --env главнее угадывания');
  });

  it('refuses a call it cannot answer with 64 and a reason instead of a silent default', () => {
    for (const argv of [['--env'], ['--env', 'nowhere', '--kind', 'rows'], ['--env', 'dev', '--kind', 'rows', '--rows', 'many'], ['--env', 'dev', '--kind', 'rows', '--dest', 'slack'], ['--bogus'], []]) {
      const out = run(argv);
      assert.deepEqual({ argv, rc: out.rc, stdout: out.stdout }, { argv, rc: USAGE_RC, stdout: '' });
      assert.match(out.stderr, /^data-answers: /);
    }
    assert.equal(run(['--help']).rc, 0);
  });

  describe('CLI', () => {
    const sb = sandbox('harness-answers-');
    after(() => sb.cleanup());
    const cli = (script: string, ...argv: string[]) => spawnSync(NODE_BIN, ['--disable-warning=ExperimentalWarning', script, ...argv], { encoding: 'utf8', timeout: 20000 });

    it('exits with the verdict code and prints the questionnaire when run as a script', () => {
      const r = cli(join(HARNESS_ROOT, 'scripts', 'data-answers.ts'), '--env', 'prod', '--kind', 'rows');
      assert.deepEqual({ status: r.status, verdict: verdictLine(r.stdout) }, { status: 2, verdict: ['ВЕРДИКТ: DENY — прод-строки не читаем никогда; на проде доступна только конфигурация по слоям'] });
    });

    it('runs the same way through a symlinked path — the guard compares real paths, not argv text', () => {
      const link = join(sb.dir, 'harness-link');
      symlinkSync(HARNESS_ROOT, link);
      const r = cli(join(link, 'scripts', 'data-answers.ts'), '--env', 'dev', '--kind', 'rows', '--rows', '5000');
      assert.deepEqual({ status: r.status, verdict: verdictLine(r.stdout).length }, { status: 2, verdict: 1 });
    });
  });
});
