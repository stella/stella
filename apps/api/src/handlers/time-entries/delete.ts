import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { SafeDb } from "@/api/db/safe-db";
import { BILLING_STATUS, timeEntries } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const deleteTimeEntryBodySchema = t.Object({
  id: tSafeId("timeEntry", {
    description: "Time entry ID to delete or write off",
  }),
});

export type DeleteTimeEntryHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  recordAuditEvent: AuditRecorder;
  body: Static<typeof deleteTimeEntryBodySchema>;
};

// Shared time-entry deletion logic reused by the HTTP handler and the
// `delete_time_entry` MCP tool: a draft is hard-deleted, any other non-billed
// entry is written off, and both paths emit the same audit event.
export const deleteTimeEntryHandler = async function* ({
  safeDb,
  workspaceId,
  recordAuditEvent,
  body,
}: DeleteTimeEntryHandlerProps) {
  const existing = yield* Result.await(
    safeDb((tx) =>
      tx.query.timeEntries.findFirst({
        where: {
          id: { eq: body.id },
          workspaceId: { eq: workspaceId },
        },
        columns: {
          status: true,
          matterId: true,
          dateWorked: true,
          durationMinutes: true,
          billedMinutes: true,
          rateAtEntry: true,
          currency: true,
          billable: true,
        },
      }),
    ),
  );

  if (!existing) {
    return Result.err(
      new HandlerError({ status: 404, message: "Time entry not found" }),
    );
  }

  // A billed entry is attached to an invoice; writing it off here would leave
  // the invoice total stale. Match batch-delete, which excludes BILLED.
  if (existing.status === BILLING_STATUS.BILLED) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Cannot delete a billed entry; revert the invoice first",
      }),
    );
  }

  if (existing.status === BILLING_STATUS.DRAFT) {
    yield* Result.await(
      safeDb(async (tx) => {
        await tx
          .delete(timeEntries)
          .where(
            and(
              eq(timeEntries.id, body.id),
              eq(timeEntries.workspaceId, workspaceId),
            ),
          );

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.DELETE,
          resourceType: AUDIT_RESOURCE_TYPE.TIME_ENTRY,
          resourceId: body.id,
          changes: {
            deleted: {
              old: {
                matterId: existing.matterId,
                dateWorked: existing.dateWorked,
                durationMinutes: existing.durationMinutes,
                billedMinutes: existing.billedMinutes,
                rateAtEntry: existing.rateAtEntry,
                currency: existing.currency,
                billable: existing.billable,
              },
              new: null,
            },
          },
        });
      }),
    );
    return Result.ok({ deleted: true });
  }

  // Already written off: avoid a no-op UPDATE that would emit a
  // misleading audit event recording old and new status as identical.
  if (existing.status === BILLING_STATUS.WRITTEN_OFF) {
    return Result.ok({ deleted: false });
  }

  // Non-draft entries get written off instead of deleted
  yield* Result.await(
    safeDb(async (tx) => {
      await tx
        .update(timeEntries)
        .set({
          status: BILLING_STATUS.WRITTEN_OFF,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(timeEntries.id, body.id),
            eq(timeEntries.workspaceId, workspaceId),
          ),
        );

      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.TIME_ENTRY,
        resourceId: body.id,
        changes: {
          status: {
            old: existing.status,
            new: BILLING_STATUS.WRITTEN_OFF,
          },
        },
      });
    }),
  );

  return Result.ok({ deleted: false });
};

const deleteTimeEntryById = createSafeHandler(
  {
    description:
      "Delete a time entry. A draft entry is permanently deleted; an " +
      "approved entry is written off instead (kept for the audit trail, " +
      "excluded from billing). A billed entry cannot be deleted until its " +
      "invoice is reverted. Returns whether the entry was hard-deleted.",
    permissions: { timeEntry: ["delete"] },
    mcp: { type: "tool", name: "delete_time_entry" },
    body: deleteTimeEntryBodySchema,
  },
  async function* ({ safeDb, workspaceId, body, recordAuditEvent }) {
    return yield* deleteTimeEntryHandler({
      safeDb,
      workspaceId,
      recordAuditEvent,
      body,
    });
  },
);

export default deleteTimeEntryById;
