// Worker tier: TypeScript errors of the project by the nearest tsconfig.json, against the same project at HEAD.
// fail ⟺ the working tree has an error (file, code, message) more times than HEAD has it — a project that carries errors
// in its base does not fail an edit that brought none, and an edit that breaks an untouched file still fails. Both
// programs are built by the project's own TypeScript in a child (tsc-diagnostics.ts) the budget can kill; the HEAD side
// is cached per commit and checked against the disk files it read. Files git ignores are the environment of both sides,
// not judged. A baseline that cannot be had — dependencies changed by the edit, git or the compiler failing — is
// unknown, never pass. A worker job builds the working-tree program of a project once for all its files of that project.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, head } from '../git.ts';
import { spawnTool } from '../platform.ts';
import { registerChecker } from './registry.ts';
import { projectTypescript, type Collected, type Diagnostic, type Input } from './tsc-diagnostics.ts';
import { verifyTypescript } from '../toolchain.ts';
import type { ChangedFile, CheckContext, CheckResult } from './types.ts';
import { digestOf } from '../sweep.ts';

const NAME = 'tsc-project';
const FORMAT = 2;
const CHILD = fileURLToPath(new URL('./tsc-diagnostics.ts', import.meta.url));
const DEPENDENCY_FILES = ['TOOLCHAIN.lock', 'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb'];
const KEEP_BASELINES = 200;
const SHOWN = 12;

export function tsProject(file: ChangedFile): string | null {
  let d = dirname(file.absPath);
  while (d.length >= file.repo.length) {
    if (existsSync(join(d, 'tsconfig.json'))) return d;
    if (d === file.repo) break;
    d = dirname(d);
  }
  return null;
}

export function applies(file: ChangedFile): boolean { return file.status !== 'D' && /\.(ts|tsx|mts|cts)$/.test(file.path) && !/\.d\.ts$/.test(file.path) && tsProject(file) !== null; }

export function budgetMs(ctx: CheckContext): number { return Math.min(ctx.deadlineMs, 600000); }

export const keyOf = (d: Pick<Diagnostic, 'file' | 'code' | 'message'>): string => JSON.stringify([d.file, d.code, d.message]);

/** The message with every quoted type blanked: an untouched error whose message prints a type the edit grew elsewhere
 * (`index type '{ a; b }'` → `'{ a; b; c }'`) keeps its shape. Apostrophes inside words are not quotes. */
export const shapeOf = (message: string): string => message.replace(/(\w)'(\w)/g, '$1\u0000$2').replace(/'[^']*'/g, "'…'").replace(/\u0000/g, "'");

const stem = (p: string): string => p.replace(/\.[cm]?[jt]sx?$|\.d\.[cm]?ts$/, '');

/** Errors of `now` beyond what the baseline holds: exact (file, code, message) first, then the same shape in the same
 * file for what is left on both sides. A baseline file and the paths its messages print follow the renames. */
export function newErrors(baseline: Map<string, number>, now: Diagnostic[], renames: Map<string, string>): Diagnostic[] {
  const left = new Map<string, number>();
  for (const [key, n] of baseline) {
    const [file, code, message] = JSON.parse(key) as [string, number, string];
    let text = message;
    for (const [from, to] of renames) text = text.split(`<repo>/${stem(from)}`).join(`<repo>/${stem(to)}`);
    const moved = keyOf({ file: renames.get(file) ?? file, code, message: text });
    left.set(moved, (left.get(moved) ?? 0) + n);
  }
  const unmatched: Diagnostic[] = [];
  for (const d of now) {
    const n = left.get(keyOf(d)) ?? 0;
    if (n > 0) left.set(keyOf(d), n - 1); else unmatched.push(d);
  }
  const shapes = new Map<string, number>();
  for (const [key, n] of left) {
    if (n <= 0) continue;
    const [file, code, message] = JSON.parse(key) as [string, number, string];
    const s = keyOf({ file, code, message: shapeOf(message) });
    shapes.set(s, (shapes.get(s) ?? 0) + n);
  }
  const fresh: Diagnostic[] = [];
  for (const d of unmatched) {
    const s = keyOf({ ...d, message: shapeOf(d.message) }), n = shapes.get(s) ?? 0;
    if (n > 0) shapes.set(s, n - 1); else fresh.push(d);
  }
  return fresh;
}

type Head = { commit: string | null } | { transient: true } | { reason: string };

/** No commit only on positive evidence: a git that timed out or died is not a repository without history. */
function headOf(repo: string): Head {
  const r = git(repo, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], 15000);
  if (r.rc === 0) return { commit: r.stdout.trim() };
  if (r.rc === 124) return { transient: true };
  const st = git(repo, ['status', '--porcelain=v2', '--branch', '--untracked-files=no'], 15000);
  if (st.rc === 0 && /^# branch\.oid \(initial\)$/m.test(st.stdout)) return { commit: null };
  return { reason: `HEAD не читается: ${r.stderr.trim().split('\n')[0] || `rc ${r.rc}`}` };
}

/** A dependency manifest or lock between the project and the repo root the edit changed: HEAD's node_modules are gone. */
function dependencyChange(repo: string, proj: string, base: string): string | null | { reason: string } {
  const paths: string[] = [];
  for (let d = proj; ; d = dirname(d)) {
    for (const f of DEPENDENCY_FILES) paths.push(relative(repo, join(d, f)) || f);
    if (d === repo || dirname(d) === d) break;
  }
  const diff = git(repo, ['diff', '--name-only', base, '--', ...paths], 30000);
  if (diff.rc !== 0) return { reason: `git diff ${base.slice(0, 7)}: ${diff.stderr.trim().split('\n')[0] || `rc ${diff.rc}`}` };
  const fresh = git(repo, ['ls-files', '--others', '--exclude-standard', '--', ...paths], 30000);
  return diff.stdout.trim().split('\n')[0] || fresh.stdout.trim().split('\n')[0] || null;
}

const blobId = (buf: Buffer, hexLength: number): string => createHash(hexLength === 64 ? 'sha256' : 'sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

/** Committed path → working-tree path: renames git sees, and a plain mv — a file deleted from the commit whose exact
 * content is now an untracked file. */
export function renamesSince(repo: string, base: string): Map<string, string> | { reason: string } {
  const raw = git(repo, ['diff', '--raw', '--no-abbrev', '-z', '-M', base, '--'], 30000);
  if (raw.rc !== 0) return { reason: `git diff ${base.slice(0, 7)}: ${raw.stderr.trim().split('\n')[0] || `rc ${raw.rc}`}` };
  const renames = new Map<string, string>(), deleted = new Map<string, string>();
  const parts = raw.stdout.split('\0');
  for (let i = 0; i < parts.length;) {
    const meta = parts[i++]!;
    if (!meta.startsWith(':')) continue;
    const [, , oldOid, , status] = meta.slice(1).split(' ') as [string, string, string, string, string];
    if (status[0] === 'R' || status[0] === 'C') { const from = parts[i++]!, to = parts[i++]!; if (status[0] === 'R') renames.set(from, to); }
    else { const p = parts[i++]!; if (status === 'D') deleted.set(oldOid, p); }
  }
  if (deleted.size) {
    const untracked = git(repo, ['ls-files', '--others', '--exclude-standard', '-z'], 30000);
    if (untracked.rc !== 0) return { reason: `git ls-files: ${untracked.stderr.trim().split('\n')[0] || `rc ${untracked.rc}`}` };
    const hexLength = [...deleted.keys()][0]!.length;
    for (const p of untracked.stdout.split('\0')) {
      if (!/\.[cm]?[jt]sx?$/.test(p)) continue;
      let buf: Buffer;
      try { buf = readFileSync(join(repo, p)); } catch { continue; }
      const from = deleted.get(blobId(buf, hexLength));
      if (from && !renames.has(from)) renames.set(from, p);
    }
  }
  return renames;
}

type Run = Collected | { transient: 'timeout' | 'unstarted'; reason: string };
let seq = 0;

function diagnose(proj: string, repo: string, commit: string | null, ctx: CheckContext, timeoutMs: number): Run {
  const dir = join(ctx.stateDir, NAME);
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `run-${process.pid}-${++seq}.out`);
  const env = { ...ctx.env, PATH: `${dirname(process.execPath)}:${ctx.env.PATH ?? '/usr/bin:/bin'}`, NODE_OPTIONS: '' };
  try {
    const r = spawnTool('node', ['--disable-warning=ExperimentalWarning', CHILD, proj, repo, out, ...(commit ? [commit] : [])], { cwd: proj, timeoutMs, env });
    if (r.rc === 124) return { transient: 'timeout', reason: 'tsc превысил таймаут' };
    if (r.signal || /heap out of memory|Last few GCs/.test(r.stderr)) return { transient: 'unstarted', reason: `проверка TypeScript оборвана${r.signal ? ` сигналом ${r.signal}` : ': нехватка памяти'}` };
    if (r.rc !== 0) return { ok: false, reason: r.stderr.trim().split('\n')[0] || `rc ${r.rc}` };
    return JSON.parse(readFileSync(out, 'utf8')) as Collected;
  } catch (e) {
    return { ok: false, reason: `ответ проверки TypeScript не прочитан: ${String((e as Error).message).split('\n')[0]}` };
  } finally { rmSync(out, { force: true }); }
}

interface Baseline { format: number; ts: { version: string; dir: string }; counts: Record<string, number>; inputs: Input[] }

function baselinePath(ctx: CheckContext, repo: string, proj: string, commit: string): string {
  return join(ctx.stateDir, NAME, `${createHash('sha256').update(`${FORMAT}\0${repo}\0${proj}\0${commit}`).digest('hex').slice(0, 24)}.json`);
}

function typescriptIdentity(tsDir: string): { version: string; dir: string } | null {
  try { return { version: (JSON.parse(readFileSync(join(tsDir, 'node_modules', 'typescript', 'package.json'), 'utf8')) as { version: string }).version, dir: tsDir }; } catch { return null; }
}

/** A cached baseline is valid for the same compiler and the same disk files it read (node_modules, generated code). */
function readBaseline(p: string, ts: { version: string; dir: string }): Map<string, number> | null {
  let b: Baseline;
  try { b = JSON.parse(readFileSync(p, 'utf8')) as Baseline; } catch { return null; }
  if (b.format !== FORMAT || b.ts?.version !== ts.version || b.ts?.dir !== ts.dir) return null;
  for (const i of b.inputs ?? []) {
    const s = statSync(i.path, { throwIfNoEntry: false });
    if (!s || s.size !== i.size || s.mtimeMs !== i.mtimeMs) return null;
  }
  return new Map(Object.entries(b.counts));
}

function countsOf(diagnostics: Diagnostic[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const d of diagnostics) counts[keyOf(d)] = (counts[keyOf(d)] ?? 0) + 1;
  return counts;
}

function writeBaseline(p: string, c: Extract<Collected, { ok: true }>): void {
  const body: Baseline = { format: FORMAT, ts: c.ts, counts: countsOf(c.diagnostics), inputs: c.inputs };
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(body));
  renameSync(tmp, p);
  try {
    const all = readdirSync(dirname(p)).filter((f) => f.endsWith('.json')).map((f) => {
      const full = join(dirname(p), f);
      return { full, at: statSync(full, { throwIfNoEntry: false })?.mtimeMs ?? 0 };
    });
    if (all.length > KEEP_BASELINES) for (const f of all.sort((a, b) => a.at - b.at).slice(0, all.length - KEEP_BASELINES)) rmSync(f.full, { force: true });
  } catch { return; }
}

interface JobRun { stamp: string; base: string | null; now: Run }

const digestSafe = (abs: string): string => { try { return digestOf(abs); } catch { return 'gone'; } };

/** One working-tree program per project per worker job: another job file of the project reuses it while every job file
 * of that project still has the digest it had when the run started and ended (JobScope), against the same HEAD. */
function workingTree(proj: string, file: ChangedFile, base: string | null, ctx: CheckContext, timeoutMs: number): Run {
  const key = `${NAME}:${proj}`;
  const stamp = (): string => (ctx.job?.files ?? []).filter((f) => tsProject(f) === proj).map((f) => `${f.path}:${digestSafe(f.absPath)}`).join('\n');
  const before = stamp();
  const memo = ctx.job?.memo.get(key) as JobRun | undefined;
  if (memo && memo.stamp === before && memo.base === base) return memo.now;
  const now = diagnose(proj, file.repo, null, ctx, timeoutMs);
  if (ctx.job && stamp() === before) ctx.job.memo.set(key, { stamp: before, base, now });
  return now;
}

const unknownOf = (reason: string, generation?: string, transient?: 'timeout' | 'unstarted'): CheckResult => ({ verdict: 'unknown', missing_reason: reason, ...(transient ? { transient } : {}), ...(generation ? { generation } : {}) });

export async function run(file: ChangedFile, ctx: CheckContext): Promise<CheckResult> {
  const proj = tsProject(file);
  if (!proj) return unknownOf('tsconfig.json не найден');
  const tsDir = projectTypescript(proj, file.repo, ctx.env);
  const ts = tsDir && typescriptIdentity(tsDir);
  if (!ts) {
    const locked = existsSync(join(proj, 'TOOLCHAIN.lock')) ? verifyTypescript(ctx.env, proj) : null;
    return unknownOf(locked && !locked.ok ? locked.reason : 'tsc не установлен в проекте (node_modules отсутствует)');
  }
  const started = ctx.now(), budget = budgetMs(ctx);
  const left = (): number => budget - (ctx.now() - started);

  const h = headOf(file.repo);
  if ('transient' in h) return unknownOf('git rev-parse HEAD превысил таймаут', undefined, 'timeout');
  if ('reason' in h) return unknownOf(h.reason);
  const base = h.commit, generation = base ?? 'none';

  let baseline = new Map<string, number>(), renames = new Map<string, string>(), computed = false;
  if (base) {
    const dep = dependencyChange(file.repo, proj, base);
    if (typeof dep === 'object' && dep) return unknownOf(dep.reason, generation);
    if (dep) return unknownOf(`правка меняет зависимости (${dep}) — база HEAD ${base.slice(0, 7)} на текущих node_modules невоспроизводима`, generation);
    const p = baselinePath(ctx, file.repo, proj, base);
    const cached = readBaseline(p, ts);
    if (cached) baseline = cached;
    else {
      const b = diagnose(proj, file.repo, base, ctx, left());
      if ('transient' in b) return unknownOf(b.reason, generation, b.transient);
      if (!b.ok) return unknownOf(`база HEAD ${base.slice(0, 7)} не посчитана: ${b.reason}`, generation);
      writeBaseline(p, b);
      baseline = new Map(Object.entries(countsOf(b.diagnostics)));
      computed = true;
    }
    const rn = renamesSince(file.repo, base);
    if ('reason' in rn) return unknownOf(rn.reason, generation);
    renames = rn;
  }
  // A baseline paid for in this run is cached: a cut after it is a fresh start, not a timeout of the pair.
  const cut = computed ? 'unstarted' : 'timeout';
  if (left() <= 0) return unknownOf('tsc превысил таймаут', generation, cut);
  const now = workingTree(proj, file, base, ctx, left());
  if ('transient' in now) return unknownOf(now.reason, generation, now.transient === 'timeout' ? cut : 'unstarted');
  if (!now.ok) return unknownOf(now.reason, generation);
  if (base) {
    const again = headOf(file.repo);
    if (!('commit' in again) || again.commit !== base) return unknownOf('HEAD сдвинулся во время проверки', generation, 'unstarted');
  }

  const fresh = newErrors(baseline, now.diagnostics, renames);
  if (!fresh.length) return { verdict: 'pass', generation };
  const against = base ? `против HEAD ${base.slice(0, 7)}` : 'коммитов нет, база пуста';
  const listed = fresh.slice(0, SHOWN).map((d) => d.display).join('\n');
  return { verdict: 'fail', message: `${file.path}: tsc — новых ошибок ${fresh.length} ${against}\n${listed}`.slice(0, 4096), generation };
}

registerChecker({ name: NAME, tier: 'worker', killSwitch: 'CLAUDE_SKIP_CHECK', applies, run, budgetMs, inputGeneration: (repo) => head(repo) ?? 'none', runsCheckoutCode: true });
