/**
 * Recovery janitor for report exports orphaned by a hard worker death.
 *
 * Job-level failures self-heal via the worker `failed` event + the in-job
 * catch. A `kill -9` / OOM emits no `failed` event, and BullMQ's own stalled
 * recovery re-delivers the job — but the queue's idempotency guard (only
 * `queued` rows run) makes that re-delivery a no-op, so the row would sit
 * `running` forever. A scheduled sweep closes that gap.
 *
 * The two states age at different rates, and neither is decided by age alone.
 *
 * A `running` row is set once, at the start of a fill that legitimately runs
 * for a long time: a large view draws a metered AI draft per contract and
 * nothing heartbeats the row, so its `updated_at` says when the work started,
 * not whether it is still going. Age therefore only nominates a candidate; the
 * queue settles it. A job still `active` is a worker mid-fill and the row is
 * left alone. Only a job the queue no longer has, or one it has already
 * finished, proves the row outlived its worker.
 *
 * A `queued` row is still processable — its job persists in the queue across
 * restarts, and the reconciler hands it back whenever no job owns it — so
 * failing it on the short threshold would kill a backlogged-but-alive export.
 * A queued row still sitting after a day has outlived every requeue the
 * reconciler could give it; a day of silence is the conservative proxy, far
 * beyond any real backlog at the worker's concurrency.
 *
 * Owner-level, cross-workspace DB access lives here (a narrow lib helper) so the
 * report handler slice never imports the RLS-exempt root db directly, mirroring
 * the workflow orphan reconciler.
 */

import { Result } from "better-result";
import { and, asc, eq, inArray, lt } from "drizzle-orm";

import { DAY_IN_MS } from "@stll/time";

import { rootDb } from "@/api/db/root";
import type { ReportExportStatus } from "@/api/db/schema";
import { reportExports } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import { withTimeout } from "@/api/lib/with-timeout";

/** A `running` row this old lost its worker to a hard death. */
const STUCK_RUNNING_MS = 30 * 60 * 1000;
/** A `queued` row this old lost its job to queue data loss; anything younger
 *  may simply be backlogged and must be left for the worker.
 *  Fixed-duration threshold, not calendar math — `addDays` would make the
 *  threshold drift across a DST transition. */
const STUCK_QUEUED_MS = DAY_IN_MS;
const STUCK_EXPORT_ERROR =
  "Report export did not complete in time and was marked failed. Please try again.";

/**
 * Rows the janitor inspects per tick. A `running` export past its cutoff is an
 * exceptional population, and each one costs a queue lookup, so the sweep
 * takes a bounded batch and leaves any remainder for the next tick.
 */
const STUCK_RUNNING_SCAN_MAX = 25;

/** Deadline on one queue command, matching the bound the handoffs use: an
 *  unanswered lookup must not hold the whole tick. */
const QUEUE_OPERATION_TIMEOUT_MS = 2000;

/**
 * Whether an export row is old enough to be *considered* abandoned. Pure so
 * the per-status staleness thresholds are unit-testable;
 * {@link recoverStuckReportExports} mirrors this in SQL. For `running` rows it
 * is a nomination, not a verdict: age alone cannot tell a dead worker from a
 * long fill, so the queue decides those.
 */
export const isStuckReportExport = (
  row: { status: ReportExportStatus; updatedAt: Date },
  now: Date,
): boolean => {
  const age = now.getTime() - row.updatedAt.getTime();
  if (row.status === "running") {
    return age > STUCK_RUNNING_MS;
  }
  if (row.status === "queued") {
    return age > STUCK_QUEUED_MS;
  }
  return false;
};

/** The queue surface the janitor needs to tell a live fill from a dead one,
 *  structural so a test can pass a plain fake. */
export type StuckExportJobQueue = {
  getJob: (
    jobId: string,
  ) => Promise<{ getState: () => Promise<string> } | null | undefined>;
};

type RecoverStuckReportExportsOptions = {
  db?: Pick<typeof rootDb, "select" | "update">;
  now?: Date;
  queue: StuckExportJobQueue;
};

/** BullMQ states a job is finished in. Anything else is work in progress. */
const TERMINAL_JOB_STATES = new Set(["completed", "failed"]);

/**
 * Whether the queue has stopped driving this export.
 *
 * Only a job that is absent, or one the queue has already finished, proves the
 * row outlived its worker. A lookup that errors or never answers proves
 * nothing, so the row is left for the next tick: failing a healthy export and
 * emailing its requester is far worse than recovering it five minutes later.
 */
const hasLostItsJob = async (
  queue: StuckExportJobQueue,
  jobId: string,
): Promise<boolean> => {
  const inspected = await Result.tryPromise({
    try: async () =>
      await withTimeout(
        async () => {
          const job = await queue.getJob(jobId);
          return job === null || job === undefined
            ? null
            : await job.getState();
        },
        {
          label: "report-export-janitor.get-job",
          timeoutMs: QUEUE_OPERATION_TIMEOUT_MS,
        },
      ),
    catch: (cause) => cause,
  });
  if (Result.isError(inspected)) {
    captureError(inspected.error, { jobId });
    return false;
  }
  return inspected.value === null || TERMINAL_JOB_STATES.has(inspected.value);
};

/**
 * Janitor: mark every abandoned export failed. Runs cross-workspace via
 * `rootDb` (RLS-exempt internal infrastructure, like the workflow orphan
 * reconciler). Idempotent and safe to call repeatedly. Returns how many rows
 * it recovered.
 */
export const recoverStuckReportExports = async ({
  db = rootDb,
  now = new Date(),
  queue,
}: RecoverStuckReportExportsOptions): Promise<number> => {
  const runningCutoff = new Date(now.getTime() - STUCK_RUNNING_MS);
  const queuedCutoff = new Date(now.getTime() - STUCK_QUEUED_MS);

  // audit: skip — janitor bookkeeping on already-audited export rows; flips
  // abandoned exports to failed so the status endpoint can surface them
  // instead of polling a stuck row forever.
  const recoveredQueued = await db
    .update(reportExports)
    .set({ status: "failed", error: STUCK_EXPORT_ERROR })
    .where(
      and(
        eq(reportExports.status, "queued"),
        // oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison -- cutoff read from the caller's clock, never round-tripped through the database
        lt(reportExports.updatedAt, queuedCutoff),
      ),
    )
    .returning({ id: reportExports.id });

  const runningCandidates = await db
    .select({
      id: reportExports.id,
      workspaceId: reportExports.workspaceId,
    })
    .from(reportExports)
    .where(
      and(
        eq(reportExports.status, "running"),
        // oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison -- cutoff read from the caller's clock, never round-tripped through the database
        lt(reportExports.updatedAt, runningCutoff),
      ),
    )
    .orderBy(asc(reportExports.updatedAt), asc(reportExports.id))
    .limit(STUCK_RUNNING_SCAN_MAX);

  const verdicts = await Promise.all(
    runningCandidates.map(
      async (row) =>
        await hasLostItsJob(queue, createBullMqJobId(row.workspaceId, row.id)),
    ),
  );
  const abandoned = runningCandidates
    .filter((_, index) => verdicts.at(index) === true)
    .map(({ id }) => id);
  if (abandoned.length === 0) {
    return recoveredQueued.length;
  }

  // Still guarded on `running`: the queue lookups above are the window in
  // which the worker can finish and write its own terminal state.
  const recoveredRunning = await db
    .update(reportExports)
    .set({ status: "failed", error: STUCK_EXPORT_ERROR })
    .where(
      and(
        inArray(reportExports.id, abandoned),
        eq(reportExports.status, "running"),
      ),
    )
    .returning({ id: reportExports.id });

  return recoveredQueued.length + recoveredRunning.length;
};
