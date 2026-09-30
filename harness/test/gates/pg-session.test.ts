// INVARIANT К1 (INC-PG-READONLY-BYPASS): барьер к Postgres, держащийся состоянием соединения, виден как
// узел AST — SET без LOCAL, ALTER ROLE/DATABASE … SET, set_config(…, false), DO, options=-c — а комментарий
// и строковый литерал узлом не являются. Молча ломалось: hooks/pg-session-state-guard.sh:63-83 grep по
// тексту требовал `=`: `SET … TO off`, set_config, DO $$…$$, URL ?options=-c и `psql -f` проходили (exit 0),
// а `/* SET … */ SELECT 1` ложно блокировался (exit 2) — проверено пробой 05.09.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, payload, bashPayload, HARNESS_ROOT } from '../_env.ts';
import { decide, judgeSql, exemptPath, NAME, KILL } from '../../src/gates/pg-session.ts';
import { psqlSources, conninfoValue } from '../../src/parsers/psql.ts';
import { route } from '../../src/main.ts';
import type { GateContext, HarnessEvent, HookPayload, Verdict } from '../../src/types.ts';

const sb = sandbox('harness-pg-');
after(() => sb.cleanup());
const env = { HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, HARNESS_ROOT };

function ctx(event: HarnessEvent, p: Record<string, unknown>): GateContext {
  return { event, payload: p as unknown as HookPayload, env, root: HARNESS_ROOT, stateDir: sb.stateDir, now: Date.now };
}
const bash = (command: string) => decide(ctx('pre-bash', bashPayload(command, { cwd: sb.dir })));
const psql = (sql: string) => bash(`psql -c "${sql}"`);
const write = (file_path: string, content: string) => decide(ctx('pre-write', payload('PreToolUse', { tool_name: 'Write', tool_input: { file_path, content }, tool_use_id: 'toolu_w' })));
const edit = (file_path: string, new_string: string) => decide(ctx('pre-write', payload('PreToolUse', { tool_name: 'Edit', tool_input: { file_path, old_string: 'x', new_string }, tool_use_id: 'toolu_e' })));

async function deny(v: Promise<Verdict>, re: RegExp): Promise<void> {
  const r = await v; assert.equal(r.kind, 'deny', JSON.stringify(r)); assert.match((r as { reason: string }).reason, re);
}
async function unknown(v: Promise<Verdict>, re: RegExp): Promise<void> {
  const r = await v; assert.equal(r.kind, 'unknown', JSON.stringify(r)); assert.match((r as { reason: string }).reason, re);
}
async function silent(v: Promise<Verdict>): Promise<void> { assert.deepEqual(await v, { kind: 'silent' }); }

const ALTER_ROLE = "ALTER ROLE grafana_ro SET default_transaction_read_only = on";
const ALTER_APP = "ALTER ROLE app SET statement_timeout = '30s'";

describe('pg-session pre-bash — bash corpus (pg-session-state-guard.test.sh)', () => {
  it('denies a session SET default_transaction_read_only', () => deny(psql('SET default_transaction_read_only = on'), /сессионный SET default_transaction_read_only без LOCAL/));
  it('denies a session SET statement_timeout', () => deny(psql("SET statement_timeout = '15s'"), /сессионный SET statement_timeout/));
  it('denies ALTER ROLE … SET default_transaction_read_only — the case that slipped past the note', () => deny(psql(ALTER_ROLE), /ALTER ROLE … SET default_transaction_read_only.*pg_db_role_setting/));
  it('denies ALTER ROLE … SET statement_timeout', () => deny(psql(ALTER_APP), /ALTER ROLE … SET statement_timeout/));
  it('denies ALTER DATABASE … SET', () => deny(psql("ALTER DATABASE wms SET statement_timeout = '30s'"), /ALTER DATABASE … SET statement_timeout/));
  it('passes GRANT SELECT — the barrier held by privileges', () => silent(psql('GRANT SELECT ON ALL TABLES IN SCHEMA public TO grafana_ro')));
  it('passes CREATE ROLE without SET', () => silent(psql("CREATE ROLE grafana_ro WITH LOGIN PASSWORD 'x'")));
  it('passes BEGIN TRANSACTION READ ONLY + SET LOCAL — dies on ROLLBACK', () => silent(psql("BEGIN TRANSACTION READ ONLY; SET LOCAL statement_timeout = '15s'; SELECT 1;")));
  it('passes ALTER ROLE … RESET — removing the setting is not a violation', () => silent(psql('ALTER ROLE grafana_ro RESET default_transaction_read_only')));
  it('passes a command that writes a file instead of talking to the database', () => silent(bash("cat > /tmp/x.sql <<EOF\nALTER ROLE app SET statement_timeout = '30s';\nEOF")));
  it('passes a plain SELECT', () => silent(psql('SELECT count(*) FROM orders')));
  it('ignores other tools on pre-bash', () => silent(decide(ctx('pre-bash', payload('PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/tmp/x' } })))));
});

describe('pg-session pre-write — bash corpus', () => {
  it('denies ALTER ROLE … SET inside a written manifest', () => deny(write('/tmp/x.yaml', `command:\n  - sh\n  - -c\n  - ${ALTER_ROLE};`), /ALTER ROLE … SET/));
  it('denies startup parameter options=-c in an Edit', () => deny(edit('/tmp/x.sql', "extra: { options: '-c statement_timeout=30s' }"), /options=-c/));
  it('passes a comment that forbids the construct — text is not a statement', () => silent(write('/tmp/x.yaml', '# Никаких ALTER ROLE ... SET: сессионный GUC уезжает за пулер')));
  it('passes a description of the construct in .md — documentation does not execute', () => silent(write('/tmp/note.md', 'нота: писать роль-левел GUC нельзя')));
  it('passes the spec of the gate itself, which must contain the violation', () => {
    assert.ok(exemptPath(join(HARNESS_ROOT, '..', 'hooks', 'spec', 'x.test.sh')));
    return silent(write(join(HARNESS_ROOT, '..', 'hooks', 'spec', 'x.test.sh'), ALTER_APP));
  });
});

describe('pg-session kill-switch and routing', () => {
  it(`${KILL}=1 through route(): silent and nothing written to state; without it the same payload is denied by ${NAME}`, async () => {
    const p = bashPayload(`psql -c "${ALTER_APP}"`, { cwd: sb.dir }) as unknown as HookPayload;
    assert.deepEqual(await route('pre-bash', p, { ...env, [KILL]: '1' }), { kind: 'silent' });
    assert.deepEqual(readdirSync(sb.stateDir), []);
    const live = await route('pre-bash', p, env);
    assert.equal(live.kind, 'deny'); assert.equal((live as { gate: string }).gate, NAME);
  });
  it('lifts unknown to ask on pre-bash through route() — a parse failure is never a pass', async () => {
    const v = await route('pre-bash', bashPayload('psql -c "SELEC 1 FROMM"', { cwd: sb.dir }) as unknown as HookPayload, env);
    assert.equal(v.kind, 'ask'); assert.match((v as { reason: string }).reason, /не разобран/);
  });
});

describe('pg-session — K1 bypasses of the text grep, now seen as AST nodes (new)', () => {
  it('REGRESSION INC-PG-READONLY-BYPASS: SET … TO off without `=` is denied', () => deny(psql('SET default_transaction_read_only TO off'), /сессионный SET default_transaction_read_only/));
  it('denies SET SESSION in any letter case', () => deny(psql("sEt SESSION statement_timeout TO '1s'"), /statement_timeout/));
  it('denies SET without LOCAL even inside BEGIN … COMMIT — the setting outlives the transaction', () => deny(psql('BEGIN; SET default_transaction_read_only = on; COMMIT'), /без LOCAL/));
  it('passes SET … TO DEFAULT and RESET — both remove the setting', async () => {
    await silent(psql('SET statement_timeout TO DEFAULT'));
    await silent(psql('RESET statement_timeout'));
    await silent(psql('ALTER DATABASE wms RESET ALL'));
  });
  it('denies set_config(guc, …, false) and a non-literal is_local; passes is_local=true and a foreign GUC; unknown for a non-literal GUC name', async () => {
    await deny(psql("SELECT set_config('default_transaction_read_only', 'off', false)"), /set_config\('default_transaction_read_only'.*is_local=false/);
    await deny(psql("SELECT set_config('statement_timeout', '0', $1)"), /is_local не литерал/);
    await deny(psql("INSERT INTO t SELECT set_config('lock_timeout', '0', false)"), /lock_timeout/);
    await silent(psql("SELECT set_config('statement_timeout', '0', true)"));
    await silent(psql("SELECT set_config('search_path', 'public', false)"));
    await unknown(psql("SELECT set_config(current_setting('x'), '0', false)"), /нелитеральным именем GUC/);
  });
  it('denies a DO block — its body is opaque to the parser', () => deny(psql("DO $$ BEGIN EXECUTE 'SET default_transaction_read_only TO off'; END $$"), /DO-блок: тело непрозрачно/));
  it('denies EXECUTE of a prepared statement outside the visible batch, judges a visible PREPARE by its body', async () => {
    await deny(psql('EXECUTE q'), /EXECUTE q: тело подготовленного запроса непрозрачно/);
    await deny(psql("PREPARE p AS SELECT set_config('statement_timeout', '0', false); EXECUTE p"), /set_config/);
    await silent(psql('PREPARE p AS SELECT 1; EXECUTE p'));
  });
  it('passes SET hidden in a comment or a string literal — the grep false positive is gone', async () => {
    await silent(psql('/* SET default_transaction_read_only = off */ SELECT 1'));
    await silent(psql("SELECT 'SET default_transaction_read_only = off'"));
    await silent(psql("-- SET default_transaction_read_only = off\nSELECT 1"));
  });
  it('passes function-level SET (CREATE FUNCTION … SET) — it reverts on return, not a session setting', () => silent(psql("CREATE FUNCTION f() RETURNS int LANGUAGE sql SET statement_timeout = '1s' AS 'select 1'")));
  it('answers unknown for unparsable SQL', () => unknown(psql('SELEC 1 FROMM'), /SQL не разобран/));
});

describe('pg-session — where the SQL comes from (new)', () => {
  it('denies options=-c in a postgres:// URL (searchParams, not text) and passes a URL without it', async () => {
    await deny(bash('psql "postgres://u@h/db?options=-c%20statement_timeout%3D30s"'), /options=-c в строке подключения/);
    await deny(bash('DATABASE_URL="postgresql://u:p@h:5432/db?sslmode=require&options=-c%20statement_timeout%3D30s" npm start'), /options=-c/);
    await silent(bash('psql "postgres://u@h/db?sslmode=require"'));
    await unknown(bash('psql "postgres://[bad"'), /не разобрана как URL/);
  });
  it('denies PGOPTIONS=-c as an env prefix and options=-c in a libpq conninfo string', async () => {
    await deny(bash("PGOPTIONS='-c statement_timeout=30s' psql -c 'select 1'"), /PGOPTIONS=-c/);
    await deny(bash("psql \"host=h dbname=d options='-c statement_timeout=30s'\""), /options='-c/);
    assert.equal(conninfoValue("host=h options='-c a=b' user=u", 'options'), '-c a=b');
    assert.equal(conninfoValue('host=h', 'options'), null);
  });
  it('reads the file behind psql -f / --file= / < redirect, denies its ALTER ROLE and answers unknown for a missing file', async () => {
    const f = join(sb.dir, 'x.sql'); writeFileSync(f, `${ALTER_APP};\n`);
    await deny(bash(`psql -f ${f}`), /ALTER ROLE/);
    await deny(bash(`psql --file=${f} wms`), /ALTER ROLE/);
    await deny(bash('psql -d wms < x.sql'), /ALTER ROLE/);
    await deny(bash('psql wms <x.sql'), /ALTER ROLE/);
    await unknown(bash('psql -f missing.sql'), /файл SQL не прочитан: missing\.sql/);
    assert.deepEqual(psqlSources(['-qAt', '-f', 'a.sql', '--command=SELECT 1', '-cSELECT 2', '-f', '-']), [
      { kind: 'file', path: 'a.sql' }, { kind: 'inline', sql: 'SELECT 1' }, { kind: 'inline', sql: 'SELECT 2' }, { kind: 'stdin' },
    ]);
  });
  it('answers unknown when the body is not visible: $(…), pipe into psql, -f - without a here-doc', async () => {
    await unknown(bash('$(cat x.sql) | psql'), /stdin из другой команды/);
    await unknown(bash('cat x.sql | psql wms'), /stdin из другой команды/);
    await unknown(bash('psql -f - wms'), /читает stdin/);
  });
  it('judges the SQL a here-doc carries — the form the barrier was silently blind to', async () => {
    await deny(bash("psql -h db <<'SQL'\nSET statement_timeout = 0;\nSELECT 1;\nSQL"), /statement_timeout/);
    await deny(bash("psql -f - <<'SQL'\n" + ALTER_APP + ';\nSQL'), /ALTER ROLE/);
    await silent(bash("psql -h db <<'SQL'\nSELECT count(*) FROM orders;\nSQL"));
    await silent(bash("psql wms <<'SQL'\nBEGIN; SET LOCAL statement_timeout = '5s'; SELECT 1; COMMIT;\nSQL"));
  });
  it('denies a here-doc body built by expansion and keeps unknown for a body without a terminator', async () => {
    await deny(bash('psql <<SQL\nSET statement_timeout = $T;\nSQL'), /here-doc[\s\S]*подстановк/);
    await unknown(bash('psql <<SQL\nSELECT 1;'), /ограничител|unterminated/);
  });
  it('finds psql inside a script fed to bash by here-doc — one level of nesting, same as sh -c', async () => {
    await deny(bash("bash <<'SH'\npsql -c \"" + ALTER_APP + '"\nSH'), /ALTER ROLE/);
  });
  it('passes psql/pg_dump invocations that carry no statements at all', async () => {
    await silent(bash('psql -l'));
    await silent(bash('pg_dump wms > out.sql'));
    await silent(bash('PGPASSWORD=x pg_restore -d wms dump.bin'));
  });
  it('finds psql behind kubectl exec pod -- and inside a one-level sh -c; PGPASSWORD alone is not a violation', async () => {
    await deny(bash(`kubectl exec pod-x -n wms -- psql -U app -c "${ALTER_APP}"`), /ALTER ROLE/);
    await deny(bash(`bash -c "psql -c \\"${ALTER_APP}\\""`), /ALTER ROLE/);
    await silent(bash("kubectl exec pod-x -- env PGPASSWORD=x psql -c 'select 1'"));
  });
  it('reads -c from a short cluster (-qAtc) and from --command', async () => {
    await deny(bash("psql -qAtc \"SET statement_timeout = '1s'\""), /statement_timeout/);
    await deny(bash("psql --command \"SET lock_timeout = '1s'\" wms"), /lock_timeout/);
    await deny(bash('psql -v ON_ERROR_STOP=1 -c "SET idle_in_transaction_session_timeout = 0"'), /idle_in_transaction_session_timeout/);
  });
});

describe('pg-session pre-write — SQL inside written files (new)', () => {
  it('scans a host document from the earliest statement keyword: UPDATE … SET statement_timeout is an UPDATE, not a SET', () => silent(write('/tmp/repo/src/a.ts', "await q(\"UPDATE settings SET statement_timeout = '1'\");")));
  it('ignores JS `new Set([...])` and `do {` — unparsable candidates give no verdict', () => silent(write('/tmp/repo/src/b.ts', "const GUCS = new Set(['statement_timeout']);\ndo { i++; } while (i < 3);\nconst reset = settings.get('statement_timeout');")));
  it('passes a .sql migration with constraints and indexes, and SET LOCAL', async () => {
    await silent(write('/tmp/repo/migrations/1.sql', 'ALTER TABLE t ADD CONSTRAINT ck CHECK (a > 0) NOT VALID;\nCREATE UNIQUE INDEX CONCURRENTLY i ON t (a);\n'));
    await silent(write('/tmp/repo/migrations/2.sql', "BEGIN;\nSET LOCAL statement_timeout = '1s';\nUPDATE t SET a = 1;\nCOMMIT;\n"));
  });
  it('denies a multi-line DO $$ … $$ block in a .sql file and an ALTER ROLE … SET in an Edit', async () => {
    await deny(write('/tmp/repo/migrations/3.sql', "DO $$\nBEGIN\n  EXECUTE 'SET default_transaction_read_only TO off';\nEND\n$$;\n"), /DO-блок/);
    await deny(edit('/tmp/repo/migrations/4.sql', `${ALTER_APP};`), /ALTER ROLE/);
  });
  it('denies a DO $$ … $$ block embedded in a TypeORM migration string', () => deny(write('/tmp/repo/src/migrations/X.ts', "await queryRunner.query(`DO $x$\nBEGIN\n  PERFORM 1;\nEND\n$x$`);"), /DO-блок/));
  it('answers unknown for a .sql file that does not parse at all — cannot prove safety', () => unknown(write('/tmp/repo/seed.sql', '\\connect wms\nSELEC 1;\n'), /SQL-файл не разобран/));
  it('denies set_config(…, false) inside a JS query string and a bare PERFORM set_config(…) fragment', async () => {
    await deny(write('/tmp/repo/src/c.ts', "client.query(\"SELECT set_config('statement_timeout', '0', false)\")"), /set_config/);
    await deny(write('/tmp/repo/src/d.ts', "  PERFORM set_config('statement_timeout', '0', false);"), /set_config/);
    await silent(write('/tmp/repo/src/e.ts', "  PERFORM set_config('statement_timeout', '0', true);"));
  });
  it('denies options=-c in JSON/YAML config and in a .env URL; passes an unrelated options key', async () => {
    await deny(write('/tmp/repo/ds.json', '{"jsonData":{"extra":{"options":"-c statement_timeout=30s"}}}'), /options=-c/);
    await deny(write('/tmp/repo/deploy.yaml', 'env:\n  PGOPTIONS: "-c statement_timeout=30s"\n'), /options=-c/);
    await deny(write('/tmp/repo/.env', 'DATABASE_URL=postgres://u@h/db?options=-c%20statement_timeout%3D30s\n'), /options=-c/);
    await silent(write('/tmp/repo/cfg.json', '{"options":"verbose","extra":{"options":"--verbose"}}'));
  });
  it('exempts test files by name and passes an empty write; NotebookEdit is judged by new_source', async () => {
    await silent(write('/tmp/repo/test/gates/x.test.ts', `${ALTER_APP}`));
    await silent(write('/tmp/repo/a.sql', ''));
    await deny(decide(ctx('pre-write', payload('PreToolUse', { tool_name: 'NotebookEdit', tool_input: { notebook_path: '/tmp/repo/n.ipynb', new_source: "SET statement_timeout = '1s'" } }))), /statement_timeout/);
  });
  it('judgeSql is the shared core: multi-statement batches are judged in order and deny wins over unknown', async () => {
    assert.equal((await judgeSql("SELECT 1; SET LOCAL statement_timeout = '1s'")).kind, 'clean');
    assert.equal((await judgeSql("SELECT set_config(current_setting('x'), '0', false); SET statement_timeout = '1s'")).kind, 'deny');
  });
});

// INVARIANT: гейт судит SQL, который получит psql, а не буквы команды; SQL, спрятанный от гейта, запрещён, а не
// спрошен. До 16.09 ломалось молча: `$X` внутри строки SQL, `psql <<SQL | tail`, psql внутри $(…) и бэктиков,
// `kubectl exec -- sh -c`, `bash -lc`, `&&\n` перед телом, `$P "SET …"`, функция с "$@" — сессионный SET проходил
// clean; SQL в переменной давал ask, и человек решал за гейт (прогон 30 форм и 12 обходов spec-critic).
describe('pg-session — SQL hidden from the gate is denied with the literal forms to use instead', () => {
  const SET = 'SET statement_timeout = 0';
  const SELECT = 'SELECT count(*) FROM orders';
  const HIDDEN = /подстановк|функци|xargs|пишет эта же команда/;
  const REWRITE = /<<'SQL'[\s\S]*-f \/абсолютный/;
  const sq = (c: string) => `'${c.replace(/'/g, `'\\''`)}'`;
  const dq = (c: string) => `"${c.replace(/(["\\$`])/g, '\\$1')}"`;

  // I1 по композиции: видимая форма в любой обёртке — SET запрещён, SELECT молчит.
  const inner: Array<[string, (sql: string) => string, boolean]> = [
    ['psql -c', (q) => `psql -X -c "${q}"`, false],
    ["psql <<'SQL'", (q) => `psql -X <<'SQL'\n${q};\nSQL`, false],
    ['psql <<SQL | tail', (q) => `psql -X <<SQL | tail -3\n${q};\nSQL`, false],
    ["cat <<'SQL' | psql", (q) => `cat <<'SQL' | psql -X\n${q};\nSQL`, true],
    ['echo | psql', (q) => `echo "${q}" | psql -X`, true],
  ];
  const outer: Array<[string, (cmd: string, piped: boolean) => string | null]> = [
    ['as is', (c) => c],
    ['sh -c', (c) => `sh -c ${sq(c)}`],
    ['bash -lc', (c) => `bash -lc ${sq(c)}`],
    ['kubectl exec -- sh -c', (c) => `kubectl exec -i pod/pg -- sh -c ${sq(c)}`],
    ['kubectl exec --', (c, piped) => (piped ? null : `kubectl exec -i pod/pg -- ${c}`)],
    ['echo "$(…)"', (c) => `echo "$(${c}\n)"`],
    ['N=$(…)', (c) => `N=$(${c}\n)`],
    ['eval', (c) => `eval ${dq(c)}`],
  ];
  for (const [oName, wrap] of outer) {
    for (const [iName, form, piped] of inner) {
      const setCmd = wrap(form(SET), piped);
      if (setCmd === null) continue;
      it(`judges visible SQL through ${oName} × ${iName}: SET is denied, SELECT passes`, async () => {
        const v = await bash(setCmd);
        assert.equal(v.kind, 'deny', `${JSON.stringify(setCmd)} → ${JSON.stringify(v)}. Miss this and SET statement_timeout = 0 rides the pooled backend into foreign sessions (prod 28.08)`);
        assert.match((v as { reason: string }).reason, /statement_timeout/);
        await silent(bash(wrap(form(SELECT), piped)!));
      });
    }
  }

  const hidden: Array<[string, (sql: string) => string]> = [
    ['a variable', (q) => `SQL="${q}"; psql -c "$SQL"`],
    ['a braced variable', (q) => `SQL="${q}"; psql -c "\${SQL}"`],
    ['a variable inside the SQL string', (q) => `X="'; ${q}; --"; psql -c "SELECT '$X'"`],
    ['a function called once with a variable', (q) => `q() { psql -Atc "$1"; }; q "$X"; q "${q}"`],
    ['a function that is never called', (q) => `q() { psql -Atc "$1"; }; echo "${q}"`],
    ['a positional parameter as a bare psql argument (flag and SQL in one word)', (q) => `sh -c 'psql "$1"' _ "-c ${q}"`],
    ['a command word from a substitution', (q) => `P=$(which psql); $P -Atc "${q}"`],
    ['a command word from the environment', (q) => `$PSQL_BIN -Atc "${q}"`],
    ['a command substitution as the SQL', (q) => `psql -c "$(printf '%s' '${q}')"`],
    ['backticks as the SQL', (q) => 'psql -c "`printf \'%s\' \'' + q + '\'`"'],
    ['a file path in a variable', () => 'psql -f "$SP/q.sql"'],
    ['a redirect path in a variable', () => 'psql wms < "$SP/q.sql"'],
    ['a loop variable as the file', () => 'for f in a.sql b.sql; do psql -f "$f"; done'],
    ['a here-doc body with an expansion', (q) => `psql <<SQL\n${q}; -- $X\nSQL`],
    ['sh -c with a positional parameter', (q) => `sh -c 'psql -c "$1"' _ "${q}"`],
    ['eval of a variable', () => 'eval "psql -c \\"$SQL\\""'],
    ['kubectl exec with a variable', () => 'kubectl exec pod/pg -- psql -U postgres -c "$SQL"'],
    ['bash -lc whose body the outer shell expands', () => `bash -lc "psql -c '$SQL'"`],
    ['echo of a variable into psql', () => 'echo "$SQL" | psql'],
    ['xargs', (q) => `printf '%s' "${q}" | xargs -0 psql -c`],
    ['ANSI-C quoting that hides a newline after a comment', (q) => `psql -c "SELECT 1 --"$'\\n'"${q}"`],
    ['zsh =psql with a variable', () => '=psql -c "$SQL"'],
    ['psql inside $(…) with a variable', () => 'echo "$(psql -Atc "$SQL")"'],
  ];
  for (const [how, cmd] of hidden) {
    it(`denies SQL that reaches psql through ${how} — for SELECT and SET alike — and names the literal forms`, async () => {
      for (const q of [SELECT, SET]) {
        const v = await bash(cmd(q));
        assert.equal(v.kind, 'deny', `${JSON.stringify(cmd(q))} → ${JSON.stringify(v)}. Miss this and the agent keeps wrapping SQL where no gate reads it`);
        assert.match((v as { reason: string }).reason, HIDDEN);
        assert.match((v as { reason: string }).reason, REWRITE);
      }
    });
  }
  // Регрессии и дыры, найденные прогоном 9761 команды из транскриптов 16.09.
  it('finds psql behind docker exec and sudo -u — the token scan of the old gate caught these', async () => {
    await deny(bash(`docker exec idxchk psql -U postgres -c "${SET}"`), /statement_timeout/);
    await deny(bash(`sudo -u postgres psql -c "${SET}"`), /statement_timeout/);
    await silent(bash('docker exec idxchk psql -U postgres -c "SELECT 1"'));
  });
  it('judges a command held in a literal variable as the command itself — visible, so not hidden', async () => {
    await deny(bash(`PSQL=/opt/homebrew/opt/libpq/bin/psql; $PSQL -h db -c "${SET}"`), /statement_timeout/);
    await silent(bash(`PSQL=/opt/homebrew/opt/libpq/bin/psql; $PSQL -h db -c "${SELECT}"`));
    await silent(bash('PGR=/opt/homebrew/opt/libpq/bin/pg_restore; $PGR -l /tmp/x.dump'));
  });
  it('denies SQL fed to psql inside a pod through a redirect of kubectl exec from a variable path or a file the command writes', async () => {
    await deny(bash('kubectl exec -i deploy/pg -- psql -U postgres < "$SP/q.sql"'), /путь к SQL-файлу/);
    const f = join(sb.dir, 'pod.sql');
    await deny(bash(`cat > ${f} <<'SQL'\nSELECT 1;\nSQL\nkubectl exec -i deploy/pg -- psql -U postgres < ${f}`), /пишет эта же команда/);
  });
  it('descends into psql three levels deep — kubectl exec, bash -c, $(…)', async () => {
    await deny(bash(`kubectl exec pod/pg -- bash -c 'N=$(psql -Atc "${SET}"); echo $N'`), /statement_timeout/);
  });
  it('denies a SQL file the same command writes — the gate would read yesterday’s content from disk', async () => {
    const f = join(sb.dir, 'rewritten.sql'); writeFileSync(f, 'SELECT 1;\n');
    await deny(bash(`cat > ${f} <<'SQL'\n${SET};\nSQL\npsql -f ${f}`), /пишет эта же команда/);
    await deny(bash(`printf '%s' '${SET}' > ${f} && psql -f ${f}`), /пишет эта же команда/);
    await deny(bash(`cp /tmp/other.sql ${f}; psql < ${f}`), /пишет эта же команда/);
    await silent(bash(`cat ${f} && psql -f ${f}`));
  });

  // Охранные (7b): зелёные до и после; краснеют на отвергнутой альтернативе «запрещать любой $ в SQL».
  it('passes literal SQL that merely contains a dollar sign, and dynamic values that are not SQL', async () => {
    await silent(bash(`psql -c 'SELECT $1::int'`));
    await silent(bash(`psql -c "SELECT '\\$5'"`));
    await silent(bash(`psql -c "SELECT jsonb_path_query(doc, '$.a') FROM t"`));
    await silent(bash("psql <<'SQL'\nPREPARE p AS SELECT $1::int; EXECUTE p(1);\nSQL"));
    await silent(bash('psql -h db -U "$PGUSER" -d wms -c "SELECT 1"'));
    await silent(bash(`kubectl exec pod/pg -- sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT 1"'`));
  });
  it('reads an unquoted here-doc where the shell expands nothing, and psql variables :\'x\' in a here-doc', async () => {
    await silent(bash("psql <<SQL\nSELECT jsonb_path_query(doc, '$.a'), relname ~ '^a.$' FROM t;\nSQL"));
    await silent(bash("psql -v id=5 <<'SQL'\nSELECT * FROM t WHERE id = :'id';\nSQL"));
    await deny(bash("psql -v t=0 <<'SQL'\nSET statement_timeout = :'t';\nSQL"), /statement_timeout/);
  });
  it('judges SQL piped from a literal echo or cat here-doc, and denies it when the text is built by expansion', async () => {
    await silent(bash('echo "SELECT 1" | psql'));
    await deny(bash(`echo "${SET}" | psql`), /statement_timeout/);
    await silent(bash("cat <<'SQL' | psql wms\nSELECT 1;\nSQL"));
    await deny(bash("cat <<'SQL' | psql wms\n" + SET + ";\nSQL"), /statement_timeout/);
    await deny(bash('cat <<SQL | psql wms\nSELECT $X;\nSQL'), HIDDEN);
  });
});

describe('pg-session — only opaque parts that can reach psql count', () => {
  it('stays silent when a substitution elsewhere in the command cannot reach the pg call', async () => {
    await silent(bash('echo "== $(date +%T) =="; psql -c "SELECT 1"'));
    await silent(bash('X=$(pwd); psql -c "SELECT 1"'));
    await silent(bash('echo "$(date)"; kubectl --context kind-lms-local exec pod/pg -- psql -Atc "SELECT 1"'));
    await silent(bash('psql -c "SELECT 1" | gzip > "out-$(date +%s).gz"'));
  });
  it('keeps unknown when a substitution feeds the connection or its settings', async () => {
    await unknown(bash('DB=$(cat db); psql -d "$DB" -c "SELECT 1"'), /подстановк/);
    await unknown(bash(`export PGOPTIONS="$(printf -- '-c statement_timeout=0')"; psql -c 'SELECT 1'`), /PGOPTIONS/);
    await unknown(bash('cat x.sql | psql wms'), /stdin из другой команды/);
    await unknown(bash(`echo "$(echo "$(echo "$(echo "$(echo "$(psql -c 'SELECT 1')")")")")"`), /вложенност|глубже/);
  });
  it('reports every reason of the top rank, and the hints of every deny', async () => {
    await deny(bash("psql -c \"SET statement_timeout = 0; SET lock_timeout = '1s'\""), /statement_timeout[\s\S]*lock_timeout/);
    const v = await bash(`psql -c "SET statement_timeout = 0; SELECT '$X'"`);
    assert.equal(v.kind, 'deny', JSON.stringify(v));
    const reason = (v as { reason: string }).reason;
    assert.match(reason, /подстановк[\s\S]*statement_timeout|statement_timeout[\s\S]*подстановк/);
    assert.match(reason, /GRANT SELECT/, 'подсказка про сессионный SET потерялась');
    assert.match(reason, /-f \/абсолютный/, 'подсказка про скрытый SQL потерялась');
    await unknown(bash('DB=$(cat db); psql -d "$DB" -f missing.sql'), /(подстановк[\s\S]*файл SQL не прочитан|файл SQL не прочитан[\s\S]*подстановк)/);
  });
});

// Gate 2 (race-auditor 16.09): формы, где сессионный SET уходил в базу при silent. <(…) — регрессия d302d19:
// токенизатор резал `<(` на разделителе, модель съедала голый `<` как редирект, и у -f пропадало значение.
describe('pg-session — bypasses found by the code audit', () => {
  it('denies SQL fed through process substitution <(…), and judges psql running inside one', async () => {
    await deny(bash('psql -f <(echo "SET statement_timeout = 0")'), /подстановкой \(<\(echo/);
    await deny(bash('psql < <(echo "SET statement_timeout = 0")'), /подстановк/);
    await deny(bash('kubectl exec -i pod/pg -- psql -U postgres -f <(echo "SET statement_timeout=0")'), /подстановк/);
    await deny(bash('diff <(psql -Atc "SET statement_timeout = 0") /dev/null'), /statement_timeout/);
    await silent(bash('diff <(psql -Atc "SELECT 1") <(psql -Atc "SELECT 2")'));
  });
  it('matches the GUC name of set_config case-insensitively, as Postgres does', async () => {
    await deny(bash(`psql -c "SELECT set_config('STATEMENT_TIMEOUT','0',false)"`), /statement_timeout/);
    await deny(bash(`psql -c "SELECT set_config('Lock_Timeout','0',false)"`), /lock_timeout/);
  });
  it('denies CALL — a procedure body is as opaque to the parser as a DO block', () => deny(bash('psql -c "CALL set_ro()"'), /CALL/));
  it('keeps unknown for a SQL file another program of the same command may rewrite, and stays silent for readers', async () => {
    const f = join(sb.dir, 'stale.sql'); writeFileSync(f, 'SELECT 1;\n');
    await unknown(bash(`python3 -c "open('${f}','w').write('SET statement_timeout=0')"; psql -f ${f}`), /упоминает/);
    await silent(bash(`wc -l ${f} && head -3 ${f} && psql -f ${f}`));
  });
  it('judges psql after a `[[ … ]]` glued to `;` or `&&` (REGRESSION 25.09: the grammar cut-over left the tail unparsed and silent)', async () => {
    await deny(bash('if [[ -f a.sql ]]; then echo y; fi; psql -c "SET statement_timeout = 0"'), /statement_timeout/);
    await deny(bash('[[ -n $DB ]]&& psql -c "SET statement_timeout = 0"'), /statement_timeout/);
    await deny(bash('[[ $x =~ ^(a|b)$ ]]; psql -c "SET statement_timeout = 0"'), /statement_timeout/);
  });
});

// INVARIANT: функция-обёртка с литеральными вызовами — не скрытый SQL. Текст команды целиком определяет argv psql
// на каждом вызове, и гейт судит каждый вызов как обычный psql: SET — deny, SELECT — silent. Раскрытие точное или
// никакое: условный shift, set --, "$*", ${@:2}, вызов с подстановкой, из другой оболочки или из тела другой
// функции, функция без вызова — по-прежнему deny с причиной, чего не хватило. До правки каждая обёртка была deny
// без разбора аргументов вызова (78 `$1` из прогона 16.09), а комментарий с именем функции перед объявлением
// ломал разметку тела, и psql судился как вызов вне функции.
describe('pg-session — a wrapper function with literal call sites is judged per call, not hidden', () => {
  const SET = 'SET statement_timeout = 0';
  const SELECT = 'SELECT count(*) FROM orders';
  const PSQL = 'psql -X -v ON_ERROR_STOP=1 -h localhost -U wms -d wms';
  const HIDDEN = /подстановк|функци|xargs|пишет эта же команда/;
  const REWRITE = /<<'SQL'[\s\S]*-f \/абсолютный/;
  async function judgedPerCall(cmd: (sql: string) => string): Promise<void> {
    const v = await bash(cmd(SET));
    assert.equal(v.kind, 'deny', `${JSON.stringify(cmd(SET))} → ${JSON.stringify(v)}`);
    const reason = (v as { reason: string }).reason;
    assert.match(reason, /statement_timeout/);
    assert.doesNotMatch(reason, /места вызова|позиционных параметров/, `вызов не раскрыт: ${reason}`);
    await silent(bash(cmd(SELECT)));
  }
  const resolved: Array<[string, (sql: string) => string]> = [
    ['a one-line body with "$@"', (q) => `run() { ${PSQL} "$@"; }\nrun -c "${q}"`],
    ['a label taken with $1 and shift, then a pipe (the migration-scenario shape)', (q) => `run() {\n  local name=$1; shift\n  echo "== $name"\n  ${PSQL} "$@" 2>&1 | grep -v "^LINE"\n}\nrun "M1 old link kept" -c "${q}"\nrun "M2" -c "SELECT 1"`],
    ['the function keyword', (q) => `function run { ${PSQL} "$@"; }; run -c "${q}"`],
    ['the function keyword with ()', (q) => `function run() { ${PSQL} "$@"; }; run -c "${q}"`],
    ['"$1" as the SQL', (q) => `q() { psql -Atc "$1"; }; q "${q}"`],
    ['"${1}" as the SQL', (q) => `q() { psql -Atc "\${1}"; }; q "${q}"`],
    ['a here-doc at the call site read by a body without -c/-f', (q) => `q() { psql -U postgres -At; }; q <<'SQL'\n${q};\nSQL`],
    ['a call inside $(…) at the same shell level', (q) => `q() { psql -Atc "$1"; }; N=$(q "${q}"); echo "$N"`],
    ['definition and calls inside one bash -c', (q) => `bash -c '\nrun() { ${PSQL} "$@"; }\nrun -c "${q}"\n' 2>&1 | grep -v "^LINE"`],
    ['a comment with the function name before the definition', (q) => `# run each scenario\nrun() {\n  local name=$1; shift\n  ${PSQL} "$@"\n}\nrun "M1" -c "${q}"`],
    ['shift 2', (q) => `run() { shift 2; ${PSQL} "$@"; }; run a b -c "${q}"`],
    ['psql behind kubectl exec inside the body', (q) => `run() { kubectl exec -i pod/pg -- psql -U postgres "$@"; }; run -c "${q}"`],
    ['the second of two calls carrying the SET', (q) => `run() { ${PSQL} "$@"; }\nrun -c "SELECT 1"\nrun -c "${q}"`],
    ['set -euo pipefail in the body — flags do not touch the parameters', (q) => `run() { set -euo pipefail; ${PSQL} "$@"; }; run -c "${q}"`],
  ];
  for (const [how, cmd] of resolved) it(`resolves ${how}: SET is denied by its own rule, SELECT passes`, () => judgedPerCall(cmd));

  it('reads -f files named at the call site, relative to cwd, the same file in several calls included', async () => {
    writeFileSync(join(sb.dir, 't0-before.sql'), 'SELECT 1;\n');
    writeFileSync(join(sb.dir, 'm1.sql'), 'SELECT 2;\n');
    writeFileSync(join(sb.dir, 'bad.sql'), `${SET};\n`);
    const run = `run() {\n  local name=$1; shift\n  echo "== $name"\n  ${PSQL} "$@" 2>&1 | grep -v "^LINE"\n}\n`;
    await silent(bash(`${run}run "M1 old link kept" -f t0-before.sql -f m1.sql -c ROLLBACK\nrun "M2" -f t0-before.sql -c ROLLBACK`));
    await deny(bash(`${run}run "M1" -f t0-before.sql -c ROLLBACK\nrun "M3" -f t0-before.sql -f bad.sql -c ROLLBACK`), /statement_timeout/);
    await silent(bash(`run() { ${PSQL} $@; }; run -f ${join(sb.dir, 'm1.sql')}`));
    await unknown(bash(`run() { ${PSQL} "$@"; }; run -f missing.sql`), /файл SQL не прочитан/);
    await deny(bash(`run() { ${PSQL} "$@"; }; cp /tmp/other.sql m1.sql; run -f m1.sql`), /пишет эта же команда/);
    // Оболочка-обёртка разобрана в стадии: её argv упоминает файл только потому, что содержит внутренний вызов.
    await silent(bash(`bash -c '\n${run}run "M1" -f t0-before.sql -f m1.sql -c ROLLBACK\n' 2>&1 | grep -v "^LINE"`));
    await silent(bash(`kubectl exec -i pod/pg -- bash -c '\n${run}run "M1" -f t0-before.sql -c ROLLBACK\n'`));
    await unknown(bash(`bash gen.sh m1.sql; psql -f m1.sql`), /упоминает bash/);
  });

  const unresolved: Array<[string, (sql: string) => string, RegExp]> = [
    ['a call with a variable argument', (q) => `q() { psql -Atc "$1"; }; q "$X"; q "${q}"`, /вызов q с подстановкой/],
    ['a conditional shift', (q) => `q() { [ -n "$2" ] && shift; psql -Atc "$1"; }; q x "${q}"`, /shift в теле q под условием/],
    ['shift inside if', (q) => `q() { if [ -n "$2" ]; then shift; fi; psql -Atc "$1"; }; q x "${q}"`, /не плоское/],
    ['a subshell in the body', (q) => `q() { (shift); psql -Atc "$1"; }; q x "${q}"`, /не плоское/],
    ['set -- in the body', (q) => `q() { set -- -c "SELECT 1"; psql "$@"; }; q -c "${q}"`, /set в теле q/],
    ['eval in the body', (q) => `q() { eval shift; psql -Atc "$1"; }; q x "${q}"`, /eval в теле q/],
    ['builtin shift', (q) => `q() { builtin shift; psql -Atc "$1"; }; q x "${q}"`, /builtin в теле q/],
    ['"$*"', (q) => `q() { psql -Atc "$*"; }; q "${q}"`, /не целым словом/],
    ['${@:2}', (q) => `q() { psql "\${@:2}"; }; q x -c "${q}"`, /не целым словом/],
    ['$10 — which bash reads as $1 followed by 0', (q) => `q() { psql -Atc "$10"; }; q "${q}" a b c d e f g h i`, /не целым словом/],
    ['bare $@ with an argument that splits on a space', (q) => `q() { psql $@; }; q -c "${q}"`, /без кавычек/],
    ['$2 beyond the arguments of the call', (q) => `q() { psql -Atc "$2"; }; q "${q}"`, /за пределами аргументов/],
    ['a function never called', (q) => `q() { psql -Atc "$1"; }; echo "${q}"`, /не вызывается/],
    ['a call from sh -c', (q) => `q() { psql -Atc "$1"; }; sh -c 'q "SELECT 2"'; q "${q}"`, /другой оболочки/],
    ['a call from another function body', (q) => `q() { psql -Atc "$1"; }; w() { q "$1"; }; w "${q}"`, /из тела функции/],
    ['a call through xargs', (q) => `q() { psql -Atc "$1"; }; printf '%s' "${q}" | xargs q`, /через xargs/],
    ['two definitions of the name', (q) => `q() { shift; psql -Atc "$1"; }; q() { psql -Atc "$1"; }; q "${q}"`, /дважды/],
    ['IFS reassigned', (q) => `IFS=,; q() { psql -Atc "$1"; }; q "${q}"`, /IFS/],
  ];
  for (const [how, cmd, why] of unresolved) {
    it(`still denies ${how} — for SELECT and SET alike — and says what is missing`, async () => {
      for (const q of [SELECT, SET]) {
        const v = await bash(cmd(q));
        assert.equal(v.kind, 'deny', `${JSON.stringify(cmd(q))} → ${JSON.stringify(v)}. Miss this and a shape the gate cannot expand exactly rides through as clean`);
        const reason = (v as { reason: string }).reason;
        assert.match(reason, HIDDEN); assert.match(reason, REWRITE); assert.match(reason, why);
      }
    });
  }
  it('carries the call-site stdin into the resolved call: an expansion in its here-doc stays hidden, a pipe is judged', async () => {
    await deny(bash(`q() { psql -At; }; q <<SQL\n${SET}; -- $X\nSQL`), /here-doc[\s\S]*подстановк/);
    await silent(bash(`q() { psql -At; }; q <<SQL\nSELECT 1;\nSQL`));
    await deny(bash(`q() { psql -At; }; echo "${SET}" | q`), /statement_timeout/);
    await deny(bash(`q() { psql -At; }; echo "$SQL" | q`), /подстановк/);
  });
  it('names the accepted wrapper form in the hint of a hidden-SQL deny', async () => {
    const v = await bash(`q() { psql -Atc "$1"; }; q "$X"`);
    assert.equal(v.kind, 'deny', JSON.stringify(v));
    assert.match((v as { reason: string }).reason, /функцией-обёрткой/);
  });
});

// Проба 16.09 после раскрытия функций: сессионный SET проходил молча за обёртками со строкой-командой — docker exec
// и docker run с sh -c, su -c, watch, find -exec sh -c, ssh с командой в кавычках — и в теле `sh -c 'psql' <<SQL`,
// потому что stdin оболочки не доходил до её тела. kubectl exec был закрыт 16.09 по имени; класс шире одного имени.
describe('pg-session — wrappers with a command string and the stdin of a shell body', () => {
  const SET = 'SET statement_timeout = 0';
  const forms: Array<[string, (sql: string) => string]> = [
    ['sh -c with a here-doc', (q) => `sh -c 'psql -U postgres' <<'SQL'\n${q};\nSQL`],
    ['sh -c whose body runs psql second', (q) => `sh -c 'echo start; psql -U postgres' <<'SQL'\n${q};\nSQL`],
    ['a pipe into sh -c', (q) => `echo "${q}" | sh -c 'psql -U postgres'`],
    ['docker exec sh -c with a here-doc', (q) => `docker exec -i pg sh -c 'psql -U postgres' <<'SQL'\n${q};\nSQL`],
    ['docker run bash -c', (q) => `docker run --rm pg bash -c 'psql -c "${q}"'`],
    ['su -c', (q) => `su - postgres -c 'psql -c "${q}"'`],
    ['watch with a quoted command', (q) => `watch 'psql -c "${q}"'`],
    ['find -exec sh -c', (q) => `find . -name '*.sql' -exec sh -c 'psql -c "${q}"' \;`],
    ['ssh with a quoted command', (q) => `ssh -p 2222 deploy@db-host 'psql -c "${q}"'`],
  ];
  for (const [how, cmd] of forms) {
    it(`judges SQL behind ${how}: SET is denied, SELECT passes`, async () => {
      await deny(bash(cmd(SET)), /statement_timeout/);
      await silent(bash(cmd('SELECT count(*) FROM orders')));
    });
  }
  // ssh склеивает слова в одну строку, и удалённая оболочка разбирает её заново: задуманный argv судится как аргумент
  // обёртки (SET — deny), а склейка — как строка (у `-c` остаётся одно слово SELECT, пустой SELECT валиден — silent).
  it('ssh joins bare words into one string for the remote shell: the intended SET is denied, the quoted form is judged as written', async () => {
    await deny(bash(`ssh db-host psql -c "${SET}"`), /statement_timeout/);
    await silent(bash('ssh db-host psql -c "SELECT 1"'));
    // Голые скобки удалённая оболочка не разберёт: строка вне грамматики, и гейт спрашивает, а не молчит.
    assert.equal((await bash('ssh db-host psql -c "SELECT count(*) FROM orders"')).kind, 'unknown');
    await silent(bash(`ssh db-host "psql -c 'SELECT 1'"`));
    await deny(bash(`ssh db-host "psql -c '${SET}'"`), /statement_timeout/);
  });
});
