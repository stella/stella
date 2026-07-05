/**
 * Recovery janitor for report exports orphaned by a hard worker death.
 *
 * Job-level failures self-heal via the worker `failed` event + the in-job
 * catch. A `kill -9` / OOM emits no `failed` event, and BullMQ's own stalled
 * recovery re-delivers the job — but the queue's idempotency guard (only
 * `queued` rows run) makes that re-delivery a no-op, so the row would sit
 * `running` forever. A boot sweep closes that gap.
 *
 * The two states age at different rates. A `running` row survives its worker
 * only through a hard death, so half an hour of silence is conclusive. A
 * `queued` row is still processable — its job persists in the queue across
 * restarts and the sweep runs before the worker starts — so failing it on the
 * short threshold would kill a backlogged-but-alive export. Only a queued row
 * whose job is gone (queue data loss) is truly stuck, which the DB cannot
 * observe directly; a day of silence is the conservative proxy, far beyond
 * any real backlog at the worker's concurrency.
 *
 * Owner-level, cross-workspace DB access lives here (a narrow lib helper) so the
 * report handler slice never imports the RLS-exempt root db directly, mirroring
 * the workflow orphan reconciler.
 */

import { and, eq, lt, or } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import type { ReportExportStatus } from "@/api/db/schema";
import { reportExports } from "@/api/db/schema";

/** A `running` row this old lost its worker to a hard death. */
const STUCK_RUNNING_MS = 30 * 60 * 1000;
/** A `queued` row this old lost its job to queue data loss; anything younger
 *  may simply be backlogged and must be left for the worker. */
const STUCK_QUEUED_MS = 24 * 60 * 60 * 1000;
const STUCK_EXPORT_ERROR =
  "Report export did not complete in time and was marked failed. Please try again.";

/**
 * Whether an export row is presumed abandoned (dead worker for `running`,
 * lost job for `queued`). Pure so the exact rule the recovery UPDATE encodes
 * (per-status staleness thresholds) is unit-testable;
 * {@link recoverStuckReportExports}'s SQL `where` mirrors it.
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

/**
 * Boot janitor: mark every abandoned export failed. Runs cross-workspace via
 * `rootDb` (RLS-exempt internal infrastructure, like the workflow orphan
 * reconciler) with a single indexed UPDATE whose `where` mirrors
 * {@link isStuckReportExport}. Idempotent and safe to call repeatedly.
 * Returns how many rows it recovered.
 */
export const recoverStuckReportExports = async (
  now: Date = new Date(),
): Promise<number> => {
  const runningCutoff = new Date(now.getTime() - STUCK_RUNNING_MS);
  const queuedCutoff = new Date(now.getTime() - STUCK_QUEUED_MS);
  // audit: skip — janitor bookkeeping on already-audited export rows; flips
  // abandoned exports to failed so the status endpoint can surface them
  // instead of polling a stuck row forever.
  const recovered = await rootDb
    .update(reportExports)
    .set({ status: "failed", error: STUCK_EXPORT_ERROR })
    .where(
      or(
        and(
          eq(reportExports.status, "running"),
          lt(reportExports.updatedAt, runningCutoff),
        ),
        and(
          eq(reportExports.status, "queued"),
          lt(reportExports.updatedAt, queuedCutoff),
        ),
      ),
    )
    .returning({ id: reportExports.id });
  return recovered.length;
};
