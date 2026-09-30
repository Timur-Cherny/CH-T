// PreToolUse(Bash): actions only the owner decides — a release tag, a merge into or a direct write to a protected branch.
// A rule in notes alone broke three times (tags set and deleted, an MR merged into the protected line, a tag inside a
// release plan): the owner's actions are held by code.
// The gate is an allowlist, not a denylist: the refspec and glab languages are wider than any parser of forbidden
// forms (review 22.09 found 50+ silent forms of the first, denylist version). A push to a company-GitLab destination
// passes only when every refspec names an existing local, unprotected branch; a glab call passes only when it is a
// known subcommand that does not tag, release or write a protected branch, and a merge passes only when GitLab
// confirms a non-protected target. Anything the gate cannot prove — an unresolved directory, a state change earlier in
// the same command, arguments from xargs, a command word from a variable — is a deny, not an ask: a hook ask does not
// block in auto mode (anthropics/claude-code#89561) and is undocumented under bypass. The bypass
// CLAUDE_SKIP_OWNER_GATE=1 is read from the Claude Code process environment, never from the agent's command.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { register } from './registry.ts';
import { tokenize } from '../parsers/shell.ts';
import { segmentsWithCwd, parseGit, expandWord } from './git-argv.ts';
import { git } from '../git.ts';
import { spawnTool } from '../platform.ts';
import { loadConfig } from '../config.ts';
import type { ShellPathsConfig } from '../config.ts';
import type { Gate, GateContext, Verdict } from '../types.ts';

export const NAME = 'owner-actions';
const BYPASS = 'Выполняет владелец сам (свой терминал, веб-интерфейс git) либо запускает сессию с CLAUDE_SKIP_OWNER_GATE=1.';
const TAG_LIST_MODE = /^(-l|--list|-n\d*|--contains|--no-contains|--points-at|--merged|--no-merged|-v|--verify)(=.*)?$/;
const TAG_WRITE_FLAGS = new Set(['-d', '--delete', '-f', '--force', '-a', '--annotate', '-s', '--sign', '-u', '--local-user', '-m', '--message', '-F', '--file', '-e', '--edit']);
const PUSH_VALUE_OPTS = new Set(['-o', '--push-option', '--receive-pack', '--exec', '--repo']);
const PUSH_FORBIDDEN_FLAGS = new Set(['--all', '--branches', '--mirror', '--tags', '--follow-tags', '--prune']);
const GIT_STATE_VERBS = new Set(['checkout', 'switch', 'branch', 'config', 'remote', 'update-ref', 'symbolic-ref', 'worktree', 'clone', 'init']);
const GIT_GLOBAL_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path', '--super-prefix', '--attr-source']);
const BRANCH_PREFIX = /^(feature|fix|hotfix|release|chore|docs|refactor|perf|test|backup)\/[A-Za-z0-9._/-]+$/;
const VERSION_LIKE = /^v?\d+(\.\d+)+([-.][A-Za-z0-9.-]+)?$/;
const GLAB_KNOWN = new Set(['alias', 'api', 'attestation', 'auth', 'changelog', 'check-update', 'ci', 'cluster', 'completion', 'config', 'container-registry', 'deploy-key', 'duo', 'gpg-key', 'help', 'incident', 'issue', 'iteration', 'job', 'label', 'mcp', 'milestone', 'mr', 'opentofu', 'orbit', 'packages', 'release', 'repo', 'runner', 'runner-controller', 'schedule', 'search', 'securefile', 'security', 'skills', 'snippet', 'ssh-key', 'stack', 'todo', 'token', 'user', 'variable', 'version', 'whatsnew', 'work-items']);
const GLAB_GLOBAL_VALUE = new Set(['-R', '--repo', '--hostname']);
const API_VALUE_OPTS = new Set(['-X', '--method', '-f', '--raw-field', '-F', '--field', '-H', '--header', '--hostname', '--input', '--jq', '-R', '--repo', '--form', '--output', '--template', '-t', '--cache']);
const API_BODY_OPTS = new Set(['-f', '--raw-field', '-F', '--field', '--input', '--form']);
const API_MERGE = /(^|\/)merge_requests\/(\d+)\/merge\/?$/;
const API_OWNER_WRITE = /(^|\/)(repository\/(tags|commits|files|branches)|releases|protected_(branches|tags))(\/|$)/;
const HTTP_CLIENTS = new Set(['curl', 'wget', 'http', 'https', 'xh']);

type V = Verdict;
const deny = (lines: string[]): V => ({ kind: 'deny', gate: NAME, reason: [...lines, BYPASS].join('\n') });
const base = (w: string): string => w.split('/').pop() ?? w;
const lit = (w: string | undefined, env: NodeJS.ProcessEnv): string | null => (w === undefined || w.includes('$(') || w.includes('`') ? null : expandWord(w, env));

/** The owner's path variables are absent from the hook environment; the file their shell sources is the source of
 *  truth (shellPaths in the site config; names are plain shell names, checked by config.ts before they reach sh -c). */
export function withShellPaths(env: NodeJS.ProcessEnv, command: string, sp: ShellPathsConfig | undefined): NodeJS.ProcessEnv {
  if (!sp || !sp.vars.some((k) => command.includes(`$${k}`) || command.includes(`\${${k}`))) return env;
  if (sp.vars.every((k) => env[k])) return env;
  const file = env.HOME ? join(env.HOME, sp.file) : '';
  if (!file || !existsSync(file)) return env;
  const r = spawnTool('sh', ['-c', `. "$0" >/dev/null 2>&1; printf '%s\\n' ${sp.vars.map((k) => `"$${k}"`).join(' ')}`, file], { timeoutMs: 3000 });
  if (r.rc !== 0) return env;
  const vals = r.stdout.split('\n');
  const out = { ...env };
  sp.vars.forEach((k, i) => { if (!out[k] && vals[i]) out[k] = vals[i]; });
  return out;
}

function isCorporateUrl(url: string, hosts: string[]): boolean { return hosts.some((h) => url.includes(h)); }
/** true/false when git answered about the repository's remotes; null when it could not be asked (unknown is not «no»). */
function repoIsCorporate(cwd: string | null, hosts: string[]): boolean | null {
  if (cwd === null || !existsSync(cwd)) return null;
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (top.rc !== 0) return /not a git repository/i.test(top.stderr) ? false : null;
  const r = git(cwd, ['remote', '-v']);
  return r.rc === 0 ? isCorporateUrl(r.stdout, hosts) : null;
}
function refExists(cwd: string, ref: string): boolean { return git(cwd, ['rev-parse', '--verify', '--quiet', ref]).rc === 0; }
function currentBranch(cwd: string): string | null {
  const r = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const b = r.rc === 0 ? r.stdout.trim() : '';
  return b && b !== 'HEAD' ? b : null;
}
function configGet(cwd: string, key: string): string | null {
  const r = git(cwd, ['config', '--get', key]);
  return r.rc === 0 ? r.stdout.trim() : null;
}

interface GitGlobals { redirected: boolean; forbiddenConfig: string | null }
function gitGlobals(argv: string[], rest: string[], env: NodeJS.ProcessEnv): GitGlobals {
  const gi = argv.findIndex((w) => base(w) === 'git');
  let redirected = argv.slice(0, gi < 0 ? 0 : gi).some((w) => /^(GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR)=/.test(w));
  let forbiddenConfig: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('-')) break;
    if (a === '--git-dir' || a === '--work-tree' || a.startsWith('--git-dir=') || a.startsWith('--work-tree=')) redirected = true;
    if (a === '-c' || a === '--config-env') {
      const kv = lit(rest[i + 1], env) ?? '';
      if (/^(alias\.|push\.|remote\.|branch\.)/i.test(kv)) forbiddenConfig = kv;
    }
    if (GIT_GLOBAL_VALUE.has(a)) i++;
  }
  return { redirected, forbiddenConfig };
}

/** List mode only from the switches builtin/tag.c reads as list; --sort/--format/-i/--column with a name still create. */
export function tagMutates(args: string[]): boolean {
  if (!args.some((a) => !a.startsWith('-'))) return false;
  if (args.some((a) => TAG_WRITE_FLAGS.has(a.split('=')[0]))) return true;
  if (args.some((a) => /^-[a-zA-Z]{2,}$/.test(a) && /[adfsmFue]/.test(a.slice(1)))) return true;
  return !args.some((a) => TAG_LIST_MODE.test(a));
}

interface PushCtx { cwd: string | null; env: NodeJS.ProcessEnv; hosts: string[]; protectedSet: Set<string>; stateChanged: boolean; globals: GitGlobals; tailUnknown: boolean }

function pushVerdicts(args: string[], c: PushCtx): V[] {
  const flags = new Set<string>(); const positional: string[] = []; const pushOpts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { positional.push(...args.slice(i + 1)); break; }
    if (a === '-o' || a === '--push-option') { pushOpts.push(lit(args[i + 1], c.env) ?? '?'); i++; continue; }
    if (a.startsWith('--push-option=')) { pushOpts.push(a.slice('--push-option='.length)); continue; }
    if (PUSH_VALUE_OPTS.has(a)) { i++; continue; }
    if (a.startsWith('-')) { flags.add(a.split('=')[0]); if (/^-[a-zA-Z]{2,}$/.test(a)) for (const ch of a.slice(1)) flags.add('-' + ch); continue; }
    positional.push(a);
  }
  if (flags.has('-n') || flags.has('--dry-run')) return [];
  const remoteWord = positional[0];
  const remote = remoteWord === undefined ? undefined : lit(remoteWord, c.env);
  let corporate: boolean | null;
  if (remote === null) corporate = null;
  else if (remote !== undefined && (remote.includes('://') || /^[^/\s]+@[^/\s]+:/.test(remote) || remote.startsWith('/') || remote.startsWith('.'))) corporate = isCorporateUrl(remote, c.hosts);
  else if (c.cwd === null || c.globals.redirected || c.stateChanged) corporate = null;
  else {
    const name = remote ?? configGet(c.cwd, `branch.${currentBranch(c.cwd) ?? ''}.remote`) ?? 'origin';
    const url = git(c.cwd, ['remote', 'get-url', '--push', name]);
    corporate = url.rc === 0 ? isCorporateUrl(url.stdout, c.hosts) : repoIsCorporate(c.cwd, c.hosts);
  }
  if (corporate === false) return [];
  const where = corporate === null ? ' (адресат или каталог не установлены — судится как корпоративный GitLab)' : '';
  const no = (why: string): V => deny([`owner-actions: git push${where} — ${why}`]);
  if (c.tailUnknown) return [no('аргументы приходят из xargs, цель push недоказуема.')];
  if (c.stateChanged) return [no('раньше в той же команде меняется ветка, remote или конфиг, а гейт читает состояние до её выполнения.')];
  if (c.globals.forbiddenConfig) return [no(`-c ${c.globals.forbiddenConfig} подменяет, что и куда уходит.`)];
  const bad = [...flags].filter((f) => PUSH_FORBIDDEN_FLAGS.has(f));
  if (bad.length) return [no(`${bad.join(' ')} публикует теги или ветки разом — это решение владельца.`)];
  const autoMerge = pushOpts.some((o) => /^merge_request\.(merge_when_pipeline_succeeds|auto_merge)/.test(o));
  const mrTarget = pushOpts.find((o) => o.startsWith('merge_request.target='))?.slice('merge_request.target='.length) ?? null;
  if (autoMerge && (mrTarget === null || c.protectedSet.has(mrTarget))) return [no(`push-опция автомержа MR ${mrTarget ? `в ${mrTarget}` : 'без явной цели'} — мерж в боевую линию решает владелец.`)];
  const refspecs = positional.slice(1);
  const deleting = flags.has('-d') || flags.has('--delete');
  if (c.cwd === null || c.globals.redirected) {
    const ok = refspecs.length > 0 && !deleting && refspecs.every((w) => { const s = lit(w, c.env); return s !== null && BRANCH_PREFIX.test(s) && !c.protectedSet.has(s); });
    return ok ? [] : [no('каталог не определён, а refspec не литерал ветки с префиксом feature/fix/hotfix/release/chore/docs/refactor/perf/test/backup.')];
  }
  const cwd = c.cwd;
  const current = currentBranch(cwd);
  const remoteName = remote ?? (current ? configGet(cwd, `branch.${current}.remote`) : null) ?? 'origin';
  if (!refspecs.length) {
    if (!current) return [no('голый push из отвязанного HEAD — цель не установлена.')];
    const pushMap = configGet(cwd, `remote.${remoteName}.push`);
    if (pushMap) return [no(`у remote задан remote.${remoteName}.push=${pushMap} — голый push уходит по этой карте.`)];
    const up = (configGet(cwd, `branch.${current}.merge`) ?? '').replace(/^refs\/heads\//, '');
    if (c.protectedSet.has(current) || c.protectedSet.has(up)) return [no(`голый push с ${current} (upstream ${up || 'нет'}) пишет в защищённую ветку — мержит владелец.`)];
    return [];
  }
  const found: V[] = [];
  const branchName = (x: string): string | null => {
    if (x === 'HEAD' || x === '@') return current;
    if (x.startsWith('refs/heads/')) return x.slice('refs/heads/'.length) || null;
    if (/^(refs|heads|tags|remotes)\//.test(x) || /[*^~:?[\\]|@\{/.test(x)) return null;
    return x || null;
  };
  for (let i = 0; i < refspecs.length; i++) {
    const s0 = lit(refspecs[i], c.env);
    if (s0 === null) { found.push(no(`refspec ${refspecs[i]} не раскрывается.`)); continue; }
    if (s0 === 'tag') { found.push(no(`«tag ${refspecs[i + 1] ?? ''}» публикует тег.`)); i++; continue; }
    const s = s0.replace(/^\+/, '');
    const colon = s.indexOf(':');
    const src = colon < 0 ? s : s.slice(0, colon);
    const dst = colon < 0 ? s : s.slice(colon + 1);
    if (deleting || (colon === 0 && dst)) {
      const name = branchName(dst);
      const explicit = dst.startsWith('refs/heads/');
      if (!name) { found.push(no(`удаление ${dst}: это не имя ветки.`)); continue; }
      if (c.protectedSet.has(name)) { found.push(no(`удаление ${name} — защищённая ветка.`)); continue; }
      if (!explicit && (VERSION_LIKE.test(name) || refExists(cwd, `refs/tags/${name}`) || !refExists(cwd, `refs/remotes/${remoteName}/${name}`))) {
        found.push(no(`удаление ${name}: не доказано, что это ветка, а не тег (снимает тег только владелец); пиши :refs/heads/<ветка>.`));
      }
      continue;
    }
    const srcName = branchName(src);
    const dstName = colon < 0 ? srcName : branchName(dst);
    if (!srcName || !dstName) { found.push(no(`${s} — не литерал ветки (глоб, refs/, tags/, heads/, @ или выражение ревизии).`)); continue; }
    if (!refExists(cwd, `refs/heads/${srcName}`)) { found.push(no(`источник ${srcName} — не локальная ветка (тег, коммит или чужое имя).`)); continue; }
    if (refExists(cwd, `refs/tags/${srcName}`) || refExists(cwd, `refs/tags/${dstName}`)) { found.push(no(`${srcName}→${dstName}: имя совпадает с тегом — git может опубликовать тег.`)); continue; }
    if (c.protectedSet.has(dstName)) {
      found.push(deny([`owner-actions: прямой push в ${dstName} — это мерж в боевую линию мимо MR и мимо владельца.`, `Путь в ${dstName} один: MR с release/* или hotfix/*, мержит владелец.`]));
    }
  }
  return found;
}

interface GlabCtx { cwd: string | null; env: NodeJS.ProcessEnv; protectedSet: Set<string>; stateChanged: boolean; tailUnknown: boolean }

function mergeTarget(viewArgs: string[], cwd: string, env: NodeJS.ProcessEnv): string | null {
  let r: { rc: number; stdout: string };
  try { r = spawnTool('glab', viewArgs, { cwd, timeoutMs: 8000, env: { ...process.env, ...env } }); } catch { return null; }
  if (r.rc !== 0 || !r.stdout) return null;
  try { const j = JSON.parse(r.stdout) as { target_branch?: unknown }; return typeof j.target_branch === 'string' ? j.target_branch : null; } catch { return null; }
}

function splitGlab(rest: string[]): { repo: string[]; words: string[] } {
  const repo: string[] = []; const words: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (GLAB_GLOBAL_VALUE.has(a)) { repo.push(a, rest[i + 1] ?? ''); i++; continue; }
    if (a.startsWith('--repo=') || a.startsWith('--hostname=')) { repo.push(a); continue; }
    words.push(a);
  }
  return { repo, words };
}

function glabVerdicts(rest: string[], c: GlabCtx): V[] {
  const { repo, words } = splitGlab(rest);
  const top = words.find((w) => !w.startsWith('-')) ?? '';
  if (!top || words.includes('--help') || words.includes('-h')) return [];
  const no = (why: string): V => deny([`owner-actions: glab ${top} — ${why}`]);
  if (!GLAB_KNOWN.has(top)) return [no('не известная подкоманда (алиас?) — что она делает, гейт доказать не может.')];
  const tail = words.slice(words.indexOf(top) + 1);
  const sub = tail.find((w) => !w.startsWith('-')) ?? '';
  if (top === 'release') return ['create', 'delete', 'upload'].includes(sub) ? [no(`${sub} ставит, снимает или меняет релиз и его тег — только владелец.`)] : [];
  if (top === 'mr') {
    if (sub === 'update') {
      const t = tail.findIndex((w) => w === '--target-branch' || w === '-b' || w.startsWith('--target-branch='));
      const target = t < 0 ? null : (tail[t].includes('=') ? tail[t].split('=')[1] : tail[t + 1]) ?? null;
      return target !== null && c.protectedSet.has(target) ? [no(`update --target-branch ${target} перенацеливает MR в боевую линию — решает владелец.`)] : [];
    }
    if (sub !== 'merge' && sub !== 'accept') return [];
    if (c.tailUnknown) return [no('merge с аргументами из xargs — цель недоказуема.')];
    if (c.stateChanged) return [no('merge после команды, меняющей MR или репозиторий, в той же строке — цель читается до неё.')];
    let id: string | null = null;
    for (let k = tail.indexOf(sub) + 1; k < tail.length; k++) { const a = tail[k]; if (['-m', '--message', '--squash-message', '--sha'].includes(a)) { k++; continue; } if (a.startsWith('-')) continue; id = a; break; }
    if (c.cwd === null && !repo.length) return [no('каталог не определён и -R не задан — GitLab спросили бы о чужом MR.')];
    const target = mergeTarget(['mr', 'view', ...(id ? [id] : []), '-F', 'json', ...repo], c.cwd ?? process.cwd(), c.env);
    if (target === null) return [no(`цель мержа не установлена (glab mr view не ответил) — недоказанная цель может быть ${[...c.protectedSet].join(', ')}. Повтори, когда GitLab отвечает; в незащищённую ветку мерж пройдёт.`)];
    if (c.protectedSet.has(target)) return [no(`мерж в ${target} — кнопку жмёт владелец. Доклад: ссылка, вердикт ревью, что закрыто и чем доказано, вопрос «мержить?».`)];
    return [];
  }
  if (top === 'api') {
    let method: string | null = null; let path: string | null = null; let hasBody = false; const bodies: string[] = [];
    for (let k = 0; k < tail.length; k++) {
      const a = tail[k];
      if (a === '-X' || a === '--method') { method = (tail[k + 1] ?? '').toUpperCase(); k++; continue; }
      if (a.startsWith('--method=')) { method = a.slice('--method='.length).toUpperCase(); continue; }
      if (/^-X[A-Za-z]+$/.test(a)) { method = a.slice(2).toUpperCase(); continue; }
      if (API_BODY_OPTS.has(a)) { hasBody = true; bodies.push(a === '--input' ? '\u0000file' : (tail[k + 1] ?? '')); k++; continue; }
      if (API_VALUE_OPTS.has(a)) { k++; continue; }
      if (a.startsWith('-')) continue;
      if (path === null) path = a;
    }
    if (path === null) return [];
    const effective = method ?? (hasBody ? 'POST' : 'GET');
    const bare = path.split('?')[0];
    if (bare === 'graphql' || bare.endsWith('/graphql')) {
      const fromFile = bodies.some((b) => b === '\u0000file' || /^[^=]*=@/.test(b) || b.startsWith('@'));
      if (fromFile) return [no('graphql с телом из файла или stdin — что в нём, гейт не видит; мерж и теги решает владелец.')];
      return bodies.some((b) => /mutation/i.test(b)) ? [no('graphql mutation — запись в GitLab мимо разбираемых путей.')] : [];
    }
    if (effective === 'GET' || effective === 'HEAD') return [];
    if (API_OWNER_WRITE.test(bare)) return [no(`${effective} ${bare} пишет теги, релизы, коммиты или защиту веток — только владелец.`)];
    if (API_MERGE.test(bare)) {
      if (c.stateChanged || c.tailUnknown) return [no('API-мерж после команды, меняющей MR, в той же строке — цель читается до неё.')];
      if (c.cwd === null && !repo.length && bare.includes(':id')) return [no('каталог не определён — :id проекта неизвестен.')];
      const target = mergeTarget(['api', ...repo, bare.replace(/\/merge\/?$/, '')], c.cwd ?? process.cwd(), c.env);
      if (target === null) return [no('цель API-мержа не установлена — недоказанная цель может быть main.')];
      if (c.protectedSet.has(target)) return [no(`API-мерж в ${target} — кнопку жмёт владелец.`)];
    }
    return [];
  }
  return [];
}

const HTTP_METHOD = /^(GET|HEAD|OPTIONS|PUT|POST|DELETE|PATCH)$/i;
const CURL_BODY = new Set(['-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--data-ascii', '--json', '-F', '--form', '--form-string']);
const CURL_VALUE = new Set(['-H', '--header', '-o', '--output', '-u', '--user', '-A', '--user-agent', '-e', '--referer', '-b', '--cookie', '-c', '--cookie-jar', '-w', '--write-out', '-m', '--max-time', '--connect-timeout', '-x', '--proxy', '--url']);

interface Body { literal: boolean; text: string }
/** A literal body can be read here; `@file`, `@-` and upload files cannot, so their content is unproven. */
function literalBody(opt: string, value: string): Body { return { literal: !(value.startsWith('@') && opt !== '--data-raw'), text: value }; }

/** Any HTTP client toward the company API: a body, an upload or a method word makes it a write; GraphQL writes unless its
 *  body is a literal without a mutation. A merge or an owner path by a raw client is a deny — its target is unproven. */
function httpVerdicts(name: string, argv: string[], hosts: string[]): V[] {
  const args = argv.slice(argv.findIndex((w) => base(w) === name) + 1);
  if (args.includes('--help') || args.includes('-h')) return [];
  const isApi = (w: string): boolean => w.includes('/api/v4/') || /\/api\/graphql(\/|\?|$)/.test(w);
  const url = args.find((w) => isApi(w) || (/^https?:\/\//.test(w) && isCorporateUrl(w, hosts)));
  if (!url) return [];
  const path = url.split('?')[0];
  let write = false; const bodies: Body[] = [];
  const httpie = name !== 'curl' && name !== 'wget';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const [opt, attached] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    if (name === 'curl') {
      if (opt === '-X' || opt === '--request') { const m = attached ?? args[++i] ?? ''; if (!/^(GET|HEAD)$/i.test(m)) write = true; continue; }
      if (/^-X[A-Za-z]+$/.test(a)) { if (!/^-X(GET|HEAD)$/i.test(a)) write = true; continue; }
      if (opt === '-T' || opt === '--upload-file') { write = true; bodies.push({ literal: false, text: '' }); if (attached === undefined) i++; continue; }
      if (CURL_BODY.has(opt)) { write = true; bodies.push(literalBody(opt, attached ?? args[++i] ?? '')); continue; }
      if (CURL_VALUE.has(opt) && attached === undefined) { i++; continue; }
      continue;
    }
    if (name === 'wget') {
      if (opt === '--method') { if (!/^(GET|HEAD)$/i.test(attached ?? args[++i] ?? '')) write = true; continue; }
      if (opt === '--post-data' || opt === '--body-data') { write = true; bodies.push({ literal: true, text: attached ?? args[++i] ?? '' }); continue; }
      if (opt === '--post-file' || opt === '--body-file') { write = true; bodies.push({ literal: false, text: '' }); if (attached === undefined) i++; continue; }
      continue;
    }
    if (httpie && !a.startsWith('-') && a !== url) {
      if (HTTP_METHOD.test(a) && args.indexOf(url) > i) { if (!/^(GET|HEAD|OPTIONS)$/i.test(a)) write = true; continue; }
      if (args.indexOf(url) < i && /^[^=:@]+(:=@|=@|@|:=|==|=)/.test(a) && !/^[^=:@]+==/.test(a)) {
        write = true; bodies.push({ literal: !/^[^=:@]+(:=@|=@|@)/.test(a), text: a });
      }
    }
  }
  if (!write) return [];
  if (/\/api\/graphql\/?$/.test(path)) {
    const provable = bodies.length > 0 && bodies.every((b) => b.literal) && !bodies.some((b) => /mutation/i.test(b.text));
    return provable ? [] : [deny([`owner-actions: GraphQL-запрос с ${bodies.some((b) => !b.literal) ? 'телом из файла или stdin' : 'мутацией'} к GitLab — запись, которую гейт не может ограничить путём; мерж и теги решает владелец.`])];
  }
  const bare = path.replace(/^.*\/api\/v4\//, '');
  if (API_MERGE.test(bare) || API_OWNER_WRITE.test(bare)) return [deny([`owner-actions: запрос на запись к API GitLab (${bare}) — мерж, теги, релизы и коммиты в боевую линию решает владелец.`])];
  return [];
}

export function decide(ctx: GateContext): Verdict {
  const p = ctx.payload;
  if (!('tool_name' in p) || p.tool_name !== 'Bash') return { kind: 'silent' };
  const command = (p.tool_input as { command?: unknown } | undefined)?.command;
  if (typeof command !== 'string' || !command.trim()) return { kind: 'silent' };
  const cfg = loadConfig(ctx.env);
  const env = withShellPaths(ctx.env, command, cfg.shellPaths);
  const hosts = (env.OWNER_GATE_HOSTS ?? cfg.ownerHosts.join(',')).split(',').filter(Boolean);
  const protectedSet = new Set((env.OWNER_GATE_PROTECTED ?? cfg.protectedBranches.join(',')).split(',').filter(Boolean));
  const found: V[] = [];
  let stateChanged = false;
  let touches = false;
  for (const seg of segmentsWithCwd(tokenize(command), p.cwd, env)) {
    let name = base(seg.name);
    let rest = seg.rest;
    let tailUnknown = false;
    if (name !== 'git' && name !== 'glab' && !HTTP_CLIENTS.has(name)) {
      const k = seg.argv.findIndex((w, idx) => idx > 0 && (base(w) === 'git' || base(w) === 'glab'));
      if (k > 0) { name = base(seg.argv[k]); rest = seg.argv.slice(k + 1); tailUnknown = base(seg.argv[0]) === 'xargs'; }
    }
    if (seg.name.includes('$') && rest.some((w) => /^(tag|push|update-ref|merge|accept|release|api)$/.test(w))) {
      found.push(deny([`owner-actions: имя команды из переменной (${seg.name}) при аргументах ${rest.join(' ')} — что исполнится, недоказуемо.`]));
      continue;
    }
    if (HTTP_CLIENTS.has(name)) { touches ||= seg.argv.some((w) => /\/api\/(v4\/|graphql)/.test(w)); found.push(...httpVerdicts(name, seg.argv, hosts)); continue; }
    if (name === 'git') {
      const globals = gitGlobals(seg.argv, rest, seg.env);
      const call = parseGit(rest, seg.cwd, seg.env);
      if (!call) continue;
      touches ||= call.verb === 'push' || call.verb === 'tag' || call.verb === 'update-ref';
      const cwd = globals.redirected ? null : call.cwd;
      const scope = repoIsCorporate(cwd, hosts);
      if (call.verb === 'tag') {
        if (scope !== false && (tailUnknown || tagMutates(call.args))) {
          found.push(deny([`owner-actions: git tag ${call.args.join(' ')}${scope === null ? ' (каталог не определён — судится как корпоративный репозиторий)' : ''} — постановка, перенос и удаление тега только по слову владельца.`, 'Номер можно предложить (ls-remote, точное совпадение), сам тег ставит владелец.']));
        }
      } else if (call.verb === 'update-ref') {
        if (scope !== false && (tailUnknown || call.args.some((a) => a.startsWith('refs/tags/')))) found.push(deny([`owner-actions: git update-ref ${call.args.join(' ')} — запись тега в обход git tag.`]));
      } else if (call.verb === 'push') {
        found.push(...pushVerdicts(call.args, { cwd, env: seg.env, hosts, protectedSet, stateChanged, globals, tailUnknown }));
      } else if (globals.forbiddenConfig && /^alias\./i.test(globals.forbiddenConfig) && scope !== false) {
        found.push(deny([`owner-actions: git -c ${globals.forbiddenConfig} ${call.verb} — алиас, заданный в той же команде, прячет глагол.`]));
      } else if (cwd !== null && scope === true) {
        const alias = configGet(cwd, `alias.${call.verb}`);
        if (alias && /(^|[\s!])(push|tag|update-ref)(\s|$)/.test(alias)) found.push(deny([`owner-actions: git ${call.verb} — алиас «${alias}» пишет теги или push.`]));
      }
      if (GIT_STATE_VERBS.has(call.verb)) stateChanged = true;
      continue;
    }
    if (name === 'glab') {
      touches = true;
      found.push(...glabVerdicts(rest, { cwd: seg.cwd, env: seg.env, protectedSet, stateChanged, tailUnknown }));
      if (rest.includes('update') || rest.includes('alias')) stateChanged = true;
    }
  }
  if (touches && cfg.problem && (env.OWNER_GATE_HOSTS === undefined || env.OWNER_GATE_PROTECTED === undefined)) {
    found.push(deny([`owner-actions: конфиг площадки не прочитан (${cfg.problem}) — какие хосты и ветки защищены, не доказать.`]));
  }
  if (!found.length) return { kind: 'silent' };
  return { kind: 'deny', gate: NAME, reason: [...new Set(found.map((v) => (v as { reason: string }).reason))].join('\n') };
}

const gate: Gate = { name: NAME, events: ['pre-bash'], killSwitch: 'CLAUDE_SKIP_OWNER_GATE', run: decide };
register(gate);
