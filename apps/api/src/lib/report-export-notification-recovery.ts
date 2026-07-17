import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { reportExports, workspaces } from "@/api/db/schema";

/** Bounds both one reconciliation query and the maximum outbound-email burst
 * per API replica. Atomic row claiming in the reports slice deduplicates
 * overlapping replicas. */
export const REPORT_EXPORT_NOTIFICATION_RECONCILE_LIMIT = 20;

/**
 * Owner-level, cross-workspace scan for terminal exports left pending by a
 * hard death or a mixed-version rolling deploy. The partial migration index
 * matches this predicate and ordering; only routing identifiers leave this
 * narrow root helper, never report content or artifact metadata.
 */
export const listPendingReportExportNotifications = async () => {
  const rows = await rootDb
    .select({
      exportId: reportExports.id,
      organizationId: workspaces.organizationId,
      userId: reportExports.requestedBy,
      workspaceId: reportExports.workspaceId,
    })
    .from(reportExports)
    .innerJoin(workspaces, eq(workspaces.id, reportExports.workspaceId))
    .where(
      and(
        eq(reportExports.notificationStatus, "pending"),
        inArray(reportExports.status, ["completed", "failed"]),
      ),
    )
    .orderBy(asc(reportExports.createdAt), asc(reportExports.id))
    .limit(REPORT_EXPORT_NOTIFICATION_RECONCILE_LIMIT);

  const abandonedExportIds = rows.flatMap((row) =>
    row.userId === null ? [row.exportId] : [],
  );
  let suppressed = 0;
  if (abandonedExportIds.length > 0) {
    const suppressedRows = await rootDb
      .update(reportExports)
      .set({ notificationStatus: "suppressed" })
      .where(
        and(
          inArray(reportExports.id, abandonedExportIds),
          eq(reportExports.notificationStatus, "pending"),
          inArray(reportExports.status, ["completed", "failed"]),
          isNull(reportExports.requestedBy),
        ),
      )
      .returning({ id: reportExports.id });
    suppressed = suppressedRows.length;
  }

  return {
    actors: rows.flatMap((row) =>
      row.userId === null ? [] : [{ ...row, userId: row.userId }],
    ),
    suppressed,
  };
};
