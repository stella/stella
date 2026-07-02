/**
 * Recovery janitor for report exports orphaned by a hard worker death.
 *
 * Job-level failures self-heal via the worker `failed` event + the in-job
 * catch. A `kill -9` / OOM emits no `failed` event, and BullMQ's own stalled
 * recovery re-delivers the job — but the queue's idempotency guard (only
 * `queued` rows run) makes that re-delivery a no-op, so the row would sit
 * `running` forever. A boot sweep closes that gap.
 *
 * Owner-level, cross-workspace DB access lives here (a narrow lib helper) so the
 * report handler slice never imports the RLS-exempt root db directly, mirroring
 * the workflow orphan reconciler.
 */

import { and, inArray, lt } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import type { ReportExportStatus } from "@/api/db/schema";
import { reportExports } from "@/api/db/schema";

// Recovery threshold: any `queued`/`running` row untouched for longer than this
// is presumed orphaned and marked failed.
const STUCK_REPORT_EXPORT_MS = 30 * 60 * 1000;
const STUCK_EXPORT_ERROR =
  "Report export did not complete in time and was marked failed. Please try again.";

/**
 * Whether a `queued`/`running` export row is presumed abandoned by a dead
 * worker. Pure so the exact rule the recovery UPDATE encodes (status gate +
 * staleness threshold) is unit-testable; {@link recoverStuckReportExports}'s
 * SQL `where` mirrors it.
 */
export const isStuckReportExport = (
  row: { status: ReportExportStatus; updatedAt: Date },
  now: Date,
): boolean =>
  (row.status === "queued" || row.status === "running") &&
  now.getTime() - row.updatedAt.getTime() > STUCK_REPORT_EXPORT_MS;

/**
 * Boot janitor: mark every export orphaned by a hard worker death failed.
 * Runs cross-workspace via `rootDb` (RLS-exempt internal infrastructure, like
 * the workflow orphan reconciler) with a single indexed UPDATE whose `where`
 * mirrors {@link isStuckReportExport}. Idempotent and safe to call repeatedly.
 * Returns how many rows it recovered.
 */
export const recoverStuckReportExports = async (
  now: Date = new Date(),
): Promise<number> => {
  const cutoff = new Date(now.getTime() - STUCK_REPORT_EXPORT_MS);
  // audit: skip — janitor bookkeeping on already-audited export rows; flips
  // exports abandoned by a dead worker from queued/running to failed so the
  // status endpoint can surface them instead of polling a stuck row forever.
  const recovered = await rootDb
    .update(reportExports)
    .set({ status: "failed", error: STUCK_EXPORT_ERROR })
    .where(
      and(
        inArray(reportExports.status, ["queued", "running"]),
        lt(reportExports.updatedAt, cutoff),
      ),
    )
    .returning({ id: reportExports.id });
  return recovered.length;
};
