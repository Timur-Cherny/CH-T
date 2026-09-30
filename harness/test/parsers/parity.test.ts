// INVARIANT: модель из дерева (model.ts) и модель по сегментам (stages.ts, флаг legacy) дают одну и ту же проекцию
// стадий на корпусе; каждое расхождение названо здесь с причиной — расхождение без строки в таблице красное.
// Проекция: имя, rest, уровень, функция, связка, here-doc, теги, stdin, stdout-файл, записи, динамические слова.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../../src/parsers/stages.ts';
import type { Model } from '../../src/parsers/stages.ts';

interface P { pipelines: unknown[]; tags: string[]; functions: unknown[]; assigns: unknown[]; deep: number }
const project = (m: Model<null>): P => ({
  pipelines: m.pipelines.map((p) => p.filter((s) => s.name !== '').map((s) => ({ name: s.name, rest: s.rest, level: s.level, fn: s.fn, inFunction: s.inFunction, link: s.link, heredocs: s.heredocs, tags: [...s.tags].sort(), stdin: s.stdin, stdoutTo: s.stdoutTo, writes: s.writes, dyn: s.rest.filter((_, k) => s.dynamic[s.restAt + k]) }))).filter((p) => p.length),
  tags: [...m.tags].sort(), functions: [...m.functions].sort(), assigns: [...m.assigns].sort(), deep: m.deep.length,
});
function both(cmd: string): [P, P] {
  process.env.CLAUDE_HARNESS_SHELL_PARSER = 'legacy';
  const a = project(buildModel<null>(cmd, () => null));
  delete process.env.CLAUDE_HARNESS_SHELL_PARSER;
  const b = project(buildModel<null>(cmd, () => null));
  return [a, b];
}

const SAME = [
  'PGPASSWORD=x psql -h db -Atc "$SQL" > /tmp/out.txt 2>&1',
  'kubectl exec pod/pg -- psql -U postgres -c "$SQL"',
  `bash -lc "psql -c '$SQL'"`,
  'q() { psql -At "$@"; }; q -c "SELECT 1"',
  'function q { psql -At "$@"; }; q -c "SELECT 1"',
  '# run each scenario\nrun() {\n  local name=$1; shift\n  psql -X "$@" 2>&1 | grep -v "^LINE"\n}\nrun "M1" -f a.sql && run "M2" -c ROLLBACK',
  'run() { kubectl exec -i pod/pg -- psql -U postgres "$@"; }; run -c "SELECT 1"',
  `cat > /tmp/q.sql <<'SQL'\nSELECT 1;\nSQL`,
  'echo x | tee -a /tmp/a.sql /tmp/b.sql',
  'PSQL=/opt/homebrew/opt/libpq/bin/psql; $PSQL -h db -c "SELECT 1"',
  'P=$(which psql); $P -c "SELECT 1"',
  `git commit -q -m "$(cat <<'EOF'\nfix: don't lose the (message\nEOF\n)" && npx jest --silent 2>&1 | tail -5`,
  "psql -d wms <<'SQL' | tail -3\nSELECT 1;\nSQL",
  `docker exec -i pg sh -c 'psql -U postgres -c "SELECT 1"'`,
  `su - postgres -c 'psql -c "SELECT 1"'`,
  `ssh -p 2222 -o StrictHostKeyChecking=no deploy@db-host 'psql -c "SELECT 1"'`,
  `watch 'psql -c "SELECT 1"'`,
  "sh -c 'echo start; psql -U postgres' <<'SQL'\nSELECT 1;\nSQL",
  "cat <<'SQL' | sh -c 'psql'\nSELECT 1;\nSQL",
  'psql -c "SELECT 1" > out.txt 2> err.log',
  'psql -c "SELECT 1" 2>&1 | tee log.txt',
  `kubectl -n lms-local exec deploy/postgres -- psql -U "$(kubectl -n lms-local exec deploy/postgres -- printenv POSTGRES_USER)" -lqt`,
  'echo "$(psql -Atc "$SQL")"',
  '=psql -c "SELECT 1"',
  'eval "psql -c \'SELECT 1\'"',
  'sudo -u postgres psql -c "SELECT 1"',
  'psql -c "SELECT 1" && psql -c "SELECT 2" || echo failed',
  'cd "$APP_ENGINE" && git commit -m "fix: a b" -F msg.txt; echo done',
  'if [ -n "$2" ]; then shift; fi; psql "$@"',
];

/** Расхождения по построению: грамматика видит то, что автомат по сегментам угадать не мог. */
const DIFFERENT: Array<[string, string, (legacy: P, grammar: P) => void]> = [
  ['{ psql -c "SELECT 1"; } > /tmp/o.txt', 'редирект группы достаётся стадиям внутри, а не псевдо-стадии `}`', (_, g) => {
    const st = (g.pipelines[0] as Array<{ name: string; stdoutTo: string | null }>)[0];
    assert.deepEqual([st.name, st.stdoutTo], ['psql', '/tmp/o.txt']);
  }],
  ['for f in $(ls *.sql); do psql -f "$f"; done', 'слова цикла — не стадия `for`; подстановка в них — уровень +1 без охватывающей стадии', (l, g) => {
    assert.ok((l.pipelines as Array<Array<{ name: string }>>).some((p) => p[0]?.name === 'for'));
    assert.deepEqual((g.pipelines as Array<Array<{ name: string; level: number }>>).map((p) => [p[0].name, p[0].level]), [['ls', 1], ['psql', 0]]);
  }],
  ['psql <<< "SET statement_timeout = 0"', 'here-string — stdin с известным текстом, а не объявленная граница', (l, g) => {
    assert.ok((l.pipelines[0] as Array<{ tags: string[] }>)[0].tags.includes('here-string'));
    assert.deepEqual((g.pipelines[0] as Array<{ heredocs: string[]; tags: string[] }>)[0], { ...(g.pipelines[0] as Array<{ heredocs: string[] }>)[0], heredocs: ['SET statement_timeout = 0\n'], tags: [] });
  }],
  ['while read -r f; do psql -f "$f"; done < list.txt', 'редирект цикла — stdin каждой стадии тела, а не псевдо-стадии `done`', (l, g) => {
    const psql = (p: P) => (p.pipelines as Array<Array<{ name: string; stdin: string | null }>>).flat().find((s) => s.name === 'psql');
    assert.equal(psql(l)?.stdin, null);
    assert.equal(psql(g)?.stdin, 'list.txt');
  }],
  ['case $1 in dev) psql -h dev -c "SELECT 1";; *) echo no;; esac', 'шаблоны case и их скобки — грамматика, не стадии и не разделители', (l, g) => {
    assert.deepEqual((g.pipelines as Array<Array<{ name: string }>>).map((p) => p.map((s) => s.name)), [['psql'], ['echo']]);
    assert.ok(l.pipelines.length > g.pipelines.length);
  }],
  ['echo a ) psql -c "SET x = 1"', 'скобка вне грамматики: parse-error на модели вместо тихого разбора остатка как команд', (l, g) => {
    assert.ok(!l.tags.includes('parse-error'));
    assert.ok(g.tags.includes('parse-error'));
  }],
];

describe('parity: model from the tree vs model from segments', () => {
  for (const cmd of SAME) it(`same projection: ${JSON.stringify(cmd.slice(0, 60))}`, () => { const [l, g] = both(cmd); assert.deepEqual(g, l); });
  for (const [cmd, why, check] of DIFFERENT) it(`differs by design — ${why}: ${JSON.stringify(cmd.slice(0, 40))}`, () => { const [l, g] = both(cmd); assert.notDeepEqual(g, l); check(l, g); });
});
