import { Result } from "better-result";
import { and, asc, eq, getColumns, inArray, ne, or } from "drizzle-orm";

import { TIME_ENTRY_ACTIVITY_GROUP } from "@stll/api-contract";

import type { SafeDb } from "@/api/db/safe-db";
import { BILLING_STATUS, timeEntries, workspaces } from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { UNPRICED_TIME_ENTRY_CURRENCY } from "@/api/lib/billing-constants";
import { getTimePolicyViolation, lockTimePolicy } from "@/api/lib/billing-time";
import type { TimePolicy } from "@/api/lib/billing-time";
import { recordBillingCapCrossingsForMatters } from "@/api/lib/billing/arrangements";
import { canApproveAssignedTimeEntry } from "@/api/lib/billing/time-entry-authorization";
import {
  guardRunningTimeEntries,
  timeEntryIsRunning,
} from "@/api/lib/billing/time-entry-running";
import type { SafeId } from "@/api/lib/branded-types";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import { formatTodayInTimeZone } from "@/api/lib/timezone";

const TIME_APPROVAL_REFUSALS = [
  "not_found",
  "not_approver",
  "wrong_status",
  "running_timer",
  "unpriced",
  "time_period_locked",
  "invalid_entry",
] as const;

type ApprovalEntry = typeof timeEntries.$inferSelect & { running: boolean };
type ApprovalActor = {
  memberRole: AuthorizedMemberRole;
  currentUserId: SafeId<"user">;
};
type ApprovalRefusalOptions = ApprovalActor & {
  entry: ApprovalEntry;
  policy: TimePolicy;
  now: Date;
  action: "approve" | "return";
};

export const timeApprovalRefusal = ({
  entry,
  memberRole,
  currentUserId,
  policy,
  now,
  action,
}: ApprovalRefusalOptions): (typeof TIME_APPROVAL_REFUSALS)[number] | null => {
  if (
    !canApproveAssignedTimeEntry({
      memberRole,
      currentUserId,
      approverUserId: entry.approverUserId,
    })
  ) {
    return "not_approver";
  }
  if (
    entry.status !== BILLING_STATUS.DRAFT &&
    entry.status !== BILLING_STATUS.APPROVED
  ) {
    return "wrong_status";
  }
  if (entry.running) {
    return "running_timer";
  }
  if (
    action === "approve" &&
    entry.activityGroup === TIME_ENTRY_ACTIVITY_GROUP.CLIENT &&
    entry.billable &&
    entry.currency === UNPRICED_TIME_ENTRY_CURRENCY
  ) {
    return "unpriced";
  }
  const today = formatTodayInTimeZone({ timezoneId: entry.timezoneId, now });
  if (today.isErr()) {
    return "invalid_entry";
  }
  const violation = getTimePolicyViolation({
    policy,
    dateWorked: entry.dateWorked,
    today: today.value,
    canApprove: true,
    narrative: action === "approve" ? entry.narrative : undefined,
  });
  if (violation) {
    return violation.code === "time_period_locked"
      ? "time_period_locked"
      : "invalid_entry";
  }
  return null;
};

type ApproveTimeEntryBatchOptions = ApprovalActor & {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  ids: SafeId<"timeEntry">[];
  recordAuditEvent: AuditRecorder;
};
type TimeApprovalOutcome =
  | { id: SafeId<"timeEntry">; status: "approved" }
  | {
      id: SafeId<"timeEntry">;
      status: "refused";
      reason: (typeof TIME_APPROVAL_REFUSALS)[number];
    };

export const approveTimeEntryBatch = async ({
  safeDb,
  organizationId,
  ids,
  recordAuditEvent,
  memberRole,
  currentUserId,
}: ApproveTimeEntryBatchOptions) => {
  const now = new Date();
  const uniqueIds = [...new Set(ids)];
  return await safeDb(async (tx) => {
    const policy = await lockTimePolicy(tx, organizationId);
    const runningError = await guardRunningTimeEntries({
      tx,
      organizationId,
      actorUserId: currentUserId,
      selection: { type: "approval_batch", ids: uniqueIds },
    });
    if (runningError) {
      return Result.err(runningError);
    }
    const rows = await tx
      .select({
        ...getColumns(timeEntries),
        running: timeEntryIsRunning(),
      })
      .from(timeEntries)
      .leftJoin(
        workspaces,
        and(
          eq(workspaces.id, timeEntries.workspaceId),
          eq(workspaces.organizationId, organizationId),
        ),
      )
      .where(
        and(
          eq(timeEntries.organizationId, organizationId),
          inArray(timeEntries.id, uniqueIds),
          or(
            eq(timeEntries.activityGroup, TIME_ENTRY_ACTIVITY_GROUP.INTERNAL),
            and(
              eq(timeEntries.activityGroup, TIME_ENTRY_ACTIVITY_GROUP.CLIENT),
              ne(workspaces.status, "deleting"),
            ),
          ),
        ),
      )
      .orderBy(asc(timeEntries.id))
      .limit(uniqueIds.length)
      .for("update", { of: timeEntries });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const approved = [];
    const results: TimeApprovalOutcome[] = [];
    for (const id of uniqueIds) {
      const entry = byId.get(id);
      const reason = entry
        ? timeApprovalRefusal({
            entry,
            memberRole,
            currentUserId,
            policy,
            now,
            action: "approve",
          })
        : "not_found";
      if (reason) {
        results.push({ id, status: "refused", reason });
        continue;
      }
      results.push({ id, status: "approved" });
      if (entry && entry.status === BILLING_STATUS.DRAFT) {
        approved.push(entry);
      }
    }
    if (approved.length > 0) {
      await tx
        .update(timeEntries)
        .set({
          status: BILLING_STATUS.APPROVED,
          approvedByUserId: currentUserId,
          approvedAt: now,
          returnedAt: null,
          returnedByUserId: null,
          returnComment: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(timeEntries.organizationId, organizationId),
            inArray(
              timeEntries.id,
              approved.map(({ id }) => id),
            ),
            eq(timeEntries.status, BILLING_STATUS.DRAFT),
          ),
        );
      await recordAuditEvent(
        tx,
        approved.map((entry) => ({
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.TIME_ENTRY,
          resourceId: entry.id,
          workspaceId: entry.workspaceId,
          changes: {
            status: { old: entry.status, new: BILLING_STATUS.APPROVED },
            approvedByUserId: {
              old: entry.approvedByUserId,
              new: currentUserId,
            },
            approvedAt: { old: entry.approvedAt, new: now },
            returnComment: { old: entry.returnComment, new: null },
          },
        })),
      );
    }
    const matters = new Set(
      approved.flatMap((entry) =>
        entry.workspaceId === null ? [] : [entry.workspaceId],
      ),
    );
    await recordBillingCapCrossingsForMatters(tx, {
      workspaceIds: [...matters],
      recordAuditEvent,
    });
    return Result.ok({ results });
  });
};
