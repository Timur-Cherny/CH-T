// INVARIANT: стадия несёт то, что запустится, а не буквы команды — какое слово собрано подстановкой (dynamic),
// внутри ли функции она стоит (аргументы и stdin приходят с места вызова), какие файлы пишет. Без этого гейт
// судил SQL по буквам `$SQL`, не видел psql за `function q { psql "$@"; }` и читал с диска старый SQL-файл,
// который эта же команда перезаписывает (spec-critic 16.09, Gap 1, 2, 7).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../../src/parsers/stages.ts';
import type { Stage } from '../../src/parsers/stages.ts';

const stages = (cmd: string): Stage<null>[] => buildModel<null>(cmd, () => null).pipelines.flat();
const named = (cmd: string, name: string): Stage<null> => {
  const st = stages(cmd).find((s) => s.name === name);
  assert.ok(st, `стадия ${name} не найдена в ${JSON.stringify(cmd)}`);
  return st;
};
const restDynamic = (st: Stage<null>): string[] => {
  assert.ok(Array.isArray(st.dynamic) && Number.isInteger(st.restAt), 'стадия без флагов подстановки: гейт судит буквы `$SQL` вместо значения');
  return st.rest.filter((_, k) => st.dynamic[st.restAt + k]);
};

describe('buildModel', () => {
  it('aligns dynamic flags with argv after redirects and prefixes are stripped', () => {
    const st = named(`PGPASSWORD=x psql -h db -Atc "$SQL" > /tmp/out.txt 2>&1`, 'psql');
    assert.deepEqual(restDynamic(st), ['$SQL']);
    assert.deepEqual(st.rest, ['-h', 'db', '-Atc', '$SQL']);
  });
  it('keeps the flag through kubectl exec -- and through sh -c whose body the outer shell expanded', () => {
    assert.deepEqual(restDynamic(named(`kubectl exec pod/pg -- psql -U postgres -c "$SQL"`, 'psql')), ['$SQL']);
    assert.deepEqual(restDynamic(named(`kubectl exec pod/pg -- psql -U postgres -c 'SELECT $1'`, 'psql')), []);
    assert.deepEqual(restDynamic(named(`bash -lc "psql -c '$SQL'"`, 'psql')), ['$SQL']);
    assert.deepEqual(restDynamic(named(`bash -lc 'psql -c "SELECT 1"'`, 'psql')), []);
  });
  it('marks stages inside a function body in all three spellings, and not the call site', () => {
    for (const def of ['q() { psql -At "$@"; }', 'function q { psql -At "$@"; }', 'function q() { psql -At "$@"; }']) {
      const all = stages(`${def}; q -c "SELECT 1"`);
      assert.equal(all.find((s) => s.name === 'psql')?.inFunction, true, def);
      assert.equal(all.find((s) => s.name === 'q')?.inFunction, false, `${def}: место вызова`);
    }
    assert.equal(named('{ psql -c "SELECT 1"; } > /tmp/o.txt', 'psql').inFunction, false, 'группа команд — не функция');
  });
  it('records the function name, the shell level, the word sources and the && link; the name segment of `f () {` is not a stage', () => {
    const all = stages('# run each scenario\nrun() {\n  local name=$1; shift\n  psql -X "$@" 2>&1 | grep -v "^LINE"\n}\nrun "M1" -f a.sql && run "M2" -c ROLLBACK');
    const psql = named('# run each scenario\nrun() {\n  local name=$1; shift\n  psql -X "$@" 2>&1 | grep -v "^LINE"\n}\nrun "M1" -f a.sql && run "M2" -c ROLLBACK', 'psql');
    assert.deepEqual([psql.fn, psql.level, psql.inFunction], ['run', 0, true], 'комментарий с именем функции перед объявлением сдвигал промежутки, и тело терялось');
    assert.deepEqual(psql.src.slice(psql.restAt), ['-X', '"$@"']);
    assert.deepEqual(all.filter((s) => s.name === 'run').map((s) => [s.fn, s.rest, s.link]), [[null, ['M1', '-f', 'a.sql'], 'none'], [null, ['M2', '-c', 'ROLLBACK'], 'and']]);
    assert.equal(all.find((s) => s.name === 'shift')?.fn, 'run');
  });
  it('declares functions with their level, definition count and flatness', () => {
    const fns = (cmd: string) => buildModel<null>(cmd, () => null).functions;
    assert.deepEqual(fns('q() { psql -At "$@"; }; q -c "SELECT 1"').get('q'), { defs: 1, level: 0, flat: true });
    assert.deepEqual(fns('function q() { psql -At "$@"; }').get('q'), { defs: 1, level: 0, flat: true }, '() объявления — не подоболочка');
    assert.equal(fns('q() { if [ -n "$2" ]; then shift; fi; psql "$@"; }').get('q')?.flat, false);
    assert.equal(fns('q() { (shift); psql "$@"; }').get('q')?.flat, false);
    assert.equal(fns('q() { psql "$@"; }; q() { psql -At "$@"; }').get('q')?.defs, 2);
    assert.equal(fns(`bash -c 'q() { psql "$@"; }; q -c "SELECT 1"'`).get('q')?.level, 1);
  });
  it('hands the function of the enclosing body to psql behind kubectl exec inside it', () => {
    const st = named('run() { kubectl exec -i pod/pg -- psql -U postgres "$@"; }; run -c "SELECT 1"', 'psql');
    assert.deepEqual([st.fn, st.inFunction, st.src.at(-1)], ['run', true, '"$@"']);
  });
  it('lists files a stage writes: redirects, tee, cp/mv, dd of=, curl -o, sed -i', () => {
    const w = (cmd: string, name: string) => named(cmd, name).writes;
    assert.deepEqual(w(`cat > /tmp/q.sql <<'SQL'\nSELECT 1;\nSQL`, 'cat'), ['/tmp/q.sql']);
    assert.deepEqual(w(`printf '%s' "$SQL" >> q.sql 2> err.log`, 'printf'), ['q.sql', 'err.log']);
    assert.deepEqual(w('echo x | tee -a /tmp/a.sql /tmp/b.sql', 'tee'), ['/tmp/a.sql', '/tmp/b.sql']);
    assert.deepEqual(w('cp src.sql /tmp/q.sql', 'cp'), ['/tmp/q.sql']);
    assert.deepEqual(w('dd if=/dev/zero of=/tmp/q.sql bs=1 count=1', 'dd'), ['/tmp/q.sql']);
    assert.deepEqual(w('curl -sS -o /tmp/q.sql https://x/q.sql', 'curl'), ['/tmp/q.sql']);
    assert.deepEqual(w("sed -i '' 's/a/b/' /tmp/q.sql", 'sed'), ['/tmp/q.sql']);
    assert.deepEqual(w('psql -c "SELECT 1" 2>&1 >/dev/null', 'psql'), []);
  });
  it('strips the zsh =command expansion from the stage name', () => {
    assert.ok(stages('=psql -c "SELECT 1"').some((s) => s.name === 'psql'));
  });
  it('keeps the text of a nesting level it did not descend into', () => {
    const m = buildModel<null>(`echo "$(echo "$(echo "$(echo "$(echo "$(psql -c 'SELECT 1')")")")")"`, () => null);
    assert.ok(Array.isArray(m.deep), 'модель без текста неразобранного уровня: psql глубже третьей оболочки не виден никому');
    assert.ok(m.deep.some((t) => t.includes('psql')), JSON.stringify(m.deep));
  });
  // Регрессии, пойманные прогоном по транскриптам 16.09 (оба — от самой правки, таксономия H).
  it('does not run a substitution twice — once locally and once again inside the pod of kubectl exec', () => {
    const m = buildModel<string>(`kubectl -n lms-local exec deploy/postgres -- psql -U "$(kubectl -n lms-local exec deploy/postgres -- printenv POSTGRES_USER)" -lqt`, () => 'pod');
    assert.deepEqual(m.tags, [], 'подстановку раскрывает локальная оболочка: её тело — стадия снаружи пода, а не второй уровень внутри');
    const psql = m.pipelines.flat().find((s) => s.name === 'psql');
    assert.equal(psql?.kube, 'pod');
    assert.deepEqual(restDynamic(psql!), [`$(kubectl -n lms-local exec deploy/postgres -- printenv POSTGRES_USER)`]);
  });
  it('hands the stdin of a wrapper — here-doc, `<` redirect, pipe — to the command inside it', () => {
    assert.equal(named("kubectl exec -i deploy/pg -- psql -U postgres <<'SQL'\nSELECT 1;\nSQL", 'psql').heredocs.length, 1);
    const redirected = named('kubectl exec -i deploy/pg -- psql -U postgres < "$SP/q.sql"', 'psql');
    assert.deepEqual([redirected.stdin, redirected.stdinDynamic], ['$SP/q.sql', true]);
    assert.equal(named('echo "SELECT 1" | docker exec -i pg psql -U postgres', 'psql').stdinStage?.name, 'echo');
  });
  it('finds psql as an argument of docker exec and sudo -u, and resolves a command held in a literal variable', () => {
    assert.deepEqual(restDynamic(named('docker exec pg psql -U postgres -c "$SQL"', 'psql')), ['$SQL']);
    assert.equal(named('sudo -u postgres psql -c "SELECT 1"', 'psql').rest.join(' '), '-c SELECT 1');
    const resolved = named('PSQL=/opt/homebrew/opt/libpq/bin/psql; $PSQL -h db -c "SELECT 1"', 'psql');
    assert.deepEqual([resolved.rest, restDynamic(resolved)], [['-h', 'db', '-c', 'SELECT 1'], []]);
    const fromSubstitution = stages('P=$(which psql); $P -c "SELECT 1"');
    assert.ok(fromSubstitution.some((s) => s.name === '$P'), 'значение из подстановки не подставляется: слово остаётся подстановкой');
    assert.ok(fromSubstitution.every((s) => s.name !== 'psql'), 'which psql называет имя, а не запускает psql');
    assert.ok(stages('echo "SET x" | grep psql').every((s) => s.name !== 'psql'));
  });
  it('sees the command after git commit -m "$(cat <<EOF … EOF)" even when the message has an apostrophe', () => {
    const all = stages(`git commit -q -m "$(cat <<'EOF'\nfix: don't lose the (message\nEOF\n)" && npx jest --silent 2>&1 | tail -5`);
    assert.ok(all.some((s) => s.name === 'npx'), JSON.stringify(all.map((s) => s.name)));
  });

  it('attaches a here-doc to the stage with << even when a pipe follows it', () => {
    const all = stages("psql -d wms <<'SQL' | tail -3\nSELECT 1;\nSQL");
    assert.deepEqual(all.map((s) => [s.name, s.heredocs.length]), [['psql', 1], ['tail', 0]]);
  });
});

// Проба 16.09: сессионный SET проходил молча за обёртками со строкой-командой и в теле `sh -c 'psql' <<SQL`,
// потому что модель не спускалась в строку чужой оболочки, а stdin оболочки не доходил до её тела.
describe('buildModel — wrappers with a command string, and the stdin of a shell body', () => {
  it('descends into the -c body of a shell given to docker exec, docker run, find -exec, su, watch, and into the ssh command string', () => {
    for (const cmd of [
      `docker exec -i pg sh -c 'psql -U postgres -c "SELECT 1"'`,
      `docker run --rm pg bash -c 'psql -c "SELECT 1"'`,
      `find . -name '*.sql' -exec sh -c 'psql -c "SELECT 1"' \;`,
      `su - postgres -c 'psql -c "SELECT 1"'`,
      `ssh -p 2222 -o StrictHostKeyChecking=no deploy@db-host 'psql -c "SELECT 1"'`,
      `watch 'psql -c "SELECT 1"'`,
    ]) {
      const psql = named(cmd, 'psql');
      assert.deepEqual([psql.rest.slice(-2), psql.level >= 1], [['-c', 'SELECT 1'], true], cmd);
    }
    assert.ok(stages('ssh db-host').every((s) => s.name !== 'psql'), 'ssh без команды — интерактивная сессия');
  });
  it('hands the stdin of a shell wrapper to every command of its -c body, not only the first', () => {
    assert.deepEqual(named("sh -c 'psql -U postgres' <<'SQL'\nSELECT 1;\nSQL", 'psql').heredocs, ['SELECT 1;\n']);
    assert.deepEqual(named("sh -c 'echo start; psql -U postgres' <<'SQL'\nSELECT 1;\nSQL", 'psql').heredocs, ['SELECT 1;\n'], 'echo не съедает stdin: psql читает here-doc');
    assert.deepEqual(named("docker exec -i pg sh -c 'psql -U postgres' <<'SQL'\nSELECT 1;\nSQL", 'psql').heredocs, ['SELECT 1;\n']);
    assert.equal(named("cat <<'SQL' | sh -c 'psql'\nSELECT 1;\nSQL", 'psql').stdinStage?.name, 'cat');
    assert.ok(named("sh -c 'psql' <<SQL\nSELECT $X;\nSQL", 'psql').tags.includes('here-doc-expansion'), 'подстановка в here-doc обёртки видна внутри');
  });
  it('records the file that receives stdout, and not the stderr redirect', () => {
    const st = named('psql -c "SELECT 1" > out.txt 2> err.log', 'psql');
    assert.deepEqual([st.stdoutTo, st.writes], ['out.txt', ['out.txt', 'err.log']]);
    assert.equal(named('psql -c "SELECT 1" 2>&1 | tee log.txt', 'psql').stdoutTo, null);
  });
});
