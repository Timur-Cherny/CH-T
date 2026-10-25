// Who holds a background job: a live worker, a worker still starting, or nobody. The worker, the sweep and the Stop
// drain decide it here, so a job is never run by two processes and never left without one.

/** The worker renews started_at before each file, so the TTL bounds one check (at most 10 min), not a whole job. */
export const JOB_TTL_MS = 15 * 60 * 1000;
/** A job claimed this long ago whose worker never recorded a pid is orphaned: whoever needs it next claims it again. */
export const ORPHAN_CLAIM_MS = 5000;

export interface JobHold { status: string; pid: number | null; started_at: number }

export function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

/** A worker runs the job under a live pid, and its last heartbeat is within the TTL. */
export function running(job: JobHold, now: number): boolean {
  return job.status === 'running' && job.pid !== null && alive(job.pid) && now - job.started_at < JOB_TTL_MS;
}

/** Someone holds the job: a worker runs it, or it was claimed or last touched less than ORPHAN_CLAIM_MS ago — a worker
 * still starting, or one that just died, which is replaced no faster than once per ORPHAN_CLAIM_MS. */
export function held(job: JobHold, now: number): boolean {
  return running(job, now) || ((job.status === 'claimed' || job.status === 'running') && now - job.started_at < ORPHAN_CLAIM_MS);
}
