// PreToolUse(Bash) `git push` / `glab mr create`: ворота отправки наружу (порт hooks/pre-push-guard.sh) плюс два
// правила из матрицы покрытия §2.1: H1 — тела миграций против таргета, H2 — замыкание release/hotfix в main.
// Команда разбирается токенизатором и git-argv (`cd X &&`, `git -C X`); всё про репозиторий — через src/git.ts
// (read-глаголы, без fetch: сверка идёт по локальным remote-tracking refs; их отсутствие → unknown).
// Regex здесь — только для строк без грамматики: имена веток, пути файлов, тема коммита, имя файла миграции.
// Отличие от bash: неразобранная цель push, detached HEAD и cwd вне git дают unknown (→ ask на pre),
// а не пропуск с предупреждением — PORTING запрещает схлопывать «нет данных» в тишину.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { register } from './registry.ts';
import { tokenize } from '../parsers/shell.ts';
import { segmentsWithCwd, parseGit, isGit, expandWord } from './git-argv.ts';
import { git } from '../git.ts';
import { loadConfig } from '../config.ts';
import type { Gate, GateContext, Verdict } from '../types.ts';

export const NAME = 'pre-push-guard';
const RELEASE_SOURCE = /^(release|hotfix)\//;
// Обвязка стенда: пути, которые существуют только на этой машине.
const LOCAL_WIRING = /(^|\/)\.env|(^|\/)env\/|\.env\.|(^|\/)local\/|stand|docker-compose\.override|(^|\/)\.claude\//i;
const LOCAL_SUBJECT = /^chore\(env\)/i;
// The owner's exceptions to the wiring rule: harness/owner/ is written only by the owner (gate owner-files).
export const EXCEPTIONS_FILE = join('owner', 'pre-push-exceptions.json');
const MIGRATION_FILE = /^(src\/migrations?)\/((\d{13})-[a-z0-9]+(?:-[a-z0-9]+)*\.ts)$/;
const MIGRATION_NAME = /^(\d{13})-[a-z0-9]+(?:-[a-z0-9]+)*\.ts$/;
const RELEASE_TARGET = /^release\/(\d+(?:\.\d+)*)$/;
const PUSH_VALUE_OPTS = new Set(['-o', '--push-option', '--receive-pack', '--exec', '--repo']);
const BYPASS = 'Разовый обход: CLAUDE_SKIP_PREPUSH_GUARD=1.';

interface Intent { kind: 'push' | 'mr'; remote: string | null; target: string | null; cwd: string | null; raw: string; source?: string | null; env?: NodeJS.ProcessEnv }

const deny = (lines: string[]): Verdict => ({ kind: 'deny', gate: NAME, reason: [...lines, BYPASS].join('\n') });
const unknown = (reason: string): Verdict => ({ kind: 'unknown', gate: NAME, reason });

function out(cwd: string, args: string[]): string | null {
  const r = git(cwd, args);
  return r.rc === 0 ? r.stdout.replace(/\n$/, '') : null;
}
const exists = (cwd: string, ref: string): boolean => out(cwd, ['rev-parse', '--verify', '--quiet', ref]) !== null;

function intents(command: string, cwd: string, env: NodeJS.ProcessEnv): Intent[] {
  const list: Intent[] = [];
  for (const seg of segmentsWithCwd(tokenize(command), cwd, env)) {
    if (isGit(seg.name)) {
      const call = parseGit(seg.rest, seg.cwd, seg.env);
      if (!call || call.verb !== 'push') continue;
      const positional: string[] = [];
      for (let i = 0; i < call.args.length; i++) {
        const a = call.args[i];
        if (a === '--') { positional.push(...call.args.slice(i + 1)); break; }
        if (PUSH_VALUE_OPTS.has(a)) { i++; continue; }
        if (a.startsWith('-')) continue;
        positional.push(a);
      }
      let target: string | null = null;
      if (positional.length >= 2) {
        const refspec = positional[1].replace(/^\+/, '');
        target = refspec.includes(':') ? refspec.slice(refspec.indexOf(':') + 1) : refspec;
        target = target.replace(/^refs\/heads\//, '');
      }
      list.push({ kind: 'push', remote: positional[0] ?? null, target, cwd: call.cwd, raw: seg.raw, env: seg.env });
      continue;
    }
    if ((seg.name.split('/').pop() ?? seg.name) === 'glab' && seg.rest[0] === 'mr' && seg.rest[1] === 'create') {
      let target: string | null = null; let source: string | null = null;
      for (let i = 2; i < seg.rest.length; i++) {
        const w = seg.rest[i];
        if (w === '--target-branch' || w === '-b') target = seg.rest[i + 1] ?? null;
        else if (w.startsWith('--target-branch=')) target = w.slice('--target-branch='.length);
        else if (w === '--source-branch' || w === '-s') source = seg.rest[i + 1] ?? null;
        else if (w.startsWith('--source-branch=')) source = w.slice('--source-branch='.length);
      }
      list.push({ kind: 'mr', remote: null, target, cwd: seg.cwd, raw: seg.raw, source, env: seg.env });
    }
  }
  return list;
}

/** Слово команды как имя remote/ветки: подстановка команды или неизвестная переменная → null (цель не доказана). */
function literal(word: string | null, env: NodeJS.ProcessEnv): string | null | undefined {
  if (word === null) return null;
  if (word.includes('$(') || word.includes('`')) return undefined;
  const e = expandWord(word, env);
  return e === null ? undefined : e;
}

function check(it: Intent, protectedSet: Set<string>, env: NodeJS.ProcessEnv, root: string): Verdict[] {
  if (it.cwd === null) return [unknown(`каталог команды не определён (${it.raw})`)];
  const cwd = it.cwd;
  const branch = out(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === null) return [unknown(`cwd вне git-репозитория (${cwd})`)];
  if (branch === 'HEAD') return [unknown('detached HEAD: ветка-источник не определена')];
  const words = it.env ?? env;
  let remote = literal(it.remote, words); let target = literal(it.target, words);
  if (remote === undefined || target === undefined) return [unknown(`цель ${it.kind === 'mr' ? 'MR' : 'push'} не определена (${it.raw})`)];

  if (it.kind === 'mr') {
    if (!target) return [unknown(`цель MR не указана (--target-branch): ${it.raw}`)];
    const remotes = (out(cwd, ['remote']) ?? '').split('\n').filter(Boolean);
    if (!remotes.length) return [unknown('remote не настроен — MR не с чем сверять')];
    const found: Verdict[] = [];
    const source = it.source === undefined || it.source === null ? branch : literal(it.source, words);
    if (source === undefined) return [unknown(`ветка-источник MR не раскрывается (${it.raw})`)];
    if (protectedSet.has(target) && !RELEASE_SOURCE.test(source ?? branch)) {
      found.push(deny([
        `pre-push-guard: MR в ${target} открывается только с release/* или hotfix/*.`,
        `Ветка ${source ?? branch} — фичевая: её MR идёт в интеграционную ветку, а в ${target}`,
        'состав приходит релизной веткой.',
      ]));
    }
    found.push(...seriesRules(cwd, remotes.includes('origin') ? 'origin' : remotes[0], target, protectedSet, { wiring: false, h2: false }));
    return found;
  }

  if (!target) {
    const upRemote = out(cwd, ['config', '--get', `branch.${branch}.remote`]);
    const upMerge = out(cwd, ['config', '--get', `branch.${branch}.merge`]);
    if (remote === null) {
      if (!upRemote || !upMerge) return [unknown(`цель push не определена (${it.raw}): upstream не настроен`)];
      remote = upRemote; target = upMerge.replace(/^refs\/heads\//, '');
    } else {
      target = upRemote === remote && upMerge ? upMerge.replace(/^refs\/heads\//, '') : branch;
    }
  }
  if (target === 'HEAD') target = branch;
  if (remote === null) return [unknown(`remote push не определён (${it.raw})`)];
  const found: Verdict[] = [];
  if (protectedSet.has(target) && !RELEASE_SOURCE.test(branch)) {
    found.push(deny([
      `pre-push-guard: push в ${target} разрешён только с release/* или hotfix/*.`,
      `Текущая ветка ${branch} — фичевая. В ${target} состав приходит релизной веткой`,
      'или через MR, напрямую — только хотфикс по мандату.',
    ]));
  }
  found.push(...seriesRules(cwd, remote, target, protectedSet, { wiring: true, h2: true, env, root }));
  return found;
}

function seriesRules(cwd: string, remote: string, target: string, protectedSet: Set<string>, opts: { wiring: boolean; h2: boolean; env?: NodeJS.ProcessEnv; root?: string }): Verdict[] {
  const refs = out(cwd, ['for-each-ref', '--format=%(refname:short) %(objectname)', `refs/remotes/${remote}/`]);
  if (!refs) return [unknown(`у remote «${remote}» нет локальных refs — состав серии, миграции и замыкание release не проверить (нужен fetch)`)];
  const found: Verdict[] = [];
  const baseRef = `refs/remotes/${remote}/${target}`;
  const baseLabel = `${remote}/${target}`;
  if (exists(cwd, baseRef)) {
    // База отсутствует → удалённой ветки ещё нет: состав серии не определён, сравнивать миграции не с чем (как в bash).
    if (opts.wiring) found.push(...localWiring(cwd, baseRef, baseLabel, wiringExceptions(opts.root, out(cwd, ['remote', 'get-url', remote]))));
    found.push(...migrationBodies(cwd, baseRef, baseLabel));
  }
  if (opts.h2) {
    const m = RELEASE_TARGET.exec(target);
    if (m) found.push(...releaseClosure(cwd, remote, m[1], protectedSet, refs, opts.env));
  }
  return found;
}

interface Excused { paths: RegExp[]; broken: string | null }

const glob = (g: string): RegExp => new RegExp(`^${g.split('**').map((part) => part.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*')}$`);

/** Paths the owner excused from the wiring rule for this remote; a list that cannot be read excuses nothing. */
function wiringExceptions(root: string | undefined, remoteUrl: string | null): Excused {
  if (!root || remoteUrl === null) return { paths: [], broken: null };
  let raw: string;
  try { raw = readFileSync(join(root, EXCEPTIONS_FILE), 'utf8'); } catch { return { paths: [], broken: null }; }
  try {
    const rules = (JSON.parse(raw) as { 'local-wiring'?: Array<{ remote?: unknown; paths?: unknown }> })['local-wiring'] ?? [];
    const paths = rules
      .filter((r) => typeof r.remote === 'string' && r.remote !== '' && remoteUrl.includes(r.remote))
      .flatMap((r) => (Array.isArray(r.paths) ? r.paths.filter((x): x is string => typeof x === 'string').map(glob) : []));
    return { paths, broken: null };
  } catch (err) {
    return { paths: [], broken: `${EXCEPTIONS_FILE} не прочитан (${err instanceof Error ? err.message : String(err)}) — исключения не действуют` };
  }
}

function localWiring(cwd: string, baseRef: string, baseLabel: string, excused: Excused = { paths: [], broken: null }): Verdict[] {
  const series = out(cwd, ['log', '--format=%H%x09%s', `${baseRef}..HEAD`]) ?? '';
  const found: Verdict[] = [];
  for (const line of series.split('\n')) {
    if (!line.trim()) continue;
    const tab = line.indexOf('\t');
    const sha = line.slice(0, tab); const subject = line.slice(tab + 1);
    const files = (out(cwd, ['show', '--name-only', '--format=', sha]) ?? '').split('\n').filter(Boolean);
    const wiringSubject = LOCAL_SUBJECT.test(subject);
    const wiringFiles = files.length > 0 && files.every((f) => LOCAL_WIRING.test(f) && !excused.paths.some((re) => re.test(f)));
    if (wiringSubject || wiringFiles) {
      found.push(deny([
        `pre-push-guard: в серии на ${baseLabel} есть коммит локальной обвязки:`,
        `  ${sha.slice(0, 9)} ${subject}`,
        'Обвязка стенда живёт на local/-ветке и до пуша отрезается —',
        'иначе она уходит в GitLab (поймано 25.08).',
        `Отрезать: git rebase --onto ${baseLabel} <последний рабочий коммит>`,
        ...(excused.broken ? [excused.broken] : []),
      ]));
    }
  }
  return found;
}

/** H1: новая миграция ветки против миграций таргета — то же тело под другим штампом, либо штамп «…00000». */
function migrationBodies(cwd: string, baseRef: string, baseLabel: string): Verdict[] {
  // --no-renames обязателен: то же тело под другим штампом git считает переименованием (R), и фильтр A его теряет.
  const added = (out(cwd, ['diff', '--no-renames', '--name-only', '--diff-filter=A', `${baseRef}..HEAD`]) ?? '').split('\n');
  const fresh = added.map((f) => MIGRATION_FILE.exec(f)).filter((m): m is RegExpExecArray => m !== null);
  if (!fresh.length) return [];
  const found: Verdict[] = [];
  const listings = new Map<string, string[]>();
  const targetFiles = (dir: string): string[] => {
    if (!listings.has(dir)) {
      const tree = out(cwd, ['show', `${baseRef}:${dir}`]) ?? '';
      listings.set(dir, tree.split('\n').slice(2).filter((n) => MIGRATION_NAME.test(n)));
    }
    return listings.get(dir)!;
  };
  for (const [path, dir, name, stamp] of fresh) {
    if (stamp.endsWith('00000')) {
      found.push(deny([
        `pre-push-guard: миграция ${path} несёт круглый штамп ${stamp} — число назначено вручную, две ветки приходят к одному значению.`,
        'Сними штамп Date.now() и переименуй файл вместе с классом.',
      ]));
    }
    const body = out(cwd, ['show', `HEAD:${path}`]);
    if (body === null) continue;
    const norm = body.split(stamp).join('').trim();
    for (const other of targetFiles(dir)) {
      if (other === name) continue;
      const otherStamp = MIGRATION_NAME.exec(other)![1];
      const otherBody = out(cwd, ['show', `${baseRef}:${dir}/${other}`]);
      if (otherBody === null) continue;
      if (otherBody.split(otherStamp).join('').trim() === norm) {
        found.push(deny([
          `pre-push-guard: миграция ${path} совпадает телом с ${dir}/${other} на ${baseLabel} — одна миграция под двумя штампами, после мержа применятся обе.`,
          `Оставь имя таргета (${other}) или убери дубль из ветки.`,
        ]));
      }
    }
  }
  return found;
}

const parseVersion = (v: string): number[] => v.split('.').map(Number);
function cmpVersion(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (d !== 0) return d; }
  return 0;
}

/** H2: before release/<N+1>, every remote release/* with a lower number and every hotfix/* is closed into the protected branch.
 *  A candidate is closed when main holds its content (git cherry: no patch left out, so a cherry-picked hotfix counts)
 *  and is considered at all only while its tip is younger than H2_WINDOW_DAYS: the rule guards «N+1 cut before the hotfix
 *  of N is back» within one cycle; branches abandoned cycles ago (a 2025 vendor hotfix) would otherwise block every release. */
function releaseClosure(cwd: string, remote: string, version: string, protectedSet: Set<string>, refs: string, env: NodeJS.ProcessEnv = {}, now = Date.now()): Verdict[] {
  const windowDays = Number(env.H2_WINDOW_DAYS ?? '30');
  const protectedRefs = [...protectedSet].map((p) => `refs/remotes/${remote}/${p}`).filter((r) => exists(cwd, r));
  if (!protectedRefs.length) return [unknown(`нет refs/remotes/${remote}/{${[...protectedSet].join(',')}} — замыкание release/hotfix в main не проверить (нужен fetch)`)];
  const mine = parseVersion(version);
  const labels = protectedRefs.map((r) => r.replace('refs/remotes/', '')).join('|');
  const found: Verdict[] = [];
  for (const line of refs.split('\n')) {
    const sp = line.lastIndexOf(' ');
    if (sp < 0) continue;
    const short = line.slice(0, sp); const sha = line.slice(sp + 1);
    const name = short.startsWith(`${remote}/`) ? short.slice(remote.length + 1) : short;
    const rel = RELEASE_TARGET.exec(name);
    const candidate = rel ? cmpVersion(parseVersion(rel[1]), mine) < 0 : name.startsWith('hotfix/');
    if (!candidate) continue;
    const tip = Number(out(cwd, ['log', '-1', '--format=%ct', sha]) ?? '0') * 1000;
    if (Number.isFinite(windowDays) && tip && now - tip > windowDays * 86_400_000) continue;
    const merged = protectedRefs.some((pr) => git(cwd, ['merge-base', '--is-ancestor', sha, pr]).rc === 0
      || (git(cwd, ['cherry', pr, sha]).rc === 0 && !/^\+/m.test(out(cwd, ['cherry', pr, sha]) ?? '+')));
    if (merged) continue;
    found.push(deny([
      `pre-push-guard: вершина ${name} (${sha.slice(0, 9)}) не предок ${labels} — release/${version} не режется, пока предыдущий релиз/хотфикс не замкнут в main (INC-GETORCREATE-FIX-NOT-ON-MAIN).`,
      `Сначала влей ${name} в ${labels} или удали ветку, если она отменена.`,
    ]));
  }
  return found;
}

function strongest(vs: Verdict[]): Verdict {
  const denies = vs.filter((v) => v.kind === 'deny') as Extract<Verdict, { kind: 'deny' }>[];
  if (denies.length) return { kind: 'deny', gate: NAME, reason: denies.map((d) => d.reason).join('\n') };
  const unknowns = vs.filter((v) => v.kind === 'unknown') as Extract<Verdict, { kind: 'unknown' }>[];
  if (unknowns.length) return { kind: 'unknown', gate: NAME, reason: unknowns.map((u) => u.reason).join('; ') };
  return { kind: 'silent' };
}

export function decide(ctx: GateContext): Verdict {
  const p = ctx.payload;
  if (!('tool_name' in p) || p.tool_name !== 'Bash') return { kind: 'silent' };
  const command = (p.tool_input as { command?: unknown } | undefined)?.command;
  if (typeof command !== 'string' || !command.trim()) return { kind: 'silent' };
  const list = intents(command, p.cwd, ctx.env);
  if (!list.length) return { kind: 'silent' };
  const cfg = loadConfig(ctx.env);
  if (ctx.env.PREPUSH_PROTECTED === undefined && cfg.problem) {
    return { kind: 'unknown', gate: NAME, reason: `pre-push-guard: конфиг площадки не прочитан (${cfg.problem}) — какие ветки защищены, не доказать.` };
  }
  const protectedSet = new Set((ctx.env.PREPUSH_PROTECTED ?? cfg.protectedBranches.join(',')).split(',').filter(Boolean));
  return strongest(list.flatMap((it) => check(it, protectedSet, ctx.env, ctx.root)));
}

const gate: Gate = { name: NAME, events: ['pre-bash'], killSwitch: 'CLAUDE_SKIP_PREPUSH_GUARD', run: decide };
register(gate);
