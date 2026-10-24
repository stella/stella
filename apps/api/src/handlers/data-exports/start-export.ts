// Starting an export: insert the row, or find the organisation's active one.

import { and, eq, inArray } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  ACTIVE_DATA_EXPORT_PREDICATE,
  ACTIVE_DATA_EXPORT_STATUSES,
  organizationDataExports,
} from "@/api/db/schema";
import type { DataExportVersionScope } from "@/api/handlers/data-exports/manifest-schema";
import { dataExportSummaryColumns } from "@/api/handlers/data-exports/summary";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";

/** Whether this call started the export or found one already running. */
export const DATA_EXPORT_START_OUTCOME = {
  STARTED: "started",
  ALREADY_ACTIVE: "already_active",
} as const;

type StartDataExportArgs = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  versions: DataExportVersionScope;
  recordAuditEvent: AuditRecorder;
};

/**
 * Insert a queued export unless the organisation already has an active one,
 * in which case return that one. The partial unique index decides, so two
 * concurrent requests cannot both start an export.
 */
export const startDataExport = async ({
  tx,
  organizationId,
  userId,
  versions,
  recordAuditEvent,
}: StartDataExportArgs) => {
  const inserted = await tx
    .insert(organizationDataExports)
    .values({ organizationId, requestedBy: userId, versionScope: versions })
    // The predicate is literal SQL, identical to the index's: a bound
    // parameter here stops matching the partial index under a generic plan.
    .onConflictDoNothing({
      target: organizationDataExports.organizationId,
      where: ACTIVE_DATA_EXPORT_PREDICATE,
    })
    .returning(dataExportSummaryColumns);
  const created = inserted.at(0);
  if (created !== undefined) {
    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.CREATE,
      resourceType: AUDIT_RESOURCE_TYPE.DATA_EXPORT,
      resourceId: created.id,
      metadata: { versions },
    });
    return { outcome: DATA_EXPORT_START_OUTCOME.STARTED, row: created };
  }
  const active = await tx
    .select(dataExportSummaryColumns)
    .from(organizationDataExports)
    .where(
      and(
        eq(organizationDataExports.organizationId, organizationId),
        inArray(organizationDataExports.status, [
          ...ACTIVE_DATA_EXPORT_STATUSES,
        ]),
      ),
    )
    .limit(1);
  return {
    outcome: DATA_EXPORT_START_OUTCOME.ALREADY_ACTIVE,
    row: active.at(0) ?? null,
  };
};
