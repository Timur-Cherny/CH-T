// data-boundary — граница данных на pre-bash (H20; нота data-boundaries-anchor). Порт hooks/data-boundary-guard.sh
// из 22f586e на разбор команды и AST: черновик сопоставлял текст и имел два обхода — исключение по подстроке и
// слово-агрегат в любом месте команды. Классы: прод-строки и выкачка (правила SQL — data-boundary-sql.ts);
// секрет в вывод — файл учётных данных, keychain, значения k8s-секрета, ключ password|token|authorization.
// Вердикт — из стадий (argv без редиректов, тела here-doc, $(…), sh -c, `\!` psql, kubectl exec --) и узлов AST;
// исключение потребителя действует только на поток своей стадии; недоказуемое — unknown, не silent.
// Regex — только над строками без грамматики: имя файла, имя ключа, флаг, значение хоста, строка kubeconfig.
import { readFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { register } from './registry.ts';
import { buildModel, kubeParse, kflag, ASSIGN, WRAPPER_NAMES } from '../parsers/stages.ts';
import { loadConfig } from '../config.ts';
import type { Kube, Model as ModelOf, Stage as StageOf } from '../parsers/stages.ts';
import { PSQL_LIKE, psqlSources, conninfoValue } from '../parsers/psql.ts';
import { worst } from './judgement.ts';
import { GLOBAL_WITH_VALUE } from './git-argv.ts';
import { SECRET_BASENAMES, SECRET_EXTENSIONS, SECRET_REPO_PATHS, SECRET_KEY_SUFFIXES } from './secret-files.ts';
import type { Judgement } from './judgement.ts';
import { CLEAN, deny, unknown, judgeSqlText } from './data-boundary-sql.ts';
import type { Mode } from './data-boundary-sql.ts';
import type { GateContext, PreToolUsePayload, Verdict } from '../types.ts';

export const NAME = 'data-boundary';
export const KILL = 'CLAUDE_SKIP_DATA_BOUNDARY';

export const HINT = [
  'Граница данных: прод — конфигурация и агрегаты; срез непокального контура не выгружаем; секрет не печатаем.',
  '  • факт с прода → агрегат или снимок одним jsonb_build_object по конфигурации',
  '  • объём → посчитать в базе; наполнители → сгенерировать по форме с тестовой среды',
  '  • секрет → наличие через test -s, k8s-секрет по именам ключей, значение сразу в kubectl create secret --from-literal=<ключ>=',
  `Анкета: node harness/scripts/data-answers.ts --classify "<операция>" · скилл data-boundaries · Kill-switch: ${KILL}=1`,
].join('\n');

type Contour = { kind: 'local' | 'prod' | 'dev' | 'remote' | 'unknown'; why: string };
type Stage = StageOf<Contour>;
type Model = ModelOf<Contour>;
interface Producer { what: string; fileCounts: boolean; stderr?: boolean; env?: boolean }

const CLIENTS: Readonly<Record<string, Mode>> = { 'prodq.mjs': 'prod', 'devq.mjs': 'dev' };
const DUMP_TOOLS: ReadonlySet<string> = new Set(['pg_dump', 'pg_dumpall', 'mysqldump', 'mongoexport', 'mongodump']);
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '']);
const PROD_VAR = /\$\{?[A-Za-z_]*PROD[A-Za-z0-9_]*\}?/i;
// Every prod read channel: WMS, connector and Django wrappers (the latter two were invisible until 23.09).
const PROD_WRAPPER = /mcp-pg-(?:[a-z]+-)?prod/;
const DEV_MARK = /(^|[-_.@])dev([-_.:]|$)|market-dev/i;
const URL_FAIL = '\0url';
const CAT_LIKE: ReadonlySet<string> = new Set(['cat', 'less', 'more', 'head', 'tail', 'bat', 'tac', 'nl', 'strings', 'xxd', 'od', 'hexdump', 'base64', 'sort', 'uniq', 'cut', 'column', 'fold', 'rev']);
const GREP_LIKE: ReadonlySet<string> = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'zgrep']);
const PROGRAM_FIRST: ReadonlySet<string> = new Set(['awk', 'gawk', 'sed', 'jq', 'yq']);
const PRINTERS: ReadonlySet<string> = new Set(['echo', 'printf', 'print']);
/** Команды, которые путь к файлу учётных данных не печатают и содержимое не выносят. */
const NON_PRINTING: ReadonlySet<string> = new Set(['test', '[', '[[', 'ls', 'stat', 'chmod', 'chown', 'rm', 'touch', 'source', '.', 'wc', 'md5', 'md5sum', 'sha1sum', 'sha256sum', 'file', 'realpath', 'dirname', 'basename', 'readlink', 'echo', 'printf', 'cp', 'mv', 'ln', 'export', 'unset', 'mkdir', 'find']);
const RUNTIME: ReadonlySet<string> = new Set(['env', 'printenv', 'set', 'kubectl', 'docker', 'curl', 'wget', 'http', 'xh', 'security', 'aws', 'gcloud', 'vault', 'gh']);
const HASHERS: ReadonlySet<string> = new Set(['md5', 'md5sum', 'sha1sum', 'sha256sum', 'sha512sum']);
const CRED: ReadonlySet<string> = new Set(SECRET_BASENAMES);
const CRED_EXT = new RegExp(`\\.(${SECRET_EXTENSIONS.join('|')})$`);
const ENV_TEMPLATES: ReadonlySet<string> = new Set(['example', 'sample', 'template', 'dist']);
/** git verbs that print no blob content, whatever paths they name. */
const GIT_QUIET: ReadonlySet<string> = new Set(['add', 'rm', 'mv', 'ls-files', 'ls-tree', 'status', 'checkout', 'switch', 'restore', 'reset', 'commit', 'update-index', 'check-ignore', 'check-attr', 'hash-object']);
const GIT_PATCH = /^(-p|-u|--patch(-with-stat|-with-raw)?|-L.*|--cc|-c|--word-diff.*|--full-diff|--binary)$/;
const GIT_SUMMARY = /^(--stat.*|--name-only|--name-status|--numstat|--shortstat|--dirstat.*|--summary|--raw|-s|--no-patch|--quiet)$/;
/** jq/yq builtins that reduce a value to its shape; any other function may print or throw with the value. */
const JQ_SHAPE: ReadonlySet<string> = new Set(['keys', 'keys_unsorted', 'length', 'type', 'map']);

// ───────────────────────────── контур ─────────────────────────────

const RANK: Record<Contour['kind'], number> = { local: 0, dev: 1, remote: 2, unknown: 3, prod: 4 };
const worstContour = (a: Contour, b: Contour): Contour => (RANK[b.kind] > RANK[a.kind] ? b : a);

function hostContour(value: string, env: NodeJS.ProcessEnv): Contour {
  if (value === URL_FAIL) return { kind: 'unknown', why: 'строка подключения не разобрана как URL' };
  const v = value.replace(/^["']|["']$/g, '');
  const prodHost = (env.PG_PROD_HOST ?? '').toLowerCase();
  if (PROD_VAR.test(v) || /pg[-_]prod/i.test(v) || (prodHost && v.toLowerCase().includes(prodHost))) return { kind: 'prod', why: `хост ${v}` };
  if (v.includes('$')) return { kind: 'unknown', why: `хост задан переменной ${v} — локальность не доказана` };
  const hosts = v.split(',').map((h) => h.replace(/:\d+$/, '').toLowerCase());
  if (hosts.every((h) => LOCAL_HOSTS.has(h) || h.startsWith('/'))) return { kind: 'local', why: `хост ${v}` };
  return { kind: hosts.every((h) => DEV_MARK.test(h)) ? 'dev' : 'remote', why: `хост ${v}` };
}

function urlHost(u: string): string {
  if (u.includes('$')) return u;
  try { return new URL(u).hostname; } catch { return URL_FAIL; }
}

function hostValues(rest: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === '-h' || t === '--host') { if (rest[i + 1] !== undefined) out.push(rest[++i]); continue; }
    if (t.startsWith('--host=')) { out.push(t.slice('--host='.length)); continue; }
    if (/^-h./.test(t)) { out.push(t.slice(2)); continue; }
    if (t.startsWith('--uri=')) { out.push(urlHost(t.slice('--uri='.length))); continue; }
    if (/^[a-z+]+:\/\//i.test(t)) { out.push(urlHost(t)); continue; }
    if (/(^|\s)host(addr)?=/.test(t)) { const h = conninfoValue(t, 'host') ?? conninfoValue(t, 'hostaddr'); if (h !== null) out.push(h); }
  }
  return out;
}

function urlNames(u: string): string[] {
  if (u.includes('$')) return [];
  try { const p = new URL(u); return [decodeURIComponent(p.pathname.replace(/^\//, '')), decodeURIComponent(p.username)]; } catch { return []; }
}

const VALUE_FLAGS: ReadonlySet<string> = new Set(['-c', '--command', '-f', '--file', '-v', '--set', '--variable', '-o', '--output']);

/** Имена базы и пользователя из -d/-U, --dbname=/--username=, URL и conninfo — носители суффикса контура. */
function nameValues(rest: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (VALUE_FLAGS.has(t)) { i++; continue; }
    if (/^--(?:command|file|set|variable|output)=/.test(t)) continue;
    if (t === '-d' || t === '--dbname' || t === '-U' || t === '--username') { if (rest[i + 1] !== undefined) out.push(...nameToken(rest[++i])); continue; }
    const long = /^--(?:dbname|username)=(.*)$/s.exec(t);
    if (long) { out.push(...nameToken(long[1])); continue; }
    if (/^-[dU]./.test(t)) { out.push(...nameToken(t.slice(2))); continue; }
    if (t.startsWith('--uri=')) { out.push(...urlNames(t.slice('--uri='.length))); continue; }
    out.push(...nameToken(t, false));
  }
  return out;
}

function nameToken(t: string, plain = true): string[] {
  if (/^[a-z+]+:\/\//i.test(t)) return urlNames(t);
  if (/(^|\s)(dbname|user)=/.test(t)) return [conninfoValue(t, 'dbname'), conninfoValue(t, 'user')].filter((v): v is string => v !== null);
  return plain ? [t] : [];
}

// Owner decision 24.09: the suffix of the database or user name is the contour. It settles only a host without a label;
// _prod can only make a contour stricter, and _local never loosens a remote host — its SQL stays under the rules.
function nameContour(host: Contour, names: string[]): Contour {
  const marks = names.map((n) => /_(dev|prod|local)$/i.exec(n.replace(/^["']|["']$/g, ''))?.[1]?.toLowerCase()).filter(Boolean);
  if (marks.includes('prod')) return worstContour(host, { kind: 'prod', why: `${host.why}, имя с суффиксом _prod` });
  if (marks.includes('dev') && host.kind === 'remote') return { kind: 'dev', why: `${host.why}, имя с суффиксом _dev` };
  return host;
}

function pgContour(st: Stage, model: Model, env: NodeJS.ProcessEnv): Contour {
  if (st.kube) return st.kube;
  const marker = st.argv.map((t) => PROD_VAR.exec(t)?.[0]).find(Boolean);
  if (marker) return { kind: 'prod', why: `переменная ${marker}` };
  let hosts = hostValues(st.rest);
  if (!hosts.length && st.name.startsWith('pg')) hosts = model.assigns.get('PGHOST') ?? (env.PGHOST ? [env.PGHOST] : []);
  const host: Contour = hosts.length ? hosts.map((h) => hostContour(h, env)).reduce(worstContour) : { kind: 'local', why: 'хост не задан — локальный сокет' };
  let names = nameValues(st.rest);
  if (!names.length) names = [...(model.assigns.get('PGDATABASE') ?? []), ...(model.assigns.get('PGUSER') ?? [])];
  return nameContour(host, names);
}


function currentContext(paths: string, cwd: string, env: NodeJS.ProcessEnv): string | null {
  for (const p of paths.split(':').filter(Boolean)) {
    let text: string;
    try { text = readFileSync(resolve(cwd, p.replace(/^~(?=\/)/, env.HOME ?? '~')), 'utf8'); } catch { continue; }
    const m = /^current-context:\s*["']?([^"'\s]+)["']?\s*$/m.exec(text);
    if (m) return m[1];
  }
  return null;
}

function kubeContour(k: Kube, model: Model, cwd: string, env: NodeJS.ProcessEnv): Contour {
  const ns = kflag(k, '-n', '--namespace');
  let name = kflag(k, '--context');
  let why = `kube-контекст ${name}`;
  if (name === null) {
    const paths = kflag(k, '--kubeconfig') ?? model.assigns.get('KUBECONFIG')?.at(-1) ?? env.KUBECONFIG ?? (env.HOME ? `${env.HOME}/.kube/config` : '');
    name = currentContext(paths, cwd, env);
    why = name ? `current-context ${name}` : 'kube-контекст не доказан: нет --context и current-context';
  }
  if ((name && /prod/i.test(name)) || (ns && /prod/i.test(ns))) return { kind: 'prod', why: name ? why : `namespace ${ns}` };
  if (!name) return { kind: 'remote', why };
  if (name.includes('$')) return { kind: 'unknown', why: `kube-контекст задан переменной ${name}` };
  if (name.startsWith('kind-') || name === 'docker-desktop' || name === 'colima' || name.startsWith('colima-')) return { kind: 'local', why };
  return { kind: DEV_MARK.test(name) ? 'dev' : 'remote', why };
}

// ───────────────────────────── SQL-стадии ─────────────────────────────

function withContour(j: Judgement, c: Contour): Judgement {
  if (j.kind === 'clean') return j;
  if (c.kind === 'unknown' && j.kind === 'deny') return unknown(`${c.why}; в непокальном контуре это ${j.reason}`);
  return { ...j, reason: `${j.reason} (${c.why})` };
}
const modeOf = (c: Contour): Mode => (c.kind === 'prod' ? 'prod' : c.kind === 'dev' ? 'dev' : 'remote');

async function judgeSqlStage(st: Stage, i: number, contour: Contour, cwd: string, tables: ReadonlySet<string>): Promise<Judgement> {
  const mode = modeOf(contour);
  let out = CLEAN;
  const judge = async (text: string): Promise<void> => { out = worst(out, await judgeSqlText(text, mode, tables)); };
  const sources = psqlSources(st.rest);
  if (st.stdin) sources.push({ kind: 'file', path: st.stdin });
  for (const body of st.heredocs) await judge(body);
  if (!sources.length && !st.heredocs.length && i > 0) out = worst(out, unknown('SQL приходит на stdin из другой команды — тело недоступно'));
  for (const src of sources) {
    if (src.kind === 'stdin') { if (!st.heredocs.length) out = worst(out, unknown('psql -f - читает stdin — тело недоступно')); continue; }
    if (src.kind === 'inline') { if (/\$\(|`/.test(src.sql)) out = worst(out, unknown('тело SQL приходит подстановкой $(…) — недоступно')); else await judge(src.sql); continue; }
    let text: string;
    try { text = readFileSync(resolve(cwd, src.path), 'utf8'); } catch { out = worst(out, unknown(`файл SQL не прочитан: ${basename(src.path)}`)); continue; }
    await judge(text);
  }
  return withContour(out, contour);
}

async function judgeClient(st: Stage, model: Model, cwd: string, tables: ReadonlySet<string>): Promise<Judgement | null> {
  if (st.name !== 'node') return null;
  const at = st.rest.findIndex((t) => !t.startsWith('-'));
  const mode = at >= 0 ? CLIENTS[basename(st.rest[at])] : undefined;
  if (!mode) return null;
  const script = basename(st.rest[at]);
  const file = mode === 'prod' ? st.rest[at + 1] : undefined;
  let text = st.argv.map((t) => ASSIGN.exec(t)).find((m) => m?.[1] === 'SQL')?.[2] ?? model.assigns.get('SQL')?.at(-1);
  if (file !== undefined) {
    try { text = readFileSync(resolve(cwd, file), 'utf8'); } catch { return unknown(`файл SQL не прочитан: ${basename(file)}`); }
  }
  if (text === undefined) return unknown(`SQL для ${script} не виден в команде`);
  if (/\$\(|`/.test(text)) return unknown('тело SQL приходит подстановкой $(…) — недоступно');
  return withContour(await judgeSqlText(text, mode, tables), { kind: mode, why: `клиент ${script}` });
}

/** SQL-литералы в стадии, упоминающей прод-обёртку: ключевое слово сразу после кавычки или весь токен. */
async function judgeWrapperLiterals(st: Stage, tables: ReadonlySet<string>): Promise<Judgement> {
  const texts = [...st.rest, ...st.heredocs];
  if (!texts.some((t) => PROD_WRAPPER.test(t))) return CLEAN;
  let out = CLEAN;
  for (const text of texts) {
    const candidates: string[] = [];
    if (/^\s*(select|with|table|copy)\b/i.test(text)) candidates.push(text);
    else {
      for (const m of text.matchAll(/(['"`])\s*(?:select|with|table|copy)\b/gi)) {
        const q = m[1];
        let j = (m.index ?? 0) + 1;
        let buf = '';
        while (j < text.length && text[j] !== q) { if (text[j] === '\\' && j + 1 < text.length) { buf += text[j + 1]; j += 2; continue; } buf += text[j]; j++; }
        candidates.push(buf);
      }
    }
    for (const c of candidates) out = worst(out, await judgeSqlText(c, 'prod', tables));
  }
  return withContour(out, { kind: 'prod', why: 'SQL-литерал рядом с mcp-pg-prod' });
}

function judgeDump(st: Stage, model: Model, env: NodeJS.ProcessEnv): Judgement {
  if (st.name === 'pg_dump' && st.rest.some((t) => t === '-s' || t === '--schema-only')) return CLEAN;
  const hosts = hostValues(st.rest);
  const c = st.kube ?? (st.name.startsWith('pg_') ? pgContour(st, model, env) : hosts.length ? hosts.map((h) => hostContour(h, env)).reduce(worstContour) : { kind: 'local' as const, why: '' });
  if (c.kind === 'local') return CLEAN;
  if (c.kind === 'unknown') return unknown(`${st.name}: ${c.why}`);
  return deny(`выкачка: ${st.name} из непокального контура (${c.why})`);
}

function judgeKubectlCp(st: Stage, model: Model, cwd: string, env: NodeJS.ProcessEnv): Judgement | null {
  const k = kubeParse(st.rest);
  if (k.sub !== 'cp') return null;
  const c = kubeContour(k, model, cwd, env);
  if (c.kind === 'local') return CLEAN;
  const [src, dst] = k.positionals.slice(1);
  const pod = (p?: string): boolean => !!p && p.includes(':') && !/^(\.{0,2}\/|~)/.test(p);
  if (pod(dst) && !pod(src)) return CLEAN;
  if (!pod(src) || pod(dst)) return unknown('kubectl cp без направления: ровно один путь должен быть pod:…');
  return c.kind === 'unknown' ? unknown(`kubectl cp из пода: ${c.why}`) : deny(`выкачка: kubectl cp из пода в непокальном контуре (${c.why})`);
}

// ───────────────────────────── секреты ─────────────────────────────

export function secretKey(name: string): boolean {
  const n = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SECRET_KEY_SUFFIXES.some((s) => n.endsWith(s));
}
const words = (text: string): string[] => text.match(/[A-Za-z_][A-Za-z0-9_-]*/g) ?? [];

function secretFile(path: string): string | null {
  const p = path.replace(/^\.\//, '');
  const b = basename(p);
  if (CRED.has(b) || CRED_EXT.test(b)) return b;
  const repo = SECRET_REPO_PATHS.find((r) => p === r || p.endsWith(`/${r}`));
  if (repo) return repo;
  const m = /^\.env(?:\.([A-Za-z0-9_-]+))?$/.exec(b);
  return m && !(m[1] && ENV_TEMPLATES.has(m[1])) ? b : null;
}

/** A path as a file or as a git object `<ref>:<path>` (a ref has no colon); scp `host:path` reads the same way. */
export function credName(token: string): string | null {
  const t = token.replace(/["']/g, '');
  const colon = t.indexOf(':');
  return secretFile(t) ?? (colon >= 0 && !t.includes('://') ? secretFile(t.slice(colon + 1)) : null);
}

function grepParts(st: Stage): { patternIdx: number; pattern: string; files: string[]; countOnly: boolean; invert: boolean } {
  const explicit: string[] = [];
  const pos: number[] = [];
  let countOnly = false;
  let invert = false;
  for (let i = 0; i < st.rest.length; i++) {
    const t = st.rest[i];
    if (t === '-e' || t === '--regexp') { explicit.push(st.rest[++i] ?? ''); continue; }
    if (t.startsWith('--regexp=')) { explicit.push(t.slice('--regexp='.length)); continue; }
    if (t === '-f' || t === '--file' || /^-[ABCmdDgtTjM]$/.test(t) || /^--(max-count|context|after-context|before-context|glob|type)$/.test(t)) { i++; continue; }
    if (/^--(count|files-with-matches|files-without-match|quiet|silent)$/.test(t)) { countOnly = true; continue; }
    if (t === '--invert-match') { invert = true; continue; }
    if (t.startsWith('--')) continue;
    if (/^-[A-Za-z0-9]+$/.test(t)) {
      const f = t.slice(1).replace(/[ABCm]\d*$/, '');
      if (/[clq]/.test(f) || (st.name !== 'rg' && f.includes('L'))) countOnly = true;
      if (f.includes('v')) invert = true;
      continue;
    }
    pos.push(i);
  }
  const patternIdx = explicit.length ? -1 : pos[0] ?? -1;
  const pattern = explicit.length ? explicit.join(' ') : st.rest[patternIdx] ?? '';
  return { patternIdx, pattern, files: pos.filter((p) => p !== patternIdx).map((p) => st.rest[p]), countOnly, invert };
}

function programParts(st: Stage): { programIdx: number; program: string } {
  const pos: number[] = [];
  const exprs: string[] = [];
  let fromFile = false;
  for (let i = 0; i < st.rest.length; i++) {
    const t = st.rest[i];
    if (/^--(arg|argjson|slurpfile|rawfile)$/.test(t)) { i += 2; continue; }
    if (t === '-f' || t === '--from-file') { fromFile = true; i++; continue; }
    if (st.name === 'sed' && (t === '-e' || t === '--expression')) { exprs.push(st.rest[++i] ?? ''); continue; }
    if (t === '-F' || t === '-v' || t === '--indent' || t === '-L') { i++; continue; }
    if (t.startsWith('-')) continue;
    pos.push(i);
  }
  if (fromFile || exprs.length) return { programIdx: -1, program: exprs.join('\n') };
  return { programIdx: pos[0] ?? -1, program: st.rest[pos[0]] ?? '' };
}

function credMentions(st: Stage): string[] {
  const skip = GREP_LIKE.has(st.name) ? grepParts(st).patternIdx : PROGRAM_FIRST.has(st.name) ? programParts(st).programIdx : -1;
  const out: string[] = [];
  st.rest.forEach((t, idx) => {
    if (idx === skip || st.rest[idx - 1] === '--env-file' || t.startsWith('--env-file=') || ASSIGN.test(t)) return;
    const direct = credName(t.startsWith('--') && t.includes('=') ? t.slice(t.indexOf('=') + 1) : t);
    if (direct) { out.push(direct); return; }
    for (const m of t.matchAll(/(['"])([^'"\s]+)\1/g)) { const n = credName(m[2]); if (n) out.push(n); }
  });
  const fromStdin = st.stdin ? credName(st.stdin) : null;
  if (fromStdin) out.push(fromStdin);
  return out;
}

/** Secret files whose content a git call prints: size, existence, staging and history without a patch print none. */
function gitReads(st: Stage): string[] {
  let at = 0;
  while (at < st.rest.length && st.rest[at].startsWith('-')) at += st.rest[at] === '-C' || GLOBAL_WITH_VALUE.has(st.rest[at]) ? 2 : 1;
  const verb = st.rest[at];
  if (verb === undefined) return [];
  const sub: Stage = { ...st, rest: st.rest.slice(at + 1) };
  const args = sub.rest;
  if (GIT_QUIET.has(verb)) return [];
  if (verb === 'cat-file' && args.some((t) => /^-[est]$/.test(t))) return [];
  if (verb === 'grep') { const g: Stage = { ...sub, name: 'grep' }; return grepParts(g).countOnly ? [] : credMentions(g); }
  if ((verb === 'log' || verb === 'whatchanged') && !args.some((t) => GIT_PATCH.test(t))) return [];
  const blob = args.some((t) => t.includes(':') && !t.startsWith('-') && credName(t) !== null);
  if ((verb === 'show' || verb === 'diff') && !blob && args.some((t) => GIT_SUMMARY.test(t))) return [];
  return credMentions(sub);
}

/** jq/yq whose output is only the shape of the input: field paths, pipes and shape builtins, ending in one of them. */
function shapeOnly(st: Stage): boolean {
  if (st.name !== 'jq' && st.name !== 'yq') return false;
  const p = programParts(st).program;
  if (!p || /[,$"'@?`\\]|\[[^\]0-9]/.test(p)) return false;
  for (const m of p.matchAll(/(\.?)([A-Za-z_][A-Za-z0-9_]*)/g)) if (m[1] ? secretKey(m[2]) : !JQ_SHAPE.has(m[2])) return false;
  const last = (p.split('|').at(-1) ?? '').trim().replace(/^map\((.*)\)$/, '$1').trim();
  return JQ_SHAPE.has(last) && last !== 'map';
}

function isConsumer(st: Stage): boolean {
  if (st.name === 'kubectl') {
    const k = kubeParse(st.rest);
    if (['apply', 'create', 'replace'].includes(k.sub) && kflag(k, '-f', '--filename') === '-') return true;
    if (k.sub === 'create' && k.positionals[1] === 'secret' && kflag(k, '-o', '--output') === null) return true;
  }
  return st.name === 'docker' && st.rest.includes('login') && st.rest.includes('--password-stdin');
}

function isReducer(st: Stage, pr: Producer): boolean {
  if (st.name === 'wc' || HASHERS.has(st.name)) return true;
  if (GREP_LIKE.has(st.name)) {
    const g = grepParts(st);
    if (g.countOnly) return true;
    // Фильтр окружения по шаблону сужает вывод; шаблон с именем секрета судит собственный проектор grep.
    return !!pr.env && !g.invert && words(g.pattern).length > 0;
  }
  if (st.name === 'jq' || st.name === 'yq') {
    const w = words(programParts(st).program);
    return w.some((x) => x === 'keys' || x === 'keys_unsorted' || x === 'length') && !w.some(secretKey);
  }
  return false;
}

const isBase64Decode = (st: Stage): boolean => st.name === 'base64' && st.rest.some((t) => t === '--decode' || /^-[A-Za-z]*[dD][A-Za-z]*$/.test(t));

/** Доходит ли значение до вывода: потребитель, редуктор и /dev/null — нет; tee, stderr и обычный файл — да. */
function reachesOutput(st: Stage, pipe: Stage[], i: number, pr: Producer): { printed: boolean; decoded: boolean } {
  const down = pipe.slice(i + 1);
  const decoded = down.some(isBase64Decode);
  if (pr.stderr || st.stdout === 'stderr') return { printed: true, decoded };
  if (st.stdout === 'null' || (st.stdout === 'file' && !pr.fileCounts)) return { printed: false, decoded };
  if (down.some((d) => isReducer(d, pr))) return { printed: false, decoded };
  const last = down.at(-1);
  if (last && isConsumer(last)) return { printed: false, decoded };
  if (last && (last.stdout === 'null' || (last.stdout === 'file' && !pr.fileCounts))) return { printed: false, decoded };
  if (st.stdout === 'file' || down.some((d) => d.name === 'tee' || d.stdout === 'stderr')) return { printed: true, decoded };
  const enc = st.enclosing;
  if (enc && !last) {
    const k = enc.stage.name === 'kubectl' ? kubeParse(enc.stage.rest) : null;
    const exempt = !!k && k.sub === 'create' && k.positionals[1] === 'secret' && /^--from-literal=[-._A-Za-z0-9]+=$/.test(enc.prefix);
    return { printed: !exempt, decoded };
  }
  if (enc && last) return reachesOutput(last, [last], 0, { ...pr, env: false });
  return { printed: true, decoded };
}

function producers(st: Stage, pipe: Stage[], i: number): Producer[] {
  const out: Producer[] = [];
  const nonPrinting = NON_PRINTING.has(st.name) && !(st.name === 'find' && st.rest.some((t) => /^-(exec|execdir|ok|okdir)$/.test(t)));
  if (!nonPrinting && !isConsumer(st) && !shapeOnly(st)) {
    const names = st.name === 'git' ? gitReads(st) : credMentions(st);
    if (names.length && !(GREP_LIKE.has(st.name) && grepParts(st).countOnly)) out.push({ what: `чтение ${names[0]}`, fileCounts: true });
  }
  if (st.viaXargs && !NON_PRINTING.has(st.name) && pipe.slice(0, i).some((u) => credMentions(u).length)) out.push({ what: 'имя файла учётных данных уходит в xargs', fileCounts: true });
  if (st.name === 'security' && /^find-(generic|internet)-password$/.test(st.rest[0] ?? '') && st.rest.some((t) => /^-[A-Za-z]*[wg][A-Za-z]*$/.test(t))) {
    out.push({ what: `значение из keychain (security ${st.rest[0]} -w)`, fileCounts: true });
  }
  if (st.name === 'kubectl') {
    const k = kubeParse(st.rest);
    const o = kflag(k, '-o', '--output');
    const secretRes = (k.positionals[1] ?? '').split(',').some((r) => /^secrets?(\/|$)/.test(r));
    if (k.sub === 'get' && secretRes && o !== null) {
      const [fmt, expr = ''] = o.split(/=(.*)/s);
      const w = words(expr);
      const values = fmt === 'yaml' || fmt === 'json' || fmt.startsWith('go-template') || fmt.startsWith('custom-columns') || fmt === 'template'
        || (fmt.startsWith('jsonpath') && (w.length === 0 || w.includes('data') || w.includes('stringData')));
      if (values) out.push({ what: `значения k8s-секрета (-o ${fmt})`, fileCounts: true });
    }
    if (k.sub === 'create' && k.positionals[1] === 'secret' && (o === 'yaml' || o === 'json')) out.push({ what: `значения k8s-секрета в манифесте (-o ${o})`, fileCounts: true });
  }
  if (PRINTERS.has(st.name)) {
    const text = st.rest.join(' ');
    const key = [...text.matchAll(/"([^"\\\n]{1,80})"\s*:/g)].map((m) => m[1]).find(secretKey);
    if (key) out.push({ what: `ключ «${key}» в печатаемом JSON`, fileCounts: false });
    const v = [...text.matchAll(/\$(?:\{(?!#))?([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]).find(secretKey);
    if (v) out.push({ what: `переменная ${v}`, fileCounts: true });
  }
  if (st.name === 'printenv' || st.name === 'env') {
    const names = st.rest.filter((t) => !t.startsWith('-'));
    const v = names.find(secretKey);
    if (v) out.push({ what: `переменная ${v}`, fileCounts: true });
    else if (!names.length) out.push({ what: `печать всего окружения (${st.name})`, fileCounts: true, env: true });
  }
  if (CAT_LIKE.has(st.name) && st.heredocs.length && !credMentions(st).length) {
    const key = st.heredocs.flatMap((h) => [...h.matchAll(/"([^"\\\n]{1,80})"\s*:/g)].map((m) => m[1])).find(secretKey);
    if (key) out.push({ what: `ключ «${key}» в печатаемом JSON`, fileCounts: false });
  }
  if (st.name === 'jq' || st.name === 'yq') {
    const key = words(programParts(st).program.replace(/del\((?:[^()]|\([^()]*\))*\)/g, '')).find(secretKey);
    if (key) out.push({ what: `проекция ключа «${key}» (${st.name})`, fileCounts: true });
  }
  if (GREP_LIKE.has(st.name)) {
    const g = grepParts(st);
    const key = words(g.pattern).find(secretKey);
    const dump = g.files.some((f) => f.endsWith('.har')) || pipe.slice(0, i).some((u) => RUNTIME.has(u.name));
    if (key && dump && !g.countOnly) out.push({ what: `проекция ключа «${key}» (${st.name})`, fileCounts: true });
  }
  if (st.name === 'curl' && st.rest.some((t) => /^--(verbose|trace|trace-ascii)$/.test(t) || /^-[A-Za-z]*v[A-Za-z]*$/.test(t))) {
    for (let k = 0; k < st.rest.length; k++) {
      const t = st.rest[k];
      const header = t === '-H' || t === '--header' ? st.rest[k + 1] ?? '' : t.startsWith('--header=') ? t.slice('--header='.length) : /^-H./.test(t) ? t.slice(2) : null;
      const hname = header?.split(':')[0].trim();
      if (hname && secretKey(hname)) { out.push({ what: `заголовок «${hname}» в curl -v`, fileCounts: true, stderr: true }); break; }
      if (t === '-u' || t === '--user' || t.startsWith('--user=')) { out.push({ what: 'заголовок «Authorization» (curl -v -u)', fileCounts: true, stderr: true }); break; }
    }
  }
  return out;
}

// ───────────────────────────── гейт ─────────────────────────────

const TAG_TEXT: Record<string, string> = {
  'here-doc': 'ограничитель here-doc не разобран', 'here-doc-unterminated': 'here-doc без ограничителя',
  'here-doc-expansion': 'в теле here-doc подстановка — итоговый текст неизвестен', 'here-doc-orphan': 'тело here-doc без команды',
  'here-string': 'here-string <<< — тело недоступно', 'unterminated-single-quote': 'незакрытая одинарная кавычка',
  'unterminated-double-quote': 'незакрытая двойная кавычка', 'nested-depth': 'вложенность оболочек глубже двух уровней',
};
const describeTags = (tags: string[]): string => [...new Set(tags)].map((t) => TAG_TEXT[t] ?? t).join('; ');

async function judgeStage(st: Stage, pipe: Stage[], i: number, model: Model, cwd: string, env: NodeJS.ProcessEnv, tables: ReadonlySet<string>): Promise<{ j: Judgement; relevant: boolean }> {
  let j = CLEAN;
  let relevant = false;
  const hit = (r: Judgement | null): void => { if (r) { j = worst(j, r); relevant = true; } };
  if (WRAPPER_NAMES.has(st.name)) hit(await judgeSqlStage(st, i, { kind: 'prod', why: 'обёртка mcp-pg-prod' }, cwd, tables));
  else if (PSQL_LIKE.has(st.name)) { const c = pgContour(st, model, env); if (c.kind !== 'local') hit(await judgeSqlStage(st, i, c, cwd, tables)); }
  else if (DUMP_TOOLS.has(st.name)) hit(judgeDump(st, model, env));
  else if (st.name === 'kubectl') hit(judgeKubectlCp(st, model, cwd, env));
  hit(await judgeClient(st, model, cwd, tables));
  if (!WRAPPER_NAMES.has(st.name)) { const r = await judgeWrapperLiterals(st, tables); if (r.kind !== 'clean') hit(r); }
  for (const pr of producers(st, pipe, i)) {
    relevant = true;
    const f = reachesOutput(st, pipe, i, pr);
    if (f.printed) j = worst(j, deny(`секрет в вывод: ${pr.what}${f.decoded ? ' с расшифровкой base64 -d' : ''}`));
  }
  return { j, relevant };
}

export async function judgeCommand(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<Judgement> {
  const model = buildModel<Contour>(command, (k, m) => kubeContour(k, m, cwd, env));
  const tables: ReadonlySet<string> = new Set(loadConfig(env).dataBoundary.configTables);
  let out = CLEAN;
  for (const pipe of model.pipelines) {
    for (let i = 0; i < pipe.length; i++) {
      const r = await judgeStage(pipe[i], pipe, i, model, cwd, env, tables);
      out = worst(out, r.relevant && pipe[i].tags.length ? worst(r.j, unknown(describeTags(pipe[i].tags))) : r.j);
    }
  }
  const own = model.tags.filter((t) => t !== 'parse-error');
  if (own.length) out = worst(out, unknown(describeTags(own)));
  return out;
}

const SILENT: Verdict = { kind: 'silent' };

export async function decide(ctx: GateContext): Promise<Verdict> {
  const p = ctx.payload as PreToolUsePayload;
  if (ctx.event !== 'pre-bash' || p.hook_event_name !== 'PreToolUse' || p.tool_name !== 'Bash') return SILENT;
  const cmd = typeof p.tool_input?.command === 'string' ? p.tool_input.command : '';
  if (!cmd.trim()) return SILENT;
  const j = await judgeCommand(cmd, p.cwd ?? '', ctx.env);
  if (j.kind === 'clean') return SILENT;
  if (j.kind === 'unknown') return { kind: 'unknown', reason: j.reason, gate: NAME };
  return { kind: 'deny', reason: `${j.reason}.\n${HINT}`, gate: NAME };
}

register({ name: NAME, events: ['pre-bash'], killSwitch: KILL, run: decide });
