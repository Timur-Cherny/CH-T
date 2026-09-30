// Detached worker of the expensive checks. It takes a job by job_id and reads kill-switches from the job row (the
// enqueuer's env), not from its own environment; who holds a job is decided in hold.ts; results go to
// verified/findings for the next event of the session, or for the Stop that waits on this worker.
import os from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../checks/index.ts';
import { CHECKERS } from '../checks/registry.ts';
import { State, resolveStateDir } from '../state.ts';
import { generation } from '../contour.ts';
import { digestOf, recordResult, spawnWorker, verdictGeneration } from '../sweep.ts';
import { held, running, type JobHold } from './hold.ts';
import type { ChangedFile } from '../checks/types.ts';
import { isMainModule } from '../is-main.ts';

const DRAIN_POLL_MS = 250;

interface JobRow extends JobHold { repo: string; kind: string; skips: string }
const readJob = (state: State, jobId: string): JobRow | undefined => state.db.prepare('SELECT repo, kind, status, skips, pid, started_at FROM jobs WHERE job_id = ?').get(jobId) as JobRow | undefined;

/** The worker: takes the job unless a live worker runs it — a compare-and-set on the row as read, so of two workers
 * spawned for one job one runs it — and checks every file of it without a deadline of its own. It renews its heartbeat
 * before each file and stops, without closing the job, once the row is no longer its own. */
export async function runJob(state: State, jobId: string, env: NodeJS.ProcessEnv, root: string, now: () => number = Date.now): Promise<'done' | 'failed' | 'missing' | 'taken'> {
  const job = readJob(state, jobId);
  if (!job) return 'missing';
  if (job.status === 'done') return 'done';
  if (running(job, now())) return 'taken';
  const took = state.db.prepare("UPDATE jobs SET status = 'running', pid = ?, started_at = ? WHERE job_id = ? AND status = ? AND pid IS ? AND started_at = ?").run(process.pid, now(), jobId, job.status, job.pid, job.started_at);
  if (Number(took.changes) !== 1) return 'taken';
  const skips: string[] = JSON.parse(job.skips || '[]');
  const checker = CHECKERS.find((c) => c.name === job.kind);
  const gen = generation(root);
  const files = state.db.prepare('SELECT path, digest FROM job_files WHERE job_id = ?').all(jobId) as Array<{ path: string; digest: string }>;
  let rc = 0;
  const beat = state.db.prepare("UPDATE jobs SET started_at = ? WHERE job_id = ? AND status = 'running' AND pid = ?");
  for (const f of files) {
    if (Number(beat.run(now(), jobId, process.pid).changes) !== 1) return 'taken';
    const abs = join(job.repo, f.path);
    if (!existsSync(abs)) continue;
    let digest: string; try { digest = digestOf(abs); } catch { continue; }
    if (digest !== f.digest) continue; // файл ушёл дальше — его проверит следующая сверка
    const file: ChangedFile = { repo: job.repo, path: f.path, absPath: abs, digest, status: 'M' };
    if (!checker) { recordResult(state, file, job.kind, gen, { verdict: 'unknown', missing_reason: `проверка ${job.kind} не зарегистрирована в этом поколении` }, now()); rc = 1; continue; }
    if (skips.includes(checker.killSwitch)) continue;
    const cctx = { env, stateDir: state.dir, now, deadlineMs: Infinity };
    let r; try { r = await checker.run(file, cctx); } catch (e) { r = { verdict: 'unknown' as const, missing_reason: (e as Error).message.split('\n')[0] }; }
    // Файл мог измениться, пока шла проверка: перехэшировать и выбросить вердикт при сдвиге — иначе pass по новому
    // содержимому лёг бы в verified под старым digest, и вернувшееся старое (сломанное) прошло бы как подтверждённое
    // (I1, P3 25.09). Следующая сверка увидит непроверенный digest и перезапустит.
    let post: string; try { post = digestOf(abs); } catch { continue; }
    if (post !== f.digest) continue;
    if (r.verdict !== 'pass') rc = 1;
    recordResult(state, file, checker.name, verdictGeneration(gen, checker, job.repo, r.generation), r, now(), checker.budgetMs?.(cctx) ?? Infinity);
  }
  const closed = state.db.prepare("UPDATE jobs SET status = 'done', finished_at = ?, rc = ? WHERE job_id = ? AND status = 'running' AND pid = ?").run(now(), rc, jobId, process.pid);
  if (Number(closed.changes) !== 1) return 'taken';
  return rc === 0 ? 'done' : 'failed';
}

/** The Stop drain: waits until the job is done or the window ends, and never runs it in the Stop process. A job nobody
 * holds is claimed again (compare-and-set on the row as read) for a new worker, which goes on after the window, so the
 * next Stop, of this session or another, waits for the same run instead of starting it over. */
export async function awaitJob(state: State, jobId: string, env: NodeJS.ProcessEnv, root: string, now: () => number, deadlineMs: number): Promise<'done' | 'missing' | 'taken'> {
  const until = now() + deadlineMs;
  for (;;) {
    const job = readJob(state, jobId);
    if (!job) return 'missing';
    if (job.status !== 'claimed' && job.status !== 'running') return 'done';
    if (!held(job, now())) {
      const took = state.db.prepare("UPDATE jobs SET status = 'claimed', pid = NULL, started_at = ? WHERE job_id = ? AND status = ? AND pid IS ? AND started_at = ?").run(now(), jobId, job.status, job.pid, job.started_at);
      if (Number(took.changes) === 1) spawnWorker(root, jobId, env, state.dir);
    }
    if (now() >= until) return 'taken';
    await new Promise((r) => setTimeout(r, Math.min(DRAIN_POLL_MS, until - now())));
  }
}

/** Jobs of the repo not finished yet; awaitJob decides whether a worker still holds each. */
export function pendingJobs(state: State, repo: string): string[] {
  return (state.db.prepare("SELECT job_id FROM jobs WHERE repo = ? AND status IN ('claimed','running')").all(repo) as Array<{ job_id: string }>).map((r) => r.job_id);
}

if (isMainModule(import.meta.url)) {
  try { os.setPriority(19); } catch { /* не критично */ }
  const stateDir = resolveStateDir(process.env);
  const root = process.env.HARNESS_ROOT ?? fileURLToPath(new URL('../..', import.meta.url));
  const state = State.open(stateDir);
  runJob(state, process.argv[2] ?? '', process.env, root).then((r) => { state.close(); process.exit(r === 'failed' ? 1 : 0); }, () => { state.close(); process.exit(1); });
}
