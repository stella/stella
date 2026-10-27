import { Result } from "better-result";
import { and, asc, eq, getColumns, inArray, ne, or } from "drizzle-orm";

import { TIME_ENTRY_ACTIVITY_GROUP } from "@stll/api-contract";
import type { TimeApprovalRefusal } from "@stll/api-contract/time-entries";

import type { Transaction } from "@/api/db/root";
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
import { TRANSITIONS } from "@/api/lib/db/transition-specs";
import { transitionBatch } from "@/api/lib/db/transitions";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import { formatTodayInTimeZone } from "@/api/lib/timezone";

type ApprovalEntry = typeof timeEntries.$inferSelect & { running: boolean };

/**
 * The review lifecycle every status change of a time entry follows; this
 * module owns it. A timekeeper submits a draft; an approver approves a
 * submitted entry or returns it (or an approved one) to draft with a reason.
 * Approving a draft directly is the solo path only: an approver acting on
 * their own entry. Billing and write-off leave from approved.
 */
export const TIME_ENTRY_REVIEW_TRANSITIONS = {
  submit: { from: [BILLING_STATUS.DRAFT], to: BILLING_STATUS.SUBMITTED },
  approve: {
    from: [BILLING_STATUS.SUBMITTED, BILLING_STATUS.DRAFT],
    to: BILLING_STATUS.APPROVED,
  },
  return: {
    from: [BILLING_STATUS.SUBMITTED, BILLING_STATUS.APPROVED],
    to: BILLING_STATUS.DRAFT,
  },
} as const;

const APPROVABLE_STATUSES: readonly string[] =
  TIME_ENTRY_REVIEW_TRANSITIONS.approve.from;
const RETURNABLE_STATUSES: readonly string[] =
  TIME_ENTRY_REVIEW_TRANSITIONS.return.from;

/**
 * Whether the entry's status lets this action proceed. Approving an approved
 * entry and returning an already returned draft replay safely; a draft is
 * approvable only by its own timekeeper (who is their own approver).
 */
const reviewStatusRefusal = ({
  entry,
  currentUserId,
  action,
}: {
  entry: ApprovalEntry;
  currentUserId: SafeId<"user">;
  action: "approve" | "return";
}): TimeApprovalRefusal | null => {
  if (action === "approve") {
    if (entry.status === BILLING_STATUS.APPROVED) {
      return null;
    }
    if (!APPROVABLE_STATUSES.includes(entry.status)) {
      return "wrong_status";
    }
    return entry.status === BILLING_STATUS.DRAFT &&
      entry.userId !== currentUserId
      ? "not_submitted"
      : null;
  }
  if (RETURNABLE_STATUSES.includes(entry.status)) {
    return null;
  }
  if (entry.status === BILLING_STATUS.DRAFT) {
    return entry.returnedAt === null ? "not_submitted" : null;
  }
  return "wrong_status";
};
/**
 * Audits each entry a review write actually moved, one event per entry, with
 * the changes its decision made.
 */
const auditReviewMoves =
  (
    entries: readonly ApprovalEntry[],
    recordAuditEvent: AuditRecorder,
    changesOf: (entry: ApprovalEntry) => Record<string, AuditChange>,
  ) =>
  async (
    tx: Transaction,
    rows: readonly { id: SafeId<"timeEntry">; status: string }[],
  ) => {
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    await recordAuditEvent(
      tx,
      rows.flatMap(({ id }) => {
        const entry = byId.get(id);
        return entry === undefined
          ? []
          : [
              {
                action: AUDIT_ACTION.UPDATE,
                resourceType: AUDIT_RESOURCE_TYPE.TIME_ENTRY,
                resourceId: id,
                workspaceId: entry.workspaceId,
                changes: changesOf(entry),
              },
            ];
      }),
    );
  };
type AuditChange = { old: unknown; new: unknown };

// A returned draft can be returned again with a new reason, so the write
// admits drafts too; `reviewStatusRefusal` keeps never-returned drafts out.
const RETURN_WRITE_FROM = [
  BILLING_STATUS.SUBMITTED,
  BILLING_STATUS.APPROVED,
  BILLING_STATUS.DRAFT,
] as const;

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
}: ApprovalRefusalOptions): TimeApprovalRefusal | null => {
  if (
    !canApproveAssignedTimeEntry({
      memberRole,
      currentUserId,
      approverUserId: entry.approverUserId,
    })
  ) {
    return "not_approver";
  }
  const statusRefusal = reviewStatusRefusal({ entry, currentUserId, action });
  if (statusRefusal) {
    return statusRefusal;
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

/**
 * Locks the reviewed entries in id order, after the caller took the policy,
 * timer-owner and matter locks: internal work, and client work whose matter
 * is not being deleted. Ids outside the organization are simply absent.
 */
const lockReviewedEntries = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
  uniqueIds: readonly SafeId<"timeEntry">[],
): Promise<ReadonlyMap<SafeId<"timeEntry">, ApprovalEntry>> => {
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
        inArray(timeEntries.id, [...uniqueIds]),
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
  return new Map(rows.map((row) => [row.id, row]));
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
      reason: TimeApprovalRefusal;
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
    const byId = await lockReviewedEntries(tx, organizationId, uniqueIds);
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
      if (entry && entry.status !== BILLING_STATUS.APPROVED) {
        approved.push(entry);
      }
    }
    if (approved.length > 0) {
      await transitionBatch({
        tx,
        spec: TRANSITIONS.timeEntries,
        ids: approved.map(({ id }) => id),
        options: {
          from: TIME_ENTRY_REVIEW_TRANSITIONS.approve.from,
          to: TIME_ENTRY_REVIEW_TRANSITIONS.approve.to,
          guard: eq(timeEntries.organizationId, organizationId),
          set: {
            approvedByUserId: currentUserId,
            approvedAt: now,
            returnedAt: null,
            returnedByUserId: null,
            returnComment: null,
            updatedAt: now,
          },
        },
        recordTransitionAuditEvent: auditReviewMoves(
          approved,
          recordAuditEvent,
          (entry) => ({
            status: { old: entry.status, new: BILLING_STATUS.APPROVED },
            approvedByUserId: {
              old: entry.approvedByUserId,
              new: currentUserId,
            },
            approvedAt: { old: entry.approvedAt, new: now },
            returnComment: { old: entry.returnComment, new: null },
          }),
        ),
      });
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

type ReturnTimeEntryBatchOptions = ApproveTimeEntryBatchOptions & {
  /** The reason the timekeepers see, already trimmed and validated. */
  comment: string;
};
type TimeReturnOutcome =
  | { id: SafeId<"timeEntry">; status: "returned" }
  | {
      id: SafeId<"timeEntry">;
      status: "refused";
      reason: TimeApprovalRefusal;
    };

/** Whether the entry already carries this return, so repeating it is a no-op. */
const alreadyReturned = (
  entry: ApprovalEntry,
  comment: string,
  currentUserId: SafeId<"user">,
) =>
  entry.status === BILLING_STATUS.DRAFT &&
  entry.returnComment === comment &&
  entry.returnedByUserId === currentUserId;

/**
 * Returns up to a batch of submitted or approved entries to draft with one
 * reason, under the same authorization and locks as approval. Each id answers
 * returned or refused with its reason; each changed entry is audited on its
 * own. Repeating a return with the same reason changes nothing.
 */
export const returnTimeEntryBatch = async ({
  safeDb,
  organizationId,
  ids,
  comment,
  recordAuditEvent,
  memberRole,
  currentUserId,
}: ReturnTimeEntryBatchOptions) => {
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
    const byId = await lockReviewedEntries(tx, organizationId, uniqueIds);
    const changed: ApprovalEntry[] = [];
    const matters = new Set<SafeId<"workspace">>();
    const results: TimeReturnOutcome[] = [];
    for (const id of uniqueIds) {
      const entry = byId.get(id);
      if (!entry) {
        results.push({ id, status: "refused", reason: "not_found" });
        continue;
      }
      const reason = timeApprovalRefusal({
        entry,
        memberRole,
        currentUserId,
        policy,
        now,
        action: "return",
      });
      if (reason) {
        results.push({ id, status: "refused", reason });
        continue;
      }
      results.push({ id, status: "returned" });
      if (entry.workspaceId !== null) {
        matters.add(entry.workspaceId);
      }
      if (!alreadyReturned(entry, comment, currentUserId)) {
        changed.push(entry);
      }
    }
    if (changed.length > 0) {
      await transitionBatch({
        tx,
        spec: TRANSITIONS.timeEntries,
        ids: changed.map(({ id }) => id),
        options: {
          from: RETURN_WRITE_FROM,
          to: TIME_ENTRY_REVIEW_TRANSITIONS.return.to,
          guard: eq(timeEntries.organizationId, organizationId),
          set: {
            approvedByUserId: null,
            approvedAt: null,
            returnedAt: now,
            returnedByUserId: currentUserId,
            returnComment: comment,
            updatedAt: now,
          },
        },
        recordTransitionAuditEvent: auditReviewMoves(
          changed,
          recordAuditEvent,
          (entry) => ({
            status: { old: entry.status, new: BILLING_STATUS.DRAFT },
            returnComment: { old: entry.returnComment, new: comment },
            returnedByUserId: {
              old: entry.returnedByUserId,
              new: currentUserId,
            },
            returnedAt: { old: entry.returnedAt, new: now },
            approvedAt: { old: entry.approvedAt, new: null },
            approvedByUserId: { old: entry.approvedByUserId, new: null },
          }),
        ),
      });
    }
    await recordBillingCapCrossingsForMatters(tx, {
      workspaceIds: [...matters],
      recordAuditEvent,
    });
    return Result.ok({ results });
  });
};
