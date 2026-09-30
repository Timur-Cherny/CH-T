// INVARIANT: токенизатор тотален (никогда не бросает), кавычки не теряют содержимое, слова-триггеры
// видны в любом сегменте (kubectl exec … -- psql), а всё вне грамматики помечается unknown, не пропускается.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, commands, mentions, effective } from '../src/parsers/shell.ts';

describe('tokenize', () => {
  it('splits `cd X && git commit -m "a b"` into two commands and keeps the quoted message whole', () => {
    const p = tokenize('cd "$APP_ENGINE" && git commit -m "fix: a b" -F msg.txt; echo done');
    assert.deepEqual(commands(p).map((c) => c.name), ['cd', 'git', 'echo']);
    assert.deepEqual(p.segments[1].argv, ['git', 'commit', '-m', 'fix: a b', '-F', 'msg.txt']);
  });
  it('sees psql as a token behind `kubectl exec pod --` and behind an env prefix', () => {
    assert.equal(mentions(tokenize("kubectl exec pod-x -- psql -c 'SET x = 1'"), 'psql'), true);
    assert.equal(mentions(tokenize('PGPASSWORD=x psql -h host -f q.sql'), 'psql'), true);
    assert.equal(effective(['PGPASSWORD=x', 'psql', '-h']).name, 'psql');
    assert.equal(effective(['env', '-u', 'CLAUDECODE', 'claude', '-p']).name, 'claude');
    assert.equal(effective(['sudo', 'timeout', '30', 'git', 'push']).name, 'git');
  });
  it('does not mistake `SET` inside a comment or a string for a command token', () => {
    const p = tokenize("echo 'psql is mentioned' # psql\nls");
    assert.deepEqual(commands(p).map((c) => c.name), ['echo', 'ls']);
    assert.equal(mentions(p, 'psql'), false);
  });
  it('descends one level into `sh -c "…"` and `eval`, and marks deeper nesting unknown instead of pretending to see it', () => {
    const one = tokenize('sh -c "psql -c 1"');
    assert.equal(mentions(one, 'psql'), true);
    assert.deepEqual(one.unknown, []);
    const two = tokenize(`sh -c 'bash -c "psql -c 1"'`);
    assert.ok(two.unknown.includes('nested-shell-depth'));
    const ev = tokenize('eval "git push origin main"');
    assert.equal(mentions(ev, 'push'), true);
  });
  // Вид («есть подстановка») отвечает на вопрос «разобрано ли», но не на вопрос «что там лежит».
  // Гейт, у которого второго ответа нет, вынужден судить по всей строке — и спрашивает человека
  // о слове из соседнего разобранного токена (resource-guard, К2).
  it('carries the TEXT of every opaque part out, not only its kind', () => {
    const p = tokenize('cat jest.config.ts && echo "$(npx jest --listTests)"');
    assert.deepEqual(p.opaque, [{ kind: 'command-substitution', text: '$(npx jest --listTests)' }]);
  });

  it('INVARIANT: every kind in `unknown` has a span with its text — no kind may arrive textless', () => {
    const corpus = [
      'psql < $(cat x.sql)', 'echo `date`', "echo 'open", 'echo "open', 'psql <<< "$SQL"', 'echo )', 'echo ${x',
      'cat <<', 'cat <<EOF\nno terminator', 'cat <<EOF\n$HOME\nEOF', '<<EOF\nbody\nEOF',
      `sh -c 'bash -c "psql -c 1"'`,
    ];
    const seen = new Set<string>();
    for (const cmd of corpus) {
      const p = tokenize(cmd);
      const kinds = new Set(p.opaque.map((o) => o.kind));
      for (const k of p.unknown) { assert.ok(kinds.has(k), `${JSON.stringify(cmd)}: вид ${k} пришёл без текста`); seen.add(k); }
      for (const seg of p.segments) assert.ok(Array.isArray(seg.opaque), `${JSON.stringify(cmd)}: сегмент без своих частей — гейт не отличит часть в psql от части рядом`);
      for (const seg of p.segments) for (const o of seg.opaque) assert.ok(p.opaque.includes(o), `${JSON.stringify(cmd)}: часть сегмента не попала в общий список`);
    }
    assert.ok(seen.size >= 8, `корпус покрывает ${seen.size} видов — мало для инварианта`);
  });

  // Слово, собранное подстановкой, судилось как написано: `psql -c "SELECT '$X'"` проверялся по буквам `$X`, а в базу
  // уходило значение — `X="'; SET …; --"` проходил молча. Помечено ровно то, что раскроет оболочка (zsh ⊇ bash).
  describe('dynamic words', () => {
    const dyn = (cmd: string, seg = 0) => tokenize(cmd).segments[seg].dynamic;
    const built: Array<[string, number[]]> = [
      [`psql -c "SELECT '$X'"`, [2]], ['psql -c "$1"', [2]], ['psql -c "${SQL}"', [2]], ['psql -c "$(cat q.sql)"', [2]],
      ['psql -c "`cat q.sql`"', [2]], ['psql -c $SQL', [2]], ['psql -Atc"$SQL"', [1]], ['psql --command="$SQL"', [1]],
      ['echo $@ $* $# $? $$ $! $- $0', [1, 2, 3, 4, 5, 6, 7, 8]], ['psql -c "$=SQL"', [2]], ['psql -c "$~X"', [2]],
      [`psql -c "SELECT 1 --"$'\\n'"SET x = 1"`, [2]], ['psql -c "$[1+2]"', [2]],
    ];
    for (const [cmd, want] of built) it(`marks the word an expansion builds: ${cmd}`, () => assert.deepEqual(dyn(cmd), want));
    const literal = [`psql -c 'SELECT $1'`, `psql -c "SELECT '\\$5'"`, 'psql -c "cost $ 5"', 'psql -c "a$"', `psql -c 'DO $$ BEGIN END $$'`, `psql -c "SELECT jsonb_path_query(d, '$.a')"`, 'psql -c "$= 1"'];
    for (const cmd of literal) it(`leaves a literal dollar unmarked: ${cmd}`, () => assert.deepEqual(dyn(cmd), []));
    it('marks a dollar inside single quotes of a body the outer shell already expanded', () => {
      assert.deepEqual(tokenize(`psql -c '$SQL'`, 0, { expandedByOuter: true }).segments[0].dynamic, [2]);
      assert.deepEqual(tokenize(`psql -c '$SQL'`).segments[0].dynamic, []);
    });
  });

  // Тело here-doc лежало у последнего сегмента перед переводом строки: `psql <<SQL | tail` отдавал SQL команде tail,
  // и барьер его не видел; а `&&\n` съедался серией разделителей, и строки тела становились командами.
  it('attaches a here-doc body and its tags to the segment that opened it, not to the last segment before the newline', () => {
    const p = tokenize('psql <<SQL | tail -3\nSELECT 1;\nSQL');
    assert.deepEqual(p.segments.map((s) => [s.argv[0], s.heredocs]), [['psql', ['SELECT 1;\n']], ['tail', []]]);
    assert.deepEqual(tokenize('git commit -F - <<EOF && git push\nmsg\nEOF').segments.map((s) => s.heredocs.length), [1, 0]);
    const r = tokenize('psql <<SQL | tail\n$X\nSQL');
    assert.ok(r.segments[0].unknown.includes('here-doc-expansion'), 'тег подстановки обязан лечь на сегмент с <<');
    assert.ok(!r.segments[1].unknown.includes('here-doc-expansion'), 'сосед тег не получает');
  });
  it('reads here-doc bodies after a newline inside a separator run — `&&\\n`, `;\\n`, `|\\n`', () => {
    for (const sep of ['&&', ';', '|']) {
      const p = tokenize(`psql -d wms <<'SQL' ${sep}\nSET statement_timeout = 0;\nSQL\npsql -d wms <<'SQL'\nSELECT 1;\nSQL`);
      assert.deepEqual(p.segments.map((s) => [s.argv[0], s.heredocs]), [['psql', ['SET statement_timeout = 0;\n']], ['psql', ['SELECT 1;\n']]], `разделитель ${sep}`);
    }
  });
  it('closes $(…) by its own parenthesis — a parenthesis inside quotes does not end the substitution', () => {
    const p = tokenize(`echo "$(echo ')'; psql -c 'SET x')"`);
    assert.deepEqual(p.opaque.map((o) => o.text), [`$(echo ')'; psql -c 'SET x')`]);
  });
  it('tags a here-doc body as expanded only where the shell expands: $NAME, ${, $(, `, $1 — not $., $ or an escaped \\$', () => {
    const tagged = (body: string) => tokenize(`cat <<SQL\n${body}\nSQL`).unknown.includes('here-doc-expansion');
    for (const body of [`SELECT jsonb_path_query(d, '$.a')`, `SELECT 1 WHERE r ~ '^a.$'`, `SELECT 'US$', '$ 5'`, `SELECT '\\$1'`]) assert.equal(tagged(body), false, body);
    for (const body of [`SELECT '$X'`, 'SELECT ${X}', 'SELECT $(date)', 'SELECT `date`', 'PREPARE p AS SELECT $1', 'DO $$ BEGIN END $$']) assert.equal(tagged(body), true, body);
  });

  it('marks command substitution and unterminated quotes as unknown', () => {
    assert.ok(tokenize('psql < $(cat x.sql)').unknown.includes('command-substitution'));
    assert.ok(tokenize("echo 'open").unknown.includes('unterminated-single-quote'));
  });

  describe('here-doc: тело разбирается, а не объявляется недоступным', () => {
    it('снимает тело с ограничителем и НЕ пускает его строки в поток команд', () => {
      const p = tokenize("cat <<'EOF'\nrm -rf /\nEOF\necho done");
      assert.deepEqual(p.segments.map((s) => s.argv), [['cat'], ['echo', 'done']], 'строка тела стала бы командой');
      assert.deepEqual(p.segments[0].heredocs, ['rm -rf /\n']);
      assert.deepEqual(p.unknown, [], 'ограничитель в кавычках: подстановок нет, знать нечего');
    });
    it('различает ограничитель в кавычках и голый: подстановка в теле оставляет unknown', () => {
      assert.deepEqual(tokenize("cat <<'EOF'\n$HOME\nEOF").unknown, []);
      assert.ok(tokenize('cat <<EOF\n$HOME\nEOF').unknown.includes('here-doc-expansion'));
      assert.ok(tokenize('cat <<EOF\nplain text\nEOF').unknown.length === 0, 'голый ограничитель без $ и бэктика — тело literal');
    });
    it('<<- срезает ведущие табы и у тела, и у ограничителя', () => {
      const p = tokenize('cat <<-EOF\n\tone\n\tEOF\necho after');
      assert.deepEqual(p.segments[0].heredocs, ['one\n']);
      assert.deepEqual(p.segments.map((s) => s.argv), [['cat'], ['echo', 'after']]);
    });
    it('два here-doc в одной команде читаются по порядку', () => {
      const p = tokenize("cmd <<'A' <<'B'\nfirst\nA\nsecond\nB");
      assert.deepEqual(p.segments[0].heredocs, ['first\n', 'second\n']);
    });
    it('ограничитель не встретился → here-doc-unterminated, не тишина', () => {
      assert.ok(tokenize('cat <<EOF\nno terminator').unknown.includes('here-doc-unterminated'));
      assert.ok(tokenize('cat <<EOF').unknown.includes('here-doc-unterminated'));
    });
    it('here-string <<< — это stdin с известным текстом; подстановка в слове помечается как в голом here-doc', () => {
      const p = tokenize('psql <<< "select 1"');
      assert.deepEqual([p.segments[0].heredocs, p.unknown], [['select 1\n'], []]);
      assert.ok(tokenize('psql <<< "$SQL"').unknown.includes('here-doc-expansion'));
    });
    it('скрипт, поданный ОБОЛОЧКЕ, разбирается на команды; тело psql — нет (это SQL, а не shell)', () => {
      assert.deepEqual(tokenize('bash <<EOF\nnpx jest\nEOF').segments.map((s) => s.argv), [['bash'], ['npx', 'jest']]);
      assert.deepEqual(tokenize('psql <<SQL\nSELECT 1; -- npm run build\nSQL').segments.map((s) => s.argv), [['psql']]);
    });
    it('причина живёт и в сегменте, и в общем списке: гейт смотрит в свой сегмент', () => {
      const p = tokenize('echo $(date)\ngit commit -F - <<EOF\nfix: $USER\nEOF');
      const commit = p.segments.find((s) => s.argv[1] === 'commit');
      assert.ok(commit?.unknown.includes('here-doc-expansion'));
      assert.ok(!commit?.unknown.includes('command-substitution'), 'чужая подстановка не приписывается этому сегменту');
    });
  });
  it('never throws on arbitrary input (seeded property, 2000 strings)', () => {
    let seed = 0x9e3779b9;
    const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 0xffffffff; };
    const alphabet = ` \n;&|()'"\\$\`<>#=-abcXYZ09_/`;
    for (let n = 0; n < 2000; n++) {
      const len = Math.floor(rnd() * 40);
      let s = ''; for (let i = 0; i < len; i++) s += alphabet[Math.floor(rnd() * alphabet.length)];
      assert.doesNotThrow(() => tokenize(s), `seed-case ${n}: ${JSON.stringify(s)}`);
    }
  });
  it('treats `2>&1` as a redirection token, not as a background separator', () => {
    const p = tokenize('git push --help >/dev/null 2>&1; echo rc=$?');
    assert.deepEqual(commands(p).map((c) => c.name), ['git', 'echo']);
  });
});

describe('tokenize — segment offsets and word sources', () => {
  it('records where each segment starts and the source text of each word, quotes included', () => {
    const p = tokenize('# run\nrun() { psql "$@"; }');
    assert.deepEqual(p.segments.map((s) => [s.at, s.argv[0]]), [[14, 'psql']], 'объявление функции и скобки — грамматика, не сегменты; смещение по позиции, не поиском raw');
    assert.deepEqual(p.segments[0].src, ['psql', '"$@"']);
    assert.deepEqual(tokenize(`psql -c 'a b' $@ "x"$Y`).segments[0].src, ['psql', '-c', "'a b'", '$@', '"x"$Y']);
  });
});
