// Runs the agent's autonomous jobs on a schedule. Every run is recorded in job_runs (what ran, when, what it
// found), and a Postgres advisory lock keeps a job from overlapping itself, even across replicas.
import type { Db } from "../db/pool.js";

export interface JobResult {
  summary: string;
  ok?: boolean; // default true
  detail?: unknown;
}

export interface JobDef {
  name: string;
  /** Plain description for the /agent page. */
  title: string;
  everyMs: number;
  /** Needs the `baw` CLI signed in on this host (buys, keepalive). */
  needsBaw?: boolean;
  run(db: Db): Promise<JobResult>;
}

export interface JobRun {
  job: string;
  startedAt: Date;
  finishedAt: Date | null;
  ok: boolean | null;
  summary: string | null;
  detail: unknown;
}

const lockKey = (name: string) => `sharesend:job:${name}`;

/** Runs a job once unless another run of it holds the lock. Never throws: failures are recorded as runs. */
export async function runJobOnce(db: Db, job: JobDef): Promise<JobRun | "busy"> {
  const c = await db.connect();
  try {
    const got = await c.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS ok", [lockKey(job.name)]);
    if (!got.rows[0]?.ok) return "busy";
    try {
      const { rows } = await db.query<{ id: string; started_at: Date }>("INSERT INTO job_runs (job) VALUES ($1) RETURNING id, started_at", [job.name]);
      const id = rows[0]!.id;
      let result: JobResult;
      try {
        result = await job.run(db);
      } catch (e) {
        result = { ok: false, summary: `failed: ${(e as Error).message}`.slice(0, 500) };
      }
      const ok = result.ok ?? true;
      await db.query("UPDATE job_runs SET finished_at = now(), ok = $2, summary = $3, detail = $4 WHERE id = $1", [
        id,
        ok,
        result.summary,
        result.detail === undefined ? null : JSON.stringify(result.detail),
      ]);
      return { job: job.name, startedAt: rows[0]!.started_at, finishedAt: new Date(), ok, summary: result.summary, detail: result.detail ?? null };
    } finally {
      await c.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey(job.name)]);
    }
  } finally {
    c.release();
  }
}

/** Latest finished run per job, plus the previous one (for "did anything change" checks). */
export async function recentRuns(db: Db, job: string, n = 2): Promise<JobRun[]> {
  const { rows } = await db.query(
    "SELECT job, started_at, finished_at, ok, summary, detail FROM job_runs WHERE job = $1 AND finished_at IS NOT NULL ORDER BY started_at DESC LIMIT $2",
    [job, n],
  );
  return rows.map((r) => ({ job: r.job, startedAt: r.started_at, finishedAt: r.finished_at, ok: r.ok, summary: r.summary, detail: r.detail }));
}

export async function latestRuns(db: Db): Promise<Record<string, JobRun & { runsLastDay: number; failuresLastDay: number }>> {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (job) job, started_at, finished_at, ok, summary, detail,
       (SELECT count(*) FROM job_runs r2 WHERE r2.job = r.job AND r2.started_at > now() - interval '1 day') AS runs_day,
       (SELECT count(*) FROM job_runs r2 WHERE r2.job = r.job AND r2.started_at > now() - interval '1 day' AND r2.ok = false) AS fails_day
     FROM job_runs r WHERE finished_at IS NOT NULL ORDER BY job, started_at DESC`,
  );
  return Object.fromEntries(
    rows.map((r) => [
      r.job,
      { job: r.job, startedAt: r.started_at, finishedAt: r.finished_at, ok: r.ok, summary: r.summary, detail: r.detail, runsLastDay: Number(r.runs_day), failuresLastDay: Number(r.fails_day) },
    ]),
  );
}

/** Keeps the run log small: the last `keep` runs per job. */
export async function pruneRuns(db: Db, keep = 500): Promise<void> {
  await db.query(
    `DELETE FROM job_runs WHERE id IN (
       SELECT id FROM (SELECT id, row_number() OVER (PARTITION BY job ORDER BY started_at DESC) AS n FROM job_runs) x WHERE n > $1)`,
    [keep],
  );
}

export interface Scheduler {
  stop(): void;
  jobs: { name: string; title: string; everyMs: number; enabled: boolean; reason?: string }[];
}

/** Starts every job on its interval (staggered start). Jobs needing `baw` are skipped unless `bawEnabled`. */
export function startScheduler(db: Db, jobs: JobDef[], opts: { bawEnabled: boolean; log?: (m: string) => void }): Scheduler {
  const log = opts.log ?? ((m: string) => console.log(m));
  const timers: ReturnType<typeof setTimeout>[] = [];
  let stopped = false;
  const listed = jobs.map((j) => ({
    name: j.name,
    title: j.title,
    everyMs: j.everyMs,
    enabled: !j.needsBaw || opts.bawEnabled,
    reason: j.needsBaw && !opts.bawEnabled ? "needs the Agentic Wallet CLI on this host (AUTO_EXECUTE=true)" : undefined,
  }));

  jobs.forEach((job, i) => {
    if (job.needsBaw && !opts.bawEnabled) return;
    const tick = async () => {
      if (stopped) return;
      const r = await runJobOnce(db, job).catch((e) => {
        log(`job ${job.name}: runner error: ${(e as Error).message}`);
        return null;
      });
      if (r && r !== "busy" && !r.ok) log(`job ${job.name}: ${r.summary}`);
      if (!stopped) timers.push(setTimeout(tick, job.everyMs));
    };
    timers.push(setTimeout(tick, 5_000 + i * 3_000));
  });
  timers.push(setInterval(() => pruneRuns(db).catch(() => {}), 6 * 3_600_000) as unknown as ReturnType<typeof setTimeout>);

  return {
    jobs: listed,
    stop() {
      stopped = true;
      timers.forEach((t) => clearTimeout(t));
    },
  };
}
