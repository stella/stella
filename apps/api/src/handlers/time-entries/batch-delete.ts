import { Result } from "better-result";
import { and, eq, inArray, ne } from "drizzle-orm";
import { t } from "elysia";

import { BILLING_STATUS, timeEntries } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditEvent } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";

const batchDeleteBodySchema = t.Object({
  ids: t.Array(tSafeId("timeEntry"), { minItems: 1, maxItems: 200 }),
});

const buildBatchDeleteEvents = (params: {
  deleted: { id: SafeId<"timeEntry"> }[];
  writtenOff: { id: SafeId<"timeEntry"> }[];
}): AuditEvent[] => {
  const events: AuditEvent[] = [];
  for (const row of params.deleted) {
    events.push({
      action: AUDIT_ACTION.DELETE,
      resourceType: AUDIT_RESOURCE_TYPE.TIME_ENTRY,
      resourceId: row.id,
      changes: {
        deleted: {
          old: { reason: "batch_delete_draft" },
          new: null,
        },
      },
    });
  }
  for (const row of params.writtenOff) {
    events.push({
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.TIME_ENTRY,
      resourceId: row.id,
      changes: {
        status: {
          old: null,
          new: BILLING_STATUS.WRITTEN_OFF,
        },
      },
    });
  }
  return events;
};

const batchDelete = createSafeHandler(
  {
    permissions: { timeEntry: ["delete"] },
    body: batchDeleteBodySchema,
  },
  async function* ({ safeDb, workspaceId, body, recordAuditEvent }) {
    const { ids } = body;

    // Draft entries: hard delete. Non-draft: write off.
    // Wrapped in a transaction for atomicity.
    const updated = yield* Result.await(
      safeDb(async (tx) => {
        const deleted = await tx
          .delete(timeEntries)
          .where(
            and(
              eq(timeEntries.workspaceId, workspaceId),
              inArray(timeEntries.id, ids),
              eq(timeEntries.status, BILLING_STATUS.DRAFT),
            ),
          )
          .returning({ id: timeEntries.id });

        const writtenOff = await tx
          .update(timeEntries)
          .set({
            status: BILLING_STATUS.WRITTEN_OFF,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(timeEntries.workspaceId, workspaceId),
              inArray(timeEntries.id, ids),
              ne(timeEntries.status, BILLING_STATUS.WRITTEN_OFF),
              ne(timeEntries.status, BILLING_STATUS.BILLED),
            ),
          )
          .returning({ id: timeEntries.id });

        await recordAuditEvent(
          tx,
          buildBatchDeleteEvents({ deleted, writtenOff }),
        );

        return deleted.length + writtenOff.length;
      }),
    );

    return Result.ok({ updated });
  },
);

export default batchDelete;
