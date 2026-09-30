// data-answers — анкета границ данных с ФИКСИРОВАННЫМИ ответами. Порт scripts/data-answers.sh (22f586e, не влит).
// Ответы «чувствительны ли данные» и «раскрывают ли человека» — свойство КЛАССА (контур × вид данных), а не
// суждение модели в моменте: таблица ниже отвечает одинаково для любой модели.
//   ~/.claude/harness/bin/run scripts/data-answers.ts --env prod|dev|stand|local --kind config|aggregate|rows|pii|credential|dump
//                                        [--dest transcript|file|external] [--rows N]
//   ~/.claude/harness/bin/run scripts/data-answers.ts --classify "<команда или описание операции>"
// Выход: анкета и строка `ВЕРДИКТ: ALLOW|ANONYMIZE|SYNTHESIZE|DENY — <почему>`.
// Код: 0 ALLOW · 1 ANONYMIZE|SYNTHESIZE · 2 DENY · 64 ошибка вызова.
// --classify намеренно груб (подстроки текста): неуверенность уходит в более строгий класс. Блокирует не он,
// а гейт data-boundary по разбору команды; анкета отвечает на вопрос «что делать с вердиктом».
// Гейт здесь не регистрируется и процессы не запускаются: CLI только под сторожем isMain.
import { isMainModule } from '../src/is-main.ts';

export type Env = 'prod' | 'dev' | 'stand' | 'local';
export type Kind = 'config' | 'aggregate' | 'rows' | 'pii' | 'credential' | 'dump';
export type Dest = 'transcript' | 'file' | 'external';
export type AnswerVerdict = 'ALLOW' | 'ANONYMIZE' | 'SYNTHESIZE' | 'DENY';
export interface Query { env: Env; kind: Kind; dest: Dest; rows: number | null }
export interface Answers extends Query { sensitive: boolean; person: boolean; bulk: boolean; verdict: AnswerVerdict; why: string }
export interface Outcome { rc: number; stdout: string; stderr: string }

export const EXIT: Readonly<Record<AnswerVerdict, number>> = { ALLOW: 0, ANONYMIZE: 1, SYNTHESIZE: 1, DENY: 2 };
export const USAGE_RC = 64;
/** Граница, после которой ответ на вопрос уже не читают глазами: выборка стала срезом. */
export const ROWS_THRESHOLD = 1000;

const ENVS: ReadonlySet<string> = new Set(['prod', 'dev', 'stand', 'local']);
const KINDS: ReadonlySet<string> = new Set(['config', 'aggregate', 'rows', 'pii', 'credential', 'dump']);
const DESTS: ReadonlySet<string> = new Set(['transcript', 'file', 'external']);

export const USAGE = [
  'data-answers — анкета границ данных с фиксированными ответами',
  '  ~/.claude/harness/bin/run scripts/data-answers.ts --env prod|dev|stand|local --kind config|aggregate|rows|pii|credential|dump \\',
  '                                       [--dest transcript|file|external] [--rows N]',
  '  ~/.claude/harness/bin/run scripts/data-answers.ts --classify "<команда или описание операции>"',
  'Код: 0 ALLOW · 1 ANONYMIZE|SYNTHESIZE · 2 DENY · 64 ошибка вызова',
  '',
].join('\n');

// ───────────────────────────── --classify ─────────────────────────────

// Порядок строк = приоритет. «prod» покрывает pg-prod, mcp-pg-prod, prod_host.
const ENV_RULES: ReadonlyArray<readonly [Env, readonly string[]]> = [
  ['prod', ['prod']],
  ['dev', ['rancher', 'pg-dev', 'pg_dev']],
  ['local', ['kind-', 'localhost', '127.0.0.1', 'lms-local', 'stage-local', 'docker']],
];
const KIND_RULES: ReadonlyArray<readonly [Kind, readonly string[]]> = [
  ['dump', ['pg_dump', 'pg_restore', 'mysqldump', 'mongoexport', '\\copy', 'kubectl cp', 'docker cp']],
  ['credential', ['pgpass', 'npmrc', '_authtoken', 'password', 'secret', 'token', 'keystore', 'credential', 'keychain']],
  ['pii', ['customer', 'recipient', 'phone', 'email', 'address', 'passport', 'courier', 'users', 'client']],
  ['aggregate', ['count(', 'explain', 'pg_stat', 'group by']],
  ['config', ['pg_catalog', 'information_schema', 'get deploy', 'get cm', 'configmap', 'get pods']],
  ['rows', ['select', 'from ']],
];

/** `copy … to …` — SQL-выгрузка; в черновике это glob `*"copy "*" to "*`. */
function copyTo(t: string): boolean {
  const at = t.indexOf('copy ');
  return at >= 0 && t.indexOf(' to ', at + 'copy '.length - 1) >= 0;
}

export function classify(text: string): { env: Env; kind: Kind; rows: number | null } {
  const t = text.toLowerCase();
  const env = ENV_RULES.find(([, needles]) => needles.some((n) => t.includes(n)))?.[0] ?? 'dev';
  const kind = copyTo(t) ? 'dump' : KIND_RULES.find(([, needles]) => needles.some((n) => t.includes(n)))?.[0] ?? 'rows';
  // LIMIT в тексте — заявленный объём: без него анкета отвечала мягче гейта на ту же команду (ANONYMIZE против deny).
  const limits = [...t.matchAll(/\blimit\s+(\d+)/g)].map((m) => Number(m[1]));
  return { env, kind, rows: limits.length ? Math.max(...limits) : null };
}

// ───────────────────────────── ответы ─────────────────────────────

type Base = readonly [sensitive: boolean, person: boolean, verdict: AnswerVerdict, why: string];

function base(env: Env, kind: Kind): Base {
  if (kind === 'credential') return [true, false, 'DENY', 'секрет никогда не уходит в транскрипт, файл репозитория или отчёт'];
  if (kind === 'dump') {
    return env === 'prod' || env === 'dev'
      ? [true, true, 'DENY', 'выгрузка среза среды — это выкачка независимо от намерения']
      : [false, false, 'ALLOW', 'дамп локального стенда безопасен: данные там наши синтетические'];
  }
  if (env === 'prod') {
    if (kind === 'rows' || kind === 'pii') return [true, true, 'DENY', 'прод-строки не читаем никогда; на проде доступна только конфигурация по слоям'];
    if (kind === 'config') return [false, false, 'ALLOW', 'конфигурация прода — можно, одним запросом-снимком, без строк бизнес-таблиц'];
    return [false, false, 'ALLOW', 'счётчики и планы — можно; как только в выборке появляется строка, класс меняется на rows'];
  }
  if (env === 'dev') {
    if (kind === 'pii') return [true, true, 'ANONYMIZE', 'персональные поля дев-среды не покидают среду неанонимизированными'];
    if (kind === 'rows') return [true, true, 'ANONYMIZE', 'дев-строки годны для автотестов внутри среды; наружу — только обезличенная форма'];
    return [false, false, 'ALLOW', 'конфигурация и агрегаты дев-среды — рабочий материал'];
  }
  if (kind === 'pii') return [false, false, 'SYNTHESIZE', 'персональные поля на стенде обязаны быть сгенерированными, а не скопированными'];
  return [false, false, 'ALLOW', 'локальный контур: данные наши, ограничений нет'];
}

export function answer(q: Query): Answers {
  let [sensitive, person, verdict, why] = base(q.env, q.kind);
  let bulk = q.kind === 'dump';
  if (q.rows !== null && q.rows > ROWS_THRESHOLD) {
    bulk = true;
    if (q.env === 'prod' || q.env === 'dev') { verdict = 'DENY'; why = `объём выборки выглядит как выкачка: ${q.rows} строк из среды ${q.env}`; }
  }
  if (q.dest === 'external' && verdict === 'ALLOW' && q.kind !== 'config') { verdict = 'ANONYMIZE'; why = 'наружу уходит только обезличенное'; }
  return { ...q, sensitive, person, bulk, verdict, why };
}

const yes = (b: boolean): string => (b ? 'да' : 'нет');

export function render(a: Answers): string {
  return [
    'Анкета границ данных (ответы фиксированы харнессом, не суждением модели)',
    `  контур:                                   ${a.env}`,
    `  вид данных:                               ${a.kind}`,
    `  1. Эти данные относятся к чувствительным? ${yes(a.sensitive)}`,
    `  2. Могут раскрыть информацию о человеке?  ${yes(a.person)}`,
    `  3. Это содержимое, а не конфигурация?     ${a.kind === 'config' ? 'нет — конфигурация' : 'да'}`,
    `  4. Объём похож на выкачку?                ${yes(a.bulk)}${a.rows !== null ? ` (строк: ${a.rows})` : ''}`,
    `  5. Затрагивает секреты, пароли, сессии?   ${yes(a.kind === 'credential')}`,
    `  6. Куда попадёт результат?                ${a.dest}`,
    '  7. Чем заменить, если нужны наполнители?  генерируем сами; форму берём с тестовых сред, значения — синтетические',
    '',
    `ВЕРДИКТ: ${a.verdict} — ${a.why}`,
    '',
  ].join('\n');
}

// ───────────────────────────── CLI ─────────────────────────────

const VALUE_FLAGS: ReadonlySet<string> = new Set(['--env', '--kind', '--dest', '--rows', '--classify']);

/** Разбор аргументов в запрос. Флаг без значения и нечисловой --rows — ошибка вызова, а не молчаливый дефолт. */
export function parse(argv: readonly string[]): { help: true } | { query: Query } | { error: string } {
  const v = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '-h' || t === '--help') return { help: true };
    if (!VALUE_FLAGS.has(t)) return { error: `неизвестный аргумент: ${t}` };
    const value = argv[i + 1];
    if (value === undefined) return { error: `${t} требует значение` };
    v.set(t, value); i++;
  }
  const guess = v.has('--classify') ? classify(v.get('--classify') ?? '') : null;
  const env = v.get('--env') ?? guess?.env;
  const kind = v.get('--kind') ?? guess?.kind;
  const dest = v.get('--dest') ?? 'transcript';
  const rawRows = v.get('--rows');
  if (!env || !ENVS.has(env)) return { error: 'нужен --env prod|dev|stand|local' };
  if (!kind || !KINDS.has(kind)) return { error: 'нужен --kind config|aggregate|rows|pii|credential|dump' };
  if (!DESTS.has(dest)) return { error: 'нужен --dest transcript|file|external' };
  if (rawRows !== undefined && !/^\d+$/.test(rawRows)) return { error: `--rows ждёт целое число строк, получено «${rawRows}»` };
  const rows = rawRows !== undefined ? Number(rawRows) : guess?.rows ?? null;
  return { query: { env: env as Env, kind: kind as Kind, dest: dest as Dest, rows } };
}

export function run(argv: readonly string[]): Outcome {
  const p = parse(argv);
  if ('help' in p) return { rc: 0, stdout: USAGE, stderr: '' };
  if ('error' in p) return { rc: USAGE_RC, stdout: '', stderr: `data-answers: ${p.error}\n${USAGE}` };
  const a = answer(p.query);
  return { rc: EXIT[a.verdict], stdout: render(a), stderr: '' };
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  const out = run(process.argv.slice(2));
  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  process.exit(out.rc);
}
