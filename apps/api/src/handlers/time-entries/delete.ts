import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { SafeDb } from "@/api/db/safe-db";
import { BILLING_STATUS, timeEntries } from "@/api/db/schema";
import { timeEntryRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { getTimePolicyViolation, readTimePolicy } from "@/api/lib/billing-time";
import { recordBillingCapCrossings } from "@/api/lib/billing/arrangements";
import {
  canApproveTimeEntries,
  canManageTimeEntry,
} from "@/api/lib/billing/time-entry-authorization";
import { guardRunningTimeEntries } from "@/api/lib/billing/time-entry-running";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import { formatTodayInTimeZone } from "@/api/lib/timezone";

const deleteTimeEntryBodySchema = t.Object({
  id: tSafeId("timeEntry", {
    description: "Time entry ID to delete or write off",
  }),
});

export type DeleteTimeEntryHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  actor: {
    userId: SafeId<"user">;
    memberRole: AuthorizedMemberRole;
  };
  recordAuditEvent: AuditRecorder;
  body: Static<typeof deleteTimeEntryBodySchema>;
};

// Shared time-entry deletion logic reused by the HTTP handler and the
// `delete_time_entry` MCP tool: a draft is hard-deleted, any other non-billed
// entry is written off, and both paths emit the same audit event.
export const deleteTimeEntryHandler = async function* ({
  safeDb,
  workspaceId,
  actor,
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
          organizationId: true,
          status: true,
          workItemId: true,
          userId: true,
          dateWorked: true,
          timezoneId: true,
          durationMinutes: true,
          billedMinutes: true,
          rateAtEntry: true,
          currency: true,
          billable: true,
        },
      }),
    ),
  );

  if (
    !existing ||
    !canManageTimeEntry({
      memberRole: actor.memberRole,
      currentUserId: actor.userId,
      entryUserId: existing.userId,
    })
  ) {
    return Result.err(
      new HandlerError({ status: 404, message: "Time entry not found" }),
    );
  }

  if (
    existing.status !== BILLING_STATUS.DRAFT &&
    !canApproveTimeEntries(actor.memberRole)
  ) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Only draft time entries can be deleted",
      }),
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

  // An already written-off entry needs no write or policy check.
  if (existing.status === BILLING_STATUS.WRITTEN_OFF) {
    return Result.ok({ deleted: false });
  }

  const policy = yield* Result.await(
    readTimePolicy({ safeDb, organizationId: existing.organizationId }),
  );
  const today = yield* formatTodayInTimeZone({
    timezoneId: existing.timezoneId,
  });
  const policyViolation = getTimePolicyViolation({
    policy,
    dateWorked: existing.dateWorked,
    today,
    canApprove: canApproveTimeEntries(actor.memberRole),
  });
  if (policyViolation) {
    return Result.err(policyViolation);
  }

  if (existing.status === BILLING_STATUS.DRAFT) {
    const deleted = yield* Result.await(
      safeDb(async (tx) => {
        const runningError = await guardRunningTimeEntries({
          tx,
          workspaceId,
          selection: { type: "entries", ids: [body.id] },
          actorUserId: actor.userId,
        });
        if (runningError) {
          return runningError;
        }
        const rows = await tx
          .delete(timeEntries)
          .where(
            and(
              eq(timeEntries.id, body.id),
              eq(timeEntries.workspaceId, workspaceId),
              eq(timeEntries.status, BILLING_STATUS.DRAFT),
              canApproveTimeEntries(actor.memberRole)
                ? undefined
                : eq(timeEntries.userId, actor.userId),
            ),
          )
          .returning({ id: timeEntries.id });

        if (!rows.at(0)) {
          return false;
        }

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.DELETE,
          resourceType: AUDIT_RESOURCE_TYPE.TIME_ENTRY,
          resourceId: body.id,
          changes: {
            deleted: {
              old: {
                workItemId: existing.workItemId,
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
        await recordBillingCapCrossings(tx, { workspaceId, recordAuditEvent });
        return true;
      }),
    );
    if (HandlerError.is(deleted)) {
      return Result.err(deleted);
    }
    if (!deleted) {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "Time entry changed; reload and try again",
        }),
      );
    }
    return Result.ok({ deleted: true });
  }

  // Non-draft entries get written off instead of deleted
  const writtenOff = yield* Result.await(
    safeDb(async (tx) => {
      const runningError = await guardRunningTimeEntries({
        tx,
        workspaceId,
        selection: { type: "entries", ids: [body.id] },
        actorUserId: actor.userId,
      });
      if (runningError) {
        return runningError;
      }
      const rows = await tx
        .update(timeEntries)
        .set({
          status: BILLING_STATUS.WRITTEN_OFF,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(timeEntries.id, body.id),
            eq(timeEntries.workspaceId, workspaceId),
            eq(timeEntries.status, existing.status),
          ),
        )
        .returning({ id: timeEntries.id });

      if (!rows.at(0)) {
        return false;
      }

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
      await recordBillingCapCrossings(tx, { workspaceId, recordAuditEvent });
      return true;
    }),
  );

  if (HandlerError.is(writtenOff)) {
    return Result.err(writtenOff);
  }
  if (!writtenOff) {
    return Result.err(
      new HandlerError({
        status: 409,
        message: "Time entry changed; reload and try again",
      }),
    );
  }

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
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: { featureId: "time-billing", type: "required" },
    realtime: timeEntryRealtimeUpdates,
    mcp: { type: "tool", name: "delete_time_entry" },
    body: deleteTimeEntryBodySchema,
  },
  async function* ({
    memberRole,
    safeDb,
    user,
    workspaceId,
    body,
    recordAuditEvent,
  }) {
    return yield* deleteTimeEntryHandler({
      safeDb,
      workspaceId,
      actor: { userId: user.id, memberRole },
      recordAuditEvent,
      body,
    });
  },
);

export default deleteTimeEntryById;
