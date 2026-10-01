import { DB, one, run, tx } from "./db.js";
import { id, now, json } from "./util.js";

export interface Job {
  id: string; workspace_id: string; brand_id: string | null; type: string; status: string;
  idempotency_key: string; payload: any; progress: any; attempts: number; max_attempts: number;
  cancel_requested: number; created_by: string | null;
}
export interface JobContext {
  db: DB;
  job: Job;
  progress(p: Record<string, unknown>): void;
  heartbeat(): void;
  cancelled(): boolean;
}
export type Handler = (ctx: JobContext) => Promise<void>;

const LEASE_MS = 120_000;
const handlers = new Map<string, Handler>();
const failureHooks = new Map<string, (db: DB, job: Job, err: Error) => void>();
export function registerHandler(type: string, h: Handler, onFinalFailure?: (db: DB, job: Job, err: Error) => void) {
  handlers.set(type, h);
  if (onFinalFailure) failureHooks.set(type, onFinalFailure);
}

const hydrate = (r: any): Job => ({ ...r, payload: json(r.payload_json, {}), progress: json(r.progress_json, {}) });

/** Enqueue once per idempotency key. A repeated call returns the existing job instead of creating a duplicate. */
export function enqueue(db: DB, j: { workspaceId: string; brandId?: string | null; type: string; key: string; payload?: any; createdBy?: string | null; maxAttempts?: number; runAfter?: string }) {
  const t = now();
  run(db, `INSERT INTO jobs (id, workspace_id, brand_id, type, status, idempotency_key, payload_json, max_attempts, run_after, created_by, created_at, updated_at)
           VALUES (?,?,?,?, 'queued', ?,?,?,?,?,?,?) ON CONFLICT(idempotency_key) DO NOTHING`,
    id(), j.workspaceId, j.brandId ?? null, j.type, j.key, JSON.stringify(j.payload ?? {}), j.maxAttempts ?? 3, j.runAfter ?? t, j.createdBy ?? null, t, t);
  return hydrate(one(db, "SELECT * FROM jobs WHERE idempotency_key = ?", j.key));
}

/** Atomically claim one runnable job. Expired leases (crashed workers) are reclaimable. */
export function claim(db: DB, workerId: string): Job | null {
  return tx(db, () => {
    const t = now();
    const row = one<any>(db, `SELECT * FROM jobs
      WHERE (status = 'queued' AND run_after <= ?) OR (status = 'running' AND lease_expires_at < ?)
      ORDER BY created_at LIMIT 1`, t, t);
    if (!row) return null;
    if (row.cancel_requested) {
      run(db, "UPDATE jobs SET status='cancelled', locked_by=NULL, updated_at=? WHERE id=?", t, row.id);
      return null;
    }
    const lease = new Date(Date.now() + LEASE_MS).toISOString();
    const r = run(db, `UPDATE jobs SET status='running', locked_by=?, lease_expires_at=?, attempts=attempts+1, updated_at=?
      WHERE id=? AND (status='queued' OR (status='running' AND lease_expires_at < ?))`, workerId, lease, t, row.id, t);
    if (r.changes !== 1) return null;
    return hydrate(one(db, "SELECT * FROM jobs WHERE id=?", row.id));
  });
}

export async function runJob(db: DB, job: Job, workerId: string) {
  const h = handlers.get(job.type);
  const stillMine = () => one<any>(db, "SELECT locked_by, cancel_requested FROM jobs WHERE id=?", job.id);
  const ctx: JobContext = {
    db, job,
    progress: p => { job.progress = { ...job.progress, ...p }; run(db, "UPDATE jobs SET progress_json=?, updated_at=? WHERE id=? AND locked_by=?", JSON.stringify(job.progress), now(), job.id, workerId); },
    heartbeat: () => run(db, "UPDATE jobs SET lease_expires_at=? WHERE id=? AND locked_by=?", new Date(Date.now() + LEASE_MS).toISOString(), job.id, workerId),
    cancelled: () => Boolean(stillMine()?.cancel_requested)
  };
  try {
    if (!h) throw new Error(`No handler for job type ${job.type}`);
    await h(ctx);
    const final = ctx.cancelled() ? "cancelled" : "succeeded";
    run(db, "UPDATE jobs SET status=?, locked_by=NULL, lease_expires_at=NULL, last_error=NULL, updated_at=? WHERE id=? AND locked_by=?", final, now(), job.id, workerId);
  } catch (err: any) {
    const message = String(err?.message || err).slice(0, 1000);
    const permanent = err?.permanent === true || (err?.status && err.status < 500 && err.status !== 429);
    if (!permanent && job.attempts < job.max_attempts && !ctx.cancelled()) {
      const backoff = new Date(Date.now() + Math.min(60_000, 2000 * 2 ** job.attempts)).toISOString();
      run(db, "UPDATE jobs SET status='queued', locked_by=NULL, lease_expires_at=NULL, run_after=?, last_error=?, updated_at=? WHERE id=? AND locked_by=?", backoff, message, now(), job.id, workerId);
    } else {
      run(db, "UPDATE jobs SET status=?, locked_by=NULL, lease_expires_at=NULL, last_error=?, updated_at=? WHERE id=? AND locked_by=?", ctx.cancelled() ? "cancelled" : "failed", message, now(), job.id, workerId);
      try { failureHooks.get(job.type)?.(db, job, err); } catch (e) { console.error("failure hook error", e); }
    }
  }
}

export function requestCancel(db: DB, jobIds: string[]) {
  const t = now();
  for (const j of jobIds) {
    run(db, "UPDATE jobs SET cancel_requested=1, updated_at=? WHERE id=?", t, j);
    run(db, "UPDATE jobs SET status='cancelled', updated_at=? WHERE id=? AND status='queued'", t, j);
  }
}

export function startWorker(db: DB, workerId = `worker-${process.pid}-${id().slice(0, 6)}`, intervalMs = 1000) {
  let stopped = false, busy = false;
  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      for (let i = 0; i < 5; i++) {
        const job = claim(db, workerId);
        if (!job) break;
        await runJob(db, job, workerId);
      }
    } catch (e) { console.error("worker tick failed", e); }
    finally { busy = false; }
  };
  const timer = setInterval(tick, intervalMs);
  tick();
  return { stop: () => { stopped = true; clearInterval(timer); }, workerId };
}
