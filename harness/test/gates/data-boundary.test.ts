// INVARIANT (граница данных, H20): вердикт выводится из стадий команды (argv, тела here-doc и $(…)) и узлов AST,
// а не из подстрок текста. Комментарий shell, комментарий и строковый литерал SQL, аргумент чужой стадии вердикт
// не меняют; каждый оператор SQL-пакета судится отдельно и худший побеждает; недоказуемое — unknown, не silent;
// каждое deny/unknown-правило достижимо через префильтр шима.
// REGRESSION 22f586e (bash-черновик hooks/data-boundary-guard.sh, проба 10.09): текстовое сопоставление давало
// exit 0 на `cat ~/.pgpass # see data-answers.sh` (исключение по подстроке) и на
// `mcp-pg-prod.sh -c "select count(*) from orders; select id, phone from customers"` (слово-агрегат в любом месте
// разрешало всю команду); контрольные `cat ~/.pgpass` и выборка колонок с прода давали exit 2.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, payload, bashPayload, onlyGate, HARNESS_ROOT } from '../_env.ts';
import { decide, NAME, KILL } from '../../src/gates/data-boundary.ts';
import { PRE_BASH_REGEX } from '../../src/gates/prefilters.ts';
import { SECRET_BASENAMES, SECRET_EXTENSIONS, SECRET_REPO_PATHS } from '../../src/gates/secret-files.ts';
import { route } from '../../src/main.ts';
import type { GateContext, HarnessEvent, HookPayload, Verdict } from '../../src/types.ts';

const sb = sandbox('harness-db-');
after(() => sb.cleanup());
const env = { HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, HARNESS_ROOT };
mkdirSync(join(sb.home, '.claude'), { recursive: true });
writeFileSync(join(sb.home, '.claude', 'harness.config.json'), JSON.stringify({ dataBoundary: { configTables: ['app_settings', 'feature_flags', 'warehouses'] } }));

function ctx(event: HarnessEvent, p: Record<string, unknown>): GateContext {
  return { event, payload: p as unknown as HookPayload, env, root: HARNESS_ROOT, stateDir: sb.stateDir, now: () => 0 };
}
const bash = (command: string): Promise<Verdict> => Promise.resolve(decide(ctx('pre-bash', bashPayload(command, { cwd: sb.dir }))));

type Expect = 'deny' | 'unknown' | 'silent';
interface Probe { expect: Expect; says: string; cmd: string; re?: RegExp }
const D = (says: string, cmd: string, re: RegExp): Probe => ({ expect: 'deny', says, cmd, re });
const U = (says: string, cmd: string, re: RegExp): Probe => ({ expect: 'unknown', says, cmd, re });
const S = (says: string, cmd: string): Probe => ({ expect: 'silent', says, cmd });

async function verdict(p: Probe): Promise<void> {
  const v = await bash(p.cmd);
  assert.deepEqual({ cmd: p.cmd, kind: v.kind }, { cmd: p.cmd, kind: p.expect });
  if (p.re) assert.match((v as { reason: string }).reason, p.re);
}
const title = (p: Probe): string => `${p.expect === 'deny' ? 'denies' : p.expect === 'unknown' ? 'answers unknown for' : 'passes'} ${p.says}`;

const WRAP = '~/.claude/bin/mcp-pg-prod.sh';
/** Настоящий прод-канал: MCP-клиент, поднимающий обёртку stdio, SQL — литерал JS. */
const CLIENT = (sqlLiteral: string): string =>
  "node --input-type=module <<'JS'\nconst srv = start(process.env.HOME + '/.claude/bin/mcp-pg-prod.sh');\nawait callQuery(srv, " + sqlLiteral + ");\nJS";

// 20 команд черновика + kill-switch и чужой инструмент ниже = 22 пробы hooks/spec/data-boundary-guard.test.sh.
const DRAFT: Probe[] = [
  D('SELECT * over the prod host variable', 'psql "$PG_PROD_HOST" -c "select * from orders limit 5"', /прод-строки/),
  D('a column list from prod', `${WRAP} -c "select id, phone from customers"`, /прод-строки/),
  S('an aggregate from prod', `${WRAP} -c "select count(*) from orders"`),
  S('the catalog from prod', `${WRAP} -c "select * from pg_catalog.pg_tables"`),
  S('a configuration snapshot from prod', `${WRAP} -c "select jsonb_build_object(\\"s\\", current_setting(\\"x\\"))"`),
  // 23.09, owner decision: the connector's warehouse registry is configuration (code, name, is_active, timezone, schedule, config,
  // merchant owner); its addresses and coordinates in warehouses_locations stay out.
  S('the connector warehouse registry from prod is configuration', `~/.claude/bin/mcp-pg-connector-prod.sh -c "select code, name, is_active, timezone, schedule, config from warehouses where code = 'WH-MAIN' limit 50"`),
  D('rows through the Django prod wrapper are prod rows', `~/.claude/bin/mcp-pg-django-prod.sh -c "select id, phone from customers"`, /прод-строки.*customers/),
  D('warehouse addresses and coordinates from prod stay rows', `~/.claude/bin/mcp-pg-connector-prod.sh -c "select address, latitude, longitude from warehouses_locations"`, /прод-строки.*warehouses_locations/),
  S('the same SELECT * on the local stand', 'psql -h 127.0.0.1 -c "select * from orders limit 5"'),
  D('pg_dump of the dev database', 'pg_dump -h pg-dev.internal -d wms > /tmp/d.sql', /выкачка/),
  D('kubectl cp out of shop', 'kubectl -n shop cp pod:/var/data ./data', /выкачка/),
  D('COPY TO from dev', 'psql -h pg-dev -c "copy orders to stdout csv"', /выкачка/),
  S('pg_dump of the local stand', 'pg_dump -h 127.0.0.1 -d lms_local > /tmp/d.sql'),
  D('LIMIT 5000 on dev', 'psql -h pg-dev -c "select id from orders limit 5000"', /выкачка/),
  S('LIMIT 50 on dev', 'psql -h pg-dev -c "select id from orders limit 50"'),
  D('cat .pgpass', 'cat ~/.pgpass', /секрет в вывод/),
  D('grep of a token in .npmrc', 'grep authToken ~/.npmrc', /секрет в вывод/),
  D('a keychain password into the output', 'security find-generic-password -s "Claude Code-credentials" -w', /секрет в вывод/),
  D('decoding a k8s secret', 'kubectl get secret x -o jsonpath="{.data.token}" | base64 -d', /секрет в вывод/),
  S('a keychain value straight into create secret', 'kubectl create secret generic x --from-literal=t="$(security find-generic-password -s c -w)"'),
  S('a presence check without printing', 'test -s ~/.pgpass && echo present'),
  S('the key names of a secret', 'kubectl get secret x -o jsonpath="{.data}" | jq keys'),
  S('text about the rule, which is not a violation', 'node harness/scripts/data-answers.ts --classify "select * from customers"'),
  S('the documented launcher form of the same text', '~/.claude/harness/bin/run scripts/data-answers.ts --classify "select * from customers"'),
];

const SQL_AS_NODES: Probe[] = [
  S('a column select that exists only inside a block comment', `${WRAP} -c "/* select id, phone from customers */ select count(*) from orders"`),
  S('a column select that exists only after a line comment marker', `${WRAP} -c "-- select id, phone from customers\nselect count(*) from orders"`),
  S('a column select that exists only as a string literal in a filter', `${WRAP} -c "select count(*) from orders where note <> 'select id, phone from customers'"`),
  S('a FROM-less select of a string that looks like a query', `${WRAP} -c "select 'select id from customers'"`),
  D('a column select whose only aggregate sits in a comment', `${WRAP} -c "select phone from customers /* count(*) */"`, /прод-строки.*customers/),
  D('jsonb_build_object over a column — it wraps the rows, it does not aggregate them', `${WRAP} -c "select jsonb_build_object('p', phone) from customers"`, /прод-строки.*customers/),
  S('jsonb_build_object over count(*) — the one-query snapshot form', `${WRAP} -c "select jsonb_build_object('n', count(*)) from customers"`),
  D('string_agg over a column — a collecting aggregate carries every value', `${WRAP} -c "select string_agg(phone, ',') from customers"`, /прод-строки.*customers/),
  D('rows smuggled through a CTE', `${WRAP} -c "with x as (select phone from customers) select * from x"`, /прод-строки.*customers/),
  D('rows smuggled through one branch of a UNION', `${WRAP} -c "select 1 union select phone from customers"`, /прод-строки.*customers/),
  D('rows smuggled through a scalar subquery', `${WRAP} -c "select (select phone from customers limit 1)"`, /прод-строки.*customers/),
  D('rows returned by RETURNING', `${WRAP} -c "delete from customers where false returning phone"`, /прод-строки.*customers/),
  U('a grouped count that prints the key of a business table — key cardinality is not proven', `${WRAP} -c "select status, count(*) from orders group by status"`, /GROUP BY/),
  S('configuration rows and business counts in one snapshot', `${WRAP} -c "select jsonb_build_object('types', (select jsonb_agg(t) from feature_flags t), 'orders', (select count(*) from orders))"`),
  D('business rows inside a snapshot', `${WRAP} -c "select jsonb_build_object('c', (select jsonb_agg(c) from customers c))"`, /прод-строки.*customers/),
];

const SHELL_STAGES: Probe[] = [
  D('a credential read after && — every stage is judged', 'echo ok && cat ~/.pgpass', /секрет в вывод.*\.pgpass/),
  D('a prod column select after ;', `ls -la; ${WRAP} -c "select * from customers"`, /прод-строки.*customers/),
  S('a local SELECT * next to a prod aggregate — the contour belongs to its stage', `${WRAP} -c "select count(*) from orders"; psql -h 127.0.0.1 -c "select * from orders"`),
  D('pg_dump whose host is exported by the neighbouring segment', 'export PGHOST=pg-dev.internal; pg_dump wms > d.sql', /выкачка.*pg-dev\.internal/),
  D('a credential read inside bash -c', 'bash -c "cat ~/.pgpass | head -1"', /секрет в вывод.*\.pgpass/),
  D('a credential read piped into tee, which prints', 'cat ~/.npmrc | tee /tmp/npmrc.copy', /секрет в вывод.*\.npmrc/),
  S('a credential read reduced to a line count', 'cat ~/.pgpass | wc -l'),
  D('pg_dump of dev whose redirect target merely contains the word localhost', 'pg_dump -h pg-dev.internal -d wms > /tmp/localhost.sql', /выкачка.*pg-dev\.internal/),
  S('grep for the word .pgpass in documentation — a pattern is not a file', 'grep -rn .pgpass docs/'),
  D('cat .env', 'cat .env', /секрет в вывод.*\.env/),
  S('cat .env.example — a template carries no values', 'cat .env.example'),
];

const EXEMPTION_BELONGS_TO_STAGE: Probe[] = [
  D('a fake --from-literal in a preceding echo', 'echo --from-literal; cat ~/.pgpass', /секрет в вывод.*\.pgpass/),
  D('a fake create secret in a quoted echo before a keychain read', 'echo "kubectl create secret generic x"; security find-generic-password -s c -w', /секрет в вывод.*keychain/),
  D('a real create secret followed by an unrelated credential read', 'kubectl create secret generic x --from-literal=a=b; cat ~/.pgpass', /секрет в вывод.*\.pgpass/),
  S('a credential file substituted straight into create secret', 'kubectl create secret generic pg --from-literal=pgpass="$(cat ~/.pgpass)"'),
  D('create secret that prints its manifest with the value', 'kubectl create secret generic x --from-literal=t="$(security find-generic-password -s c -w)" --dry-run=client -o yaml', /секрет в вывод.*-o yaml/),
  S('the same manifest piped into kubectl apply', 'kubectl create secret generic x --from-literal=t="$(security find-generic-password -s c -w)" --dry-run=client -o yaml | kubectl apply -f -'),
  D('the values of a k8s secret printed as yaml', 'kubectl get secret x -o yaml', /секрет в вывод.*-o yaml/),
  S('a k8s secret listed without values', 'kubectl get secret x'),
  S('a k8s secret described — key names and sizes only', 'kubectl describe secret x'),
  S('a keychain item looked up without -w — attributes only', 'security find-generic-password -s c'),
];

const CONTOUR: Probe[] = [
  S('kubectl cp INTO a pod — upload is not extraction', 'kubectl -n shop cp ./seed.sql pod:/tmp/seed.sql'),
  S('kubectl cp out of a pod on the kind stand', 'kubectl --context kind-lms-local cp pod:/var/data ./data'),
  // REGRESSION 23.09: the stand moved from kind to k3s in colima (context `colima`) and its rows read as a remote contour.
  S('rows from the k3s stand in colima — the local VM', `kubectl --context colima -n lms-local exec deploy/postgres -- psql -U postgres -c "select id from companies"`),
  S('rows from another colima profile — also a local VM', `kubectl --context colima-tracker exec deploy/db -- psql -c "select id from companies"`),
  U('a context that only starts with the word colima is not local', `kubectl --context colimax exec deploy/db -- psql -c "select id from companies"`, /непокального контура/),
  S('pg_dump --schema-only of dev — the schema is configuration', 'pg_dump -s -h pg-dev.internal -d wms > schema.sql'),
  D('LIMIT ALL on dev', 'psql -h pg-dev -c "select id from orders limit all"', /выкачка.*LIMIT ALL/),
];

const PROD_CLIENT: Probe[] = [
  D('a column select in the JS literal of an MCP client that starts the prod wrapper', CLIENT("'select id, phone from customers'"), /прод-строки.*customers/),
  S('an aggregate in the JS literal of the same client', CLIENT("'select count(*) from orders'")),
  S('a command that names the wrapper but carries no SQL', 'ls -la ~/.claude/bin/mcp-pg-prod.sh'),
];

const UNKNOWN: Probe[] = [
  U('unparsable SQL sent to prod', `${WRAP} -c "SELEC id FROMM customers"`, /SQL не разобран/),
  U('SQL for dev that arrives by command substitution', 'psql -h pg-dev -c "$(cat q.sql)"', /подстановк/),
  U('SQL for prod that arrives on stdin', `cat q.sql | ${WRAP}`, /stdin/),
  U('kubectl cp with no pod side', 'kubectl cp a b', /направлени/),
  U('pg_dump whose host is a variable without a prod marker', 'pg_dump -h "$DB_HOST" wms > d.sql', /\$DB_HOST/),
  U('a DO block sent to prod', `${WRAP} -c "DO $$ BEGIN RAISE NOTICE '%', 1; END $$"`, /DO/),
  U('a dev query with an unterminated quote', 'psql -h pg-dev -c "select id from orders limit 5', /незакрыт/),
  U('a template literal with interpolation in the prod client', CLIENT('`select ${cols} from customers`'), /не разобран/),
];

const H20: Probe[] = [
  D('a password key in printed JSON', `echo '{"password":"hunter2"}'`, /секрет в вывод.*«password»/),
  S('a login key in printed JSON', `echo '{"login":"alice"}'`),
  D('a jq projection of an authorization header from a dump', "jq '.request.headers.authorization' network.json", /секрет в вывод.*«authorization»/),
  S('a jq projection of a login field', "jq '.request.headers.login' network.json"),
  S('a jq filter that deletes the password — redaction, not projection', "jq 'del(.password)' network.json"),
  D('the environment filtered for tokens', 'env | grep -i token', /секрет в вывод.*«token»/),
  S('the environment counted for tokens', 'env | grep -c TOKEN'),
  S('the environment filtered for login', 'env | grep -i login'),
  D('a token extracted from a HAR dump', `grep -o '"token":"[^"]*"' session.har`, /секрет в вывод.*«token»/),
  S('a login extracted from a HAR dump', `grep -o '"login":"[^"]*"' session.har`),
  S('a source search for the word Authorization — code is not a dump', 'grep -rn Authorization src/'),
  D('curl -v with an Authorization header — verbose mode prints it expanded', 'curl -v -H "Authorization: Bearer $T" https://api.example.invalid', /секрет в вывод.*«Authorization»/),
  S('the same curl without -v', 'curl -H "Authorization: Bearer $T" https://api.example.invalid'),
  S('curl -v with a login header', 'curl -v -H "X-Login: t" https://api.example.invalid'),
  D('echo of a token variable', 'echo "$GITLAB_TOKEN"', /секрет в вывод.*GITLAB_TOKEN/),
  S('echo of the length of a token variable', 'echo "${#GITLAB_TOKEN}"'),
  D('printenv of a token variable', 'printenv NPM_TOKEN', /секрет в вывод.*NPM_TOKEN/),
  D('an authorization key printed by cat from a here-doc', "cat <<'EOF'\n{\"authorization\": \"Bearer x\"}\nEOF", /секрет в вывод.*«authorization»/),
  S('the same kind of JSON written to a fixture file — an artifact, not output', "cat > fixture.json <<'EOF'\n{\"password\": \"x\"}\nEOF"),
];

// Находки spec-critic по черновику спеки: каждая — команда, которую спека пропускала или ложно блокировала.
writeFileSync(join(sb.dir, 'q.sql'), 'select id, phone from customers\n');
writeFileSync(join(sb.dir, 'kind.yaml'), 'apiVersion: v1\ncurrent-context: kind-lms-local\n');
const CRITIC: Probe[] = [
  D('a column select sent through the real prod client prodq.mjs', "SQL='select id, phone from customers' node ~/.claude/mcp/pg-server/prodq.mjs", /прод-строки.*customers/),
  S('an aggregate sent through prodq.mjs', "SQL='select count(*) from orders' node ~/.claude/mcp/pg-server/prodq.mjs"),
  D('a column select that prodq.mjs reads from a file', 'node ~/.claude/mcp/pg-server/prodq.mjs q.sql', /прод-строки.*customers/),
  D('query_to_xml — a FROM-less select that reads a table by query text', `${WRAP} -c "select query_to_xml('select * from customers', true, false, '')"`, /прод-строки.*query_to_xml/),
  D('column values from pg_stats — the statistics view is not configuration', `${WRAP} -c "select most_common_vals from pg_stats where tablename = 'customers'"`, /прод-строки.*pg_stats/),
  U('max() per grouping key — a value per row, not an aggregate', `${WRAP} -c "select id, max(phone) from customers group by id"`, /GROUP BY/),
  D('rows smuggled through a subquery inside unnest()', `${WRAP} -c "select * from unnest(array(select phone from customers))"`, /прод-строки.*customers/),
  U('a function outside the known list on prod', `${WRAP} -c "select my_report()"`, /my_report/),
  D('a substitution in --from-literal without a key — kubectl echoes the value in its error', 'kubectl create secret generic x --from-literal="$(cat ~/.pgpass)"', /секрет в вывод.*\.pgpass/),
  D('a credential read repeated after a reduced one', 'cat ~/.pgpass | wc -l && cat ~/.pgpass', /секрет в вывод.*\.pgpass/),
  D('a credential read followed by || — not a pipe', 'cat ~/.pgpass || wc -l', /секрет в вывод.*\.pgpass/),
  D('a credential read behind the then keyword', 'if true; then cat ~/.pgpass; fi', /секрет в вывод.*\.pgpass/),
  D('a credential path handed to xargs cat', 'echo ~/.pgpass | xargs cat', /секрет в вывод.*xargs/),
  D('find -exec cat on a credential file', 'find ~ -name .pgpass -exec cat {} \\;', /секрет в вывод.*\.pgpass/),
  D('diff against a credential file', 'diff /dev/null ~/.pgpass', /секрет в вывод.*\.pgpass/),
  D('a credential path in inline interpreter code', `python3 -c "print(open('.env').read())"`, /секрет в вывод.*\.env/),
  D('a credential file on stdin', 'cat <.env', /секрет в вывод.*\.env/),
  D('a secret printed with -n before the resource', 'kubectl get -n wms secret db -o yaml', /секрет в вывод.*-o yaml/),
  D('a secret printed with --namespace= before the resource', 'kubectl get --namespace=wms secret db -o json', /секрет в вывод.*-o json/),
  D('the whole environment printed', 'env', /секрет в вывод.*окружения/),
  U('a dev select without LIMIT — the volume is not proven', 'psql -h pg-dev -c "select id from orders"', /без LIMIT/),
  U('a select on a remote host without a dev or prod marker', 'psql -h 10.0.3.7 -c "select id from orders limit 5"', /прод не исключён/),
  D('a psql shell escape on the local stand', "psql -h 127.0.0.1 -c '\\! cat ~/.pgpass'", /секрет в вывод.*\.pgpass/),
  D('\\copy to a file inside a dev here-doc', "psql -h pg-dev <<'SQL'\n\\copy orders to 'o.csv' csv\nSQL", /выкачка.*COPY/),
  S('output_tokens, which is not a token key', 'jq .usage.output_tokens ai-usage-raw.jsonl'),
  S('kubectl cp out of a pod when the given kubeconfig points at kind', 'KUBECONFIG=kind.yaml kubectl cp pod:/var/data ./data'),
];

// REGRESSION 23.09: a task-audit subagent printed the TSD keystore passwords with the first command below —
// the secret file is tracked in the repo under its own name and the path came inside a git object `<ref>:<path>`.
const TSD = 'companies/companies.json';
const SECRET_FILES: Probe[] = [
  D('git show of the mobile app companies.json from a ref — the 23.09 command', `git -C "$APP_MOBILE" show 'origin/product/main:${TSD}'`, /секрет в вывод.*companies\.json/),
  D('the same git show piped into sed that tries to mask the values', `git -C "$APP_MOBILE" show 'origin/product/main:${TSD}' | sed -E 's/(Password": ")[^"]*/\\1***/'`, /секрет в вывод.*companies\.json/),
  D('git show of a secret blob piped into cut', `git show HEAD:${TSD} | cut -c1-40`, /секрет в вывод/),
  D('git show of a secret blob piped into head', `git show HEAD:./${TSD} | head -5`, /секрет в вывод/),
  D('git show --stat of a blob — a blob ignores diff options and prints itself', `git show --stat HEAD:${TSD}`, /секрет в вывод/),
  D('git cat-file -p of a secret blob', `git cat-file -p HEAD:${TSD}`, /секрет в вывод/),
  D('git cat-file blob of keystore.properties', 'git cat-file blob HEAD:android/keystore.properties', /секрет в вывод.*keystore\.properties/),
  D('git grep of storePassword in the secret file', `git grep -n storePassword -- ${TSD}`, /секрет в вывод/),
  D('git log -p over the secret file — history carries the values', `git log -p -- ${TSD}`, /секрет в вывод/),
  D('git diff of the secret file', `git diff HEAD~1 -- ${TSD}`, /секрет в вывод/),
  D('git show of .env from a ref', 'git show main:.env', /секрет в вывод.*\.env/),
  D('cat of keystore.properties', 'cat android/keystore.properties', /секрет в вывод.*keystore\.properties/),
  D('base64 of a release keystore', 'base64 android/app/release.keystore', /секрет в вывод.*release\.keystore/),
  D('sed -n over the secret file', `sed -n '1,20p' ${TSD}`, /секрет в вывод/),
  D('grep with context in the secret file', `grep -A2 wms ${TSD}`, /секрет в вывод/),
  D('jq that prints a whole element of the secret file', `jq '.[0]' ${TSD}`, /секрет в вывод/),
  D('jq that prints keys and a value together', `jq 'keys, .[0]' ${TSD}`, /секрет в вывод/),
  D('jq that indexes by a computed value — the error message carries the value', `jq '.[.[0].name] | keys' ${TSD}`, /секрет в вывод/),
  S('a presence check of the secret file', `test -s ${TSD} && echo present`),
  S('the byte size of the secret file', `wc -c ${TSD}`),
  S('jq keys over the secret file', `jq 'keys' ${TSD}`),
  S('jq keys of one element of the secret file', `jq '.[0] | keys' ${TSD}`),
  S('jq length of the secret file', `jq length ${TSD}`),
  S('git cat-file -s — the size of a secret blob', `git cat-file -s HEAD:${TSD}`),
  S('git cat-file -e — the existence of a secret blob', `git -C "$APP_MOBILE" cat-file -e origin/product/main:${TSD}`),
  S('git ls-files of the secret file', `git ls-files ${TSD}`),
  S('git log without a patch over the secret file', `git log --oneline -- ${TSD}`),
  S('git diff --name-only over the secret file', `git diff --name-only HEAD~1 -- ${TSD}`),
  S('git grep -c of storePassword in the secret file', `git grep -c storePassword -- ${TSD}`),
  S('git add of .env — staging prints nothing', 'git add .env'),
  S('git show of an ordinary file from a ref', 'git show HEAD:package.json'),
  S('grep for the name companies.json in sources — a pattern is not a file', 'grep -rn companies.json android/'),
];

const ALL: Probe[] = [...DRAFT, ...SQL_AS_NODES, ...SHELL_STAGES, ...EXEMPTION_BELONGS_TO_STAGE, ...CONTOUR, ...PROD_CLIENT, ...UNKNOWN, ...H20, ...CRITIC, ...SECRET_FILES];

describe('data-boundary — draft corpus, both sides (22f586e hooks/spec/data-boundary-guard.test.sh)', () => {
  for (const p of DRAFT) it(title(p), () => verdict(p));
  it(`${KILL}=1 through route(): silent before the gate runs; without it the same payload is denied by ${NAME}`, async () => {
    const p = bashPayload('cat ~/.pgpass', { cwd: sb.dir }) as unknown as HookPayload;
    assert.deepEqual(await route('pre-bash', p, { ...env, ...onlyGate(NAME), [KILL]: '1' }), { kind: 'silent' });
    const live = await route('pre-bash', p, { ...env, ...onlyGate(NAME) });
    assert.deepEqual({ kind: live.kind, gate: (live as { gate?: string }).gate }, { kind: 'deny', gate: NAME });
  });
  it('ignores tools other than Bash even when they touch a credential file', async () => {
    assert.deepEqual(await decide(ctx('pre-bash', payload('PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/x/.pgpass' } }))), { kind: 'silent' });
  });
});

describe('data-boundary — bypasses of the text draft (red on its literal port)', () => {
  it('REGRESSION 22f586e: a shell comment naming data-answers.sh does not exempt printing ~/.pgpass — the control without it is denied too', async () => {
    await verdict(D('the commented form', 'cat ~/.pgpass # see data-answers.sh', /секрет в вывод/));
    await verdict(D('the control', 'cat ~/.pgpass', /секрет в вывод/));
  });
  it('REGRESSION 22f586e: count(*) in the first statement does not cover a column select in the second — two aggregates pass', async () => {
    await verdict(D('the mixed batch', `${WRAP} -c "select count(*) from orders; select id, phone from customers"`, /прод-строки/));
    await verdict(S('two aggregates', `${WRAP} -c "select count(*) from orders; select count(*) from customers"`));
  });
});

describe('data-boundary — SQL is judged as nodes: comments and string literals are not statements', () => {
  for (const p of SQL_AS_NODES) it(title(p), () => verdict(p));
});
describe('data-boundary — several shell operators: every stage is judged, the contour belongs to its stage', () => {
  for (const p of SHELL_STAGES) it(title(p), () => verdict(p));
});
describe('data-boundary — an exemption belongs to the stage that consumes the value', () => {
  for (const p of EXEMPTION_BELONGS_TO_STAGE) it(title(p), () => verdict(p));
});
describe('data-boundary — contour is read from -h and --context values, direction from the pod side', () => {
  for (const p of CONTOUR) it(title(p), () => verdict(p));
});

// Owner decision 24.09: _dev / _prod / _local at the end of the database or user name name the contour. The suffix only
// settles a host without a label; a labelled host wins, and a remote host never becomes local because of a name.
const IP = 'psql -h 10.0.0.7 -p 5000';
const ROWS = '-c "select id from orders limit 10"';
const NAME_SUFFIX: Probe[] = [
  S('rows from a bare-IP host whose database ends with _dev', `${IP} -d app_engine_dev ${ROWS}`),
  S('_dev given by --dbname=', `${IP} --dbname=app_engine_dev ${ROWS}`),
  S('_dev given by a joined -d', `${IP} -dapp_engine_dev ${ROWS}`),
  S('_dev given by the user name', `${IP} -U claude_dev -d wms ${ROWS}`),
  S('_dev given by a URL path', `psql postgres://ro@10.0.0.7:5000/app_engine_dev ${ROWS}`),
  S('_dev given by conninfo dbname=', `psql "host=10.0.0.7 dbname=app_engine_dev" ${ROWS}`),
  S('_dev given by PGDATABASE', `PGDATABASE=app_engine_dev ${IP} ${ROWS}`),
  D('a prod host keeps prod even when the database says _dev', `psql -h pg-prod -d app_engine_dev ${ROWS}`, /прод-строки/),
  D('_prod makes a bare-IP host prod', `${IP} -d app_engine_prod ${ROWS}`, /прод-строки/),
  D('_prod makes a dev-labelled host prod', `psql -h pg-dev -d app_engine_prod ${ROWS}`, /прод-строки/),
  D('a _prod user outweighs a _dev database', `${IP} -U app_prod -d app_engine_dev ${ROWS}`, /прод-строки/),
  U('_local on a remote host stays remote — the gate is not switched off by a name', `${IP} -d app_engine_local ${ROWS}`, /непокального контура/),
  U('the suffix must end the name — _dev in the middle is not a mark', `${IP} -d app_dev_copy ${ROWS}`, /непокального контура/),
  U('a database named by a variable carries no mark', `${IP} -d "$DB" ${ROWS}`, /непокального контура/),
  U('user= inside the SQL text is not a connection user', `${IP} -c "select id from orders where user=x_dev limit 10"`, /непокального контура/),
];

describe('data-boundary — a _dev/_prod/_local suffix of the database or user names the contour of an unlabelled host', () => {
  for (const p of NAME_SUFFIX) it(title(p), () => verdict(p));
});
describe('data-boundary — the real prod channel: an MCP client that names the wrapper', () => {
  for (const p of PROD_CLIENT) it(title(p), () => verdict(p));
});
describe('data-boundary — what cannot be proven is unknown, never silent', () => {
  for (const p of UNKNOWN) it(title(p), () => verdict(p));
  it('lifts unknown to ask on pre-bash through route() — an unparsed prod query is never a pass', async () => {
    const v = await route('pre-bash', bashPayload(`${WRAP} -c "SELEC id FROMM customers"`, { cwd: sb.dir }) as unknown as HookPayload, { ...env, ...onlyGate(NAME) });
    assert.deepEqual(v.kind, 'ask');
    assert.match((v as { reason: string }).reason, /SQL не разобран/);
  });
});
describe('data-boundary — H20: a secret by key name password|token|authorization; login passes', () => {
  for (const p of H20) it(title(p), () => verdict(p));
});

describe('data-boundary — adversarial review of the spec (spec-critic findings)', () => {
  for (const p of CRITIC) it(title(p), () => verdict(p));
});

describe('data-boundary — a secret file is known by the gate config, its value is read, its shape is not', () => {
  for (const p of SECRET_FILES) it(title(p), () => verdict(p));
  it('denies a read of every configured secret file and lets every one of them through the prefilter — a config entry without a trigger is dead', async () => {
    const samples = [...SECRET_BASENAMES.map((b) => `x/${b}`), ...SECRET_EXTENSIONS.map((e) => `x/release.${e}`), ...SECRET_REPO_PATHS];
    for (const f of samples) {
      for (const cmd of [`cat ${f}`, `git show HEAD:${f}`]) {
        assert.ok(PRE_BASH_REGEX.test(JSON.stringify(bashPayload(cmd))), `prefilter: ${cmd}`);
        await verdict(D(f, cmd, /секрет в вывод/));
      }
    }
  });
});

describe('data-boundary — reachability through the shim prefilter', () => {
  it('matches PRE_BASH_REGEX on the JSON payload for every deny and unknown probe — a rule without a trigger is dead in a live session', () => {
    const missed = ALL.filter((p) => p.expect !== 'silent').map((p) => p.cmd).filter((c) => !PRE_BASH_REGEX.test(JSON.stringify(bashPayload(c))));
    assert.deepEqual(missed, []);
  });
  it('keeps plain commands below the prefilter — every false trigger costs a Node start', () => {
    const plain = ['ls -la', 'git status --porcelain', 'grep -n foo src/a.ts', 'node --test', 'npm run lint', 'cat README.md', 'kubectl get pods -n shop', 'kubectl logs pod-x', 'cp a b', 'node -e "console.log(process.env.HOME)"', 'cat .envrc', 'echo $HOME'];
    assert.deepEqual(plain.filter((c) => PRE_BASH_REGEX.test(JSON.stringify(bashPayload(c)))), []);
  });
  it('grep -E in the shim and RegExp in the router agree on every probe payload', () => {
    const re = readFileSync(join(HARNESS_ROOT, 'bin', 'prefilter.regex'), 'utf8').trim();
    const disagree = ALL.map((p) => JSON.stringify(bashPayload(p.cmd))).filter((json) => (spawnSync('grep', ['-qE', re], { input: json }).status === 0) !== PRE_BASH_REGEX.test(json));
    assert.deepEqual(disagree, []);
  });
});
