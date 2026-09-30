// Worker tier: the contour test set (harness/test/**/*.test.ts plus the node and python tests of portable/) is required
// on a change to harness/**, hooks/**, portable/**, bin/brain, settings.json and .claude/check.sh of the contour repo.
// The verdict is cached by the content generation; the positive control is more than zero tests executed.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, type Stats } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { spawnTool } from '../platform.ts';
import { registerChecker } from './registry.ts';
import type { ChangedFile, CheckContext, CheckResult } from './types.ts';

export const NAME = 'contour-suite';
export const KILL = 'CLAUDE_SKIP_CONTOUR_SUITE';
const WATCHED = /^(harness\/|hooks\/|portable\/|bin\/brain$|settings\.json$|\.claude\/check\.sh$)/;
const SUITE_TIMEOUT_MS = 10 * 60 * 1000;
/** A run cut with less than this share of the budget left is no timeout of the suite: the lock wait or re-runs of a
 * moving tree ate the budget, and a fresh one can finish it — such a cut is unstarted, and the pair is queued again. */
const REAL_TIMEOUT_SHARE = 0.9;

const LOCK_STALE_MS = 15 * 60 * 1000;
// Everything the suite reads, not only what triggers it: a change here must move the generation or a cached pass lies.
const INPUTS = ['harness', 'hooks', 'settings.json', '.claude/check.sh', '.claude/settings.json', '.claude/bin', 'graph', 'skills', 'bin', 'mcp',
  'scripts', 'specs/schedule.json', 'portable'];

export function isContourRepo(repo: string): boolean {
  return existsSync(join(repo, 'harness', 'bin', 'hook')) && existsSync(join(repo, 'harness', 'src', 'main.ts'));
}

export function applies(file: ChangedFile): boolean {
  if (process.env[KILL] === '1') return false;
  return file.status !== 'D' && WATCHED.test(file.path) && isContourRepo(file.repo);
}

/** Visits every file and directory of the suite inputs, a directory before its entries; vanished paths are skipped. */
function walkInputs(repo: string, visit: (rel: string, st: Stats, abs: string) => void): void {
  const walk = (rel: string): void => {
    const abs = join(repo, rel);
    let st: Stats; try { st = statSync(abs); } catch { return; }
    visit(rel, st, abs);
    if (!st.isDirectory()) return;
    let names: string[]; try { names = readdirSync(abs).sort(); } catch { return; }
    for (const n of names) if (n !== 'node_modules' && n !== '.git') walk(join(rel, n));
  };
  for (const rel of INPUTS) walk(rel);
}

export function suiteGeneration(repo: string): string {
  const h = createHash('sha256');
  walkInputs(repo, (rel, st, abs) => {
    if (st.isDirectory()) return;
    let body: Buffer; try { body = readFileSync(abs); } catch { return; }
    h.update(rel); h.update(body);
  });
  return h.digest('hex').slice(0, 16);
}

/** Path, mtime and size of every input file and directory: an edit made and undone during a run changes it although the
 * content is back, and an input dated in the future does not, since only a change between two stamps counts. */
function inputStamp(repo: string): string {
  const h = createHash('sha256');
  walkInputs(repo, (rel, st) => { h.update(`${rel}\0${st.mtimeMs}\0${st.size}\n`); });
  return h.digest('hex');
}

// The Codex adapter and the launcher live outside harness/; their tests run with the suite whenever they exist.
function portableTests(repo: string): { node: boolean; python: boolean } {
  let names: string[] = [];
  try { names = readdirSync(join(repo, 'portable')); } catch { /* no portable/ */ }
  return { node: names.some((n) => n.endsWith('.test.ts')), python: names.some((n) => /^test_.*\.py$/.test(n)) };
}

export function parseNodeTestSummary(out: string): { tests: number; fail: number; failed: string[] } {
  const num = (key: string): number => Number(new RegExp(`^ℹ ${key} (\\d+)$`, 'm').exec(out)?.[1] ?? Number.NaN);
  const failed = [...new Set([...out.matchAll(/^\s*✖ (.+?) \([\d.]+ms\)$/gm)].map((m) => m[1]))];
  return { tests: num('tests'), fail: num('fail'), failed };
}

export function execute(repo: string, ctx: CheckContext, timeoutMs = SUITE_TIMEOUT_MS): CheckResult {
  const env = { ...ctx.env, PATH: `${dirname(process.execPath)}:${ctx.env.PATH ?? '/usr/bin:/bin'}`, [KILL]: '1' };
  const portable = portableTests(repo);
  const node = spawnTool('node', ['--disable-warning=ExperimentalWarning', '--test', '--test-reporter=spec', '--test-concurrency=2', 'harness/test/**/*.test.ts',
    ...(portable.node ? ['portable/*.test.ts'] : [])], { cwd: repo, timeoutMs: Math.max(1000, timeoutMs), env });
  if (node.rc === 124) return { verdict: 'unknown', missing_reason: 'набор харнесса превысил таймаут', transient: 'timeout' };
  const s = parseNodeTestSummary(`${node.stdout}\n${node.stderr}`);
  // Замороженные bash-спеки hooks/spec не запускаются: хуки портированы на TS, а спеки держат macOS-семантику
  // (mktemp -t) и в Linux красны по построению; решение 16.09 — отключить, лок BASH_FROZEN держит их неизменными.
  const problems: string[] = [];
  const shown = (n: number): string => (Number.isNaN(n) ? '?' : String(n));
  if (!(s.tests > 0)) problems.push(`набор харнесса исполнил 0 тестов (rc ${node.rc}) — зелёным это не считается`);
  else if (s.fail > 0 || node.rc !== 0) problems.push(`харнесс: красные ${shown(s.fail)} из ${shown(s.tests)}${s.failed.length ? `: ${s.failed.slice(0, 8).join('; ')}` : ''}`);

  if (portable.python) {
    const py = spawnTool('python3', ['-m', 'unittest', 'discover', '-s', 'portable', '-p', 'test_*.py'], { cwd: repo, timeoutMs: Math.max(1000, timeoutMs), env });
    const red = [...new Set([...`${py.stdout}\n${py.stderr}`.matchAll(/^(?:FAIL|ERROR): (\S+)/gm)].map((m) => m[1]))];
    if (py.rc !== 0) problems.push(`portable (python): rc ${py.rc}${red.length ? `: ${red.slice(0, 8).join(', ')}` : ''}`);
  }

  if (problems.length) return { verdict: 'fail', message: `контур: ${problems.join(' · ')}`.slice(0, 4096) };
  return { verdict: 'pass' };
}

interface Cached { gen: string; verdict: 'pass' | 'fail'; message?: string; at: number }

function cachePath(stateDir: string, repo: string): string {
  return join(stateDir, NAME, `${createHash('sha256').update(repo).digest('hex').slice(0, 16)}.json`);
}
function readCache(p: string, gen: string): CheckResult | null {
  try {
    const c = JSON.parse(readFileSync(p, 'utf8')) as Cached;
    if (c.gen !== gen) return null;
    return c.verdict === 'pass' ? { verdict: 'pass' } : { verdict: 'fail', message: c.message };
  } catch { return null; }
}

/** Takes the lock directory and records this process as its holder beside it: the directory stays empty, so a harness
 * that knows only rmdir can still remove a stale one after a rollback. false — another run holds it. */
function tryLock(lock: string): boolean {
  try { mkdirSync(lock); } catch { return false; }
  try { writeFileSync(`${lock}.pid`, String(process.pid)); } catch { return true; }
  return true;
}

/** The run that took the lock died without releasing it: the pid it recorded no longer exists. Only a record written
 * after the lock was made counts — an older one is left by an earlier holder, maybe beside a live lock of an older harness. */
function holderGone(lock: string): boolean {
  let pid: number;
  try {
    if (statSync(`${lock}.pid`).mtimeMs < statSync(lock).mtimeMs) return false;
    pid = Number(readFileSync(`${lock}.pid`, 'utf8'));
  } catch { return false; }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH'; }
}

/** The holder record goes first: a lock left without it waits for the stale rule instead of naming a wrong holder. */
function unlock(lock: string): void {
  rmSync(`${lock}.pid`, { force: true });
  rmSync(lock, { recursive: true, force: true });
}

/** A verdict is cached only for a tree the run saw unchanged from start to end: the same generation and the same input
 * stamp before and after it. */
export async function run(file: ChangedFile, ctx: CheckContext): Promise<CheckResult> {
  const cp = cachePath(ctx.stateDir, file.repo);
  let gen = '';
  const settled = (): CheckResult | null => { gen = suiteGeneration(file.repo); const c = readCache(cp, gen); return c && { ...c, generation: gen }; };
  const hit = settled();
  if (hit) return hit;
  mkdirSync(dirname(cp), { recursive: true });
  const lock = `${cp}.lock`;
  const started = ctx.now();
  const budget = Math.min(SUITE_TIMEOUT_MS, ctx.deadlineMs);
  for (;;) {
    if (tryLock(lock)) break;
    let age = 0;
    try { age = ctx.now() - statSync(lock).mtimeMs; } catch { continue; }
    if (age > LOCK_STALE_MS || holderGone(lock)) { unlock(lock); continue; }
    if (ctx.now() - started > budget) return { verdict: 'unknown', missing_reason: 'набор контура прогоняет другой воркер дольше таймаута', transient: 'unstarted' };
    await new Promise((r) => setTimeout(r, 2000));
    const done = settled();
    if (done) return done;
  }
  try {
    for (;;) {
      const done = settled();
      if (done) return done;
      const ran = gen;
      const stamp = inputStamp(file.repo);
      const left = budget - (ctx.now() - started);
      const r = execute(file.repo, ctx, left);
      if (suiteGeneration(file.repo) === ran && inputStamp(file.repo) === stamp) {
        if (r.transient === 'timeout' && left < budget * REAL_TIMEOUT_SHARE) return { verdict: 'unknown', missing_reason: 'бюджет прогона съели ожидание замка и перезапуски на меняющемся дереве', transient: 'unstarted', generation: ran };
        if (r.verdict !== 'unknown') writeFileSync(cp, JSON.stringify({ gen: ran, verdict: r.verdict, message: r.message, at: ctx.now() } satisfies Cached));
        return { ...r, generation: ran };
      }
      if (r.verdict === 'unknown' || ctx.now() - started > budget) return { verdict: 'unknown', missing_reason: 'дерево контура менялось во время прогона набора', transient: 'unstarted', generation: ran };
    }
  } finally { unlock(lock); }
}

registerChecker({ name: NAME, tier: 'worker', killSwitch: KILL, applies, run, budgetMs: () => SUITE_TIMEOUT_MS, inputGeneration: suiteGeneration });
