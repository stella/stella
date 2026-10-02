import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { SafeDb } from "@/api/db/safe-db";
import { BILLING_STATUS, timeEntries } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import {
  getTimePolicyViolation,
  lockTimePolicy,
  readTimePolicy,
} from "@/api/lib/billing-time";
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

type DeleteEntryCheckOptions = {
  entry: Pick<
    typeof timeEntries.$inferSelect,
    "userId" | "status" | "invoiceId"
  >;
  actor: DeleteTimeEntryHandlerProps["actor"];
};
const getDeleteEntryError = ({ entry, actor }: DeleteEntryCheckOptions) => {
  if (
    !canManageTimeEntry({
      memberRole: actor.memberRole,
      currentUserId: actor.userId,
      entryUserId: entry.userId,
    })
  ) {
    return new HandlerError({ status: 404, message: "Time entry not found" });
  }
  if (
    entry.status !== BILLING_STATUS.DRAFT &&
    !canApproveTimeEntries(actor.memberRole)
  ) {
    return new HandlerError({
      status: 400,
      message: "Only draft time entries can be deleted",
    });
  }
  if (entry.invoiceId !== null || entry.status === BILLING_STATUS.BILLED) {
    return new HandlerError({
      status: 400,
      message: "Cannot delete a billed entry; revert the invoice first",
    });
  }
  return null;
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
          invoiceId: true,
        },
      }),
    ),
  );

  if (!existing) {
    return Result.err(
      new HandlerError({ status: 404, message: "Time entry not found" }),
    );
  }
  const existingError = getDeleteEntryError({ entry: existing, actor });
  if (existingError) {
    return Result.err(existingError);
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

  const outcome = yield* Result.await(
    safeDb(async (tx) => {
      const lockedPolicy = await lockTimePolicy(tx, existing.organizationId);
      const runningError = await guardRunningTimeEntries({
        tx,
        workspaceId,
        selection: { type: "entries", ids: [body.id] },
        actorUserId: actor.userId,
      });
      if (runningError) {
        return Result.err(runningError);
      }
      const [current] = await tx
        .select()
        .from(timeEntries)
        .where(
          and(
            eq(timeEntries.id, body.id),
            eq(timeEntries.workspaceId, workspaceId),
          ),
        )
        .limit(1)
        .for("update");
      if (!current) {
        return Result.err(
          new HandlerError({ status: 404, message: "Time entry not found" }),
        );
      }
      const currentError = getDeleteEntryError({ entry: current, actor });
      if (currentError) {
        return Result.err(currentError);
      }
      if (current.status === BILLING_STATUS.WRITTEN_OFF) {
        return Result.ok({ deleted: false });
      }
      const lockedToday = formatTodayInTimeZone({
        timezoneId: current.timezoneId,
      });
      if (lockedToday.isErr()) {
        return Result.err(lockedToday.error);
      }
      const violation = getTimePolicyViolation({
        policy: lockedPolicy,
        dateWorked: current.dateWorked,
        today: lockedToday.value,
        canApprove: canApproveTimeEntries(actor.memberRole),
      });
      if (violation) {
        return Result.err(violation);
      }
      if (current.status === BILLING_STATUS.DRAFT) {
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
                workItemId: current.workItemId,
                dateWorked: current.dateWorked,
                durationMinutes: current.durationMinutes,
                billedMinutes: current.billedMinutes,
                rateAtEntry: current.rateAtEntry,
                currency: current.currency,
                billable: current.billable,
              },
              new: null,
            },
          },
        });
        return Result.ok({ deleted: true });
      }
      await tx
        .update(timeEntries)
        .set({ status: BILLING_STATUS.WRITTEN_OFF, updatedAt: new Date() })
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
          status: { old: current.status, new: BILLING_STATUS.WRITTEN_OFF },
        },
      });
      return Result.ok({ deleted: false });
    }),
  );
  return outcome;
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
