import { Result } from "better-result";
import { and, asc, eq, getColumns, gte, lte, ne, or } from "drizzle-orm";

import { TIME_ENTRY_ACTIVITY_GROUP } from "@stll/api-contract";
import type { TimeSubmitRefusal } from "@stll/api-contract/time-entries";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { BILLING_STATUS, timeEntries, workspaces } from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { UNPRICED_TIME_ENTRY_CURRENCY } from "@/api/lib/billing-constants";
import { getTimePolicyViolation, lockTimePolicy } from "@/api/lib/billing-time";
import type { TimePolicy } from "@/api/lib/billing-time";
import { recordBillingCapCrossingsForMatters } from "@/api/lib/billing/arrangements";
import { TIME_ENTRY_REVIEW_TRANSITIONS } from "@/api/lib/billing/time-entry-approval";
import { canApproveAssignedTimeEntry } from "@/api/lib/billing/time-entry-authorization";
import { timeEntryIsRunning } from "@/api/lib/billing/time-entry-running";
import type { SafeId } from "@/api/lib/branded-types";
import { TRANSITIONS } from "@/api/lib/db/transition-specs";
import { transitionBatch } from "@/api/lib/db/transitions";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import { formatTodayInTimeZone } from "@/api/lib/timezone";

type SubmissionEntry = typeof timeEntries.$inferSelect & { running: boolean };

/**
 * Why one draft cannot be submitted. Submission is not an edit, so the edit
 * window does not apply; the locked period, the narrative policy and pricing
 * do, because an approver could not approve the entry either.
 */
export const timeSubmitRefusal = ({
  entry,
  policy,
  now,
}: {
  entry: SubmissionEntry;
  policy: TimePolicy;
  now: Date;
}): TimeSubmitRefusal | null => {
  if (entry.running) {
    return "running_timer";
  }
  if (
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
    narrative: entry.narrative,
  });
  if (violation?.code === "time_period_locked") {
    return "time_period_locked";
  }
  if (violation?.code === "narrative_required") {
    return "narrative_required";
  }
  return violation ? "invalid_entry" : null;
};

type SubmitTimeEntriesOptions = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  memberRole: AuthorizedMemberRole;
  startDate: string;
  endDate: string;
  /** Approve in the same step the entries the timekeeper is the approver of. */
  approve: boolean;
  recordAuditEvent: AuditRecorder;
};

export type TimeSubmitOutcome =
  | { id: SafeId<"timeEntry">; status: "submitted" | "approved" }
  | { id: SafeId<"timeEntry">; status: "refused"; reason: TimeSubmitRefusal };

// The timekeeper's own drafts for the dates. Client entries of a matter being
// deleted stay out, as they do in the queue. Nothing is locked: every move is
// a transition guarded on the draft status, so an entry that changed since
// this read simply does not move.
const readOwnDrafts = async (
  tx: Transaction,
  {
    organizationId,
    userId,
    startDate,
    endDate,
  }: Pick<
    SubmitTimeEntriesOptions,
    "organizationId" | "userId" | "startDate" | "endDate"
  >,
) =>
  await tx
    .select({ ...getColumns(timeEntries), running: timeEntryIsRunning() })
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
        eq(timeEntries.userId, userId),
        eq(timeEntries.status, BILLING_STATUS.DRAFT),
        gte(timeEntries.dateWorked, startDate),
        lte(timeEntries.dateWorked, endDate),
        or(
          eq(timeEntries.activityGroup, TIME_ENTRY_ACTIVITY_GROUP.INTERNAL),
          and(
            eq(timeEntries.activityGroup, TIME_ENTRY_ACTIVITY_GROUP.CLIENT),
            ne(workspaces.status, "deleting"),
          ),
        ),
      ),
    )
    .orderBy(asc(timeEntries.dateWorked), asc(timeEntries.id))
    .limit(LIMITS.timeEntriesApprovalBatchMax + 1);

type Moved = { entry: SubmissionEntry; to: "submitted" | "approved" };

const recordStatusMoves =
  (moved: readonly SubmissionEntry[], recordAuditEvent: AuditRecorder) =>
  async (
    tx: Transaction,
    rows: readonly { id: SafeId<"timeEntry">; status: string }[],
  ) => {
    const byId = new Map(moved.map((entry) => [entry.id, entry]));
    await recordAuditEvent(
      tx,
      rows.flatMap(({ id, status }) => {
        const entry = byId.get(id);
        return entry === undefined
          ? []
          : [
              {
                action: AUDIT_ACTION.UPDATE,
                resourceType: AUDIT_RESOURCE_TYPE.TIME_ENTRY,
                resourceId: id,
                workspaceId: entry.workspaceId,
                changes: { status: { old: entry.status, new: status } },
              },
            ];
      }),
    );
  };

// Moves the drafts in two status-guarded batches; returns the ids that moved.
const writeMoves = async (
  tx: Transaction,
  {
    userId,
    moves,
    now,
    recordAuditEvent,
  }: {
    userId: SafeId<"user">;
    moves: readonly Moved[];
    now: Date;
    recordAuditEvent: AuditRecorder;
  },
) => {
  const toSubmit = moves.flatMap(({ entry, to }) =>
    to === "submitted" ? [entry] : [],
  );
  const toApprove = moves.flatMap(({ entry, to }) =>
    to === "approved" ? [entry] : [],
  );
  const submitted =
    toSubmit.length === 0
      ? []
      : await transitionBatch({
          tx,
          spec: TRANSITIONS.timeEntries,
          ids: toSubmit.map(({ id }) => id),
          options: {
            from: [BILLING_STATUS.DRAFT],
            to: TIME_ENTRY_REVIEW_TRANSITIONS.submit.to,
            set: { updatedAt: now },
          },
          recordTransitionAuditEvent: recordStatusMoves(
            toSubmit,
            recordAuditEvent,
          ),
        });
  const approved =
    toApprove.length === 0
      ? []
      : await transitionBatch({
          tx,
          spec: TRANSITIONS.timeEntries,
          ids: toApprove.map(({ id }) => id),
          options: {
            from: [BILLING_STATUS.DRAFT],
            to: TIME_ENTRY_REVIEW_TRANSITIONS.approve.to,
            set: {
              approvedByUserId: userId,
              approvedAt: now,
              returnedAt: null,
              returnedByUserId: null,
              returnComment: null,
              updatedAt: now,
            },
          },
          recordTransitionAuditEvent: recordStatusMoves(
            toApprove,
            recordAuditEvent,
          ),
        });
  const approvedIds = new Set(approved.map(({ id }) => id));
  const matters = new Set(
    toApprove.flatMap((entry) =>
      entry.workspaceId === null || !approvedIds.has(entry.id)
        ? []
        : [entry.workspaceId],
    ),
  );
  await recordBillingCapCrossingsForMatters(tx, {
    workspaceIds: [...matters],
    recordAuditEvent,
  });
  return new Set([...submitted, ...approved].map(({ id }) => id));
};

/**
 * Submits the timekeeper's drafts for a range of work dates in one call. Each
 * draft moves on its own: it is submitted (or, on request, approved when the
 * timekeeper is its approver) or refused with its reason, and the rest still
 * move. Entries that are not drafts are left alone.
 */
export const submitTimeEntries = async ({
  safeDb,
  organizationId,
  userId,
  memberRole,
  startDate,
  endDate,
  approve,
  recordAuditEvent,
}: SubmitTimeEntriesOptions) => {
  const now = new Date();
  return await safeDb(async (tx) => {
    const policy = await lockTimePolicy(tx, organizationId);
    const drafts = await readOwnDrafts(tx, {
      organizationId,
      userId,
      startDate,
      endDate,
    });
    if (drafts.length > LIMITS.timeEntriesApprovalBatchMax) {
      return Result.err(
        new HandlerError({
          status: 409,
          code: "too_many_entries",
          message: `More than ${LIMITS.timeEntriesApprovalBatchMax} drafts fall in these dates`,
          hint: "Submit a shorter range, such as one day at a time.",
        }),
      );
    }
    const refused: TimeSubmitOutcome[] = [];
    const moves: Moved[] = [];
    for (const entry of drafts) {
      const reason = timeSubmitRefusal({ entry, policy, now });
      if (reason) {
        refused.push({ id: entry.id, status: "refused", reason });
        continue;
      }
      const to =
        approve &&
        canApproveAssignedTimeEntry({
          memberRole,
          currentUserId: userId,
          approverUserId: entry.approverUserId,
        })
          ? "approved"
          : "submitted";
      moves.push({ entry, to });
    }
    const moved = await writeMoves(tx, {
      userId,
      moves,
      now,
      recordAuditEvent,
    });
    // An entry that stopped being a draft since the read is left out.
    const results: TimeSubmitOutcome[] = [
      ...moves.flatMap(({ entry, to }) =>
        moved.has(entry.id) ? [{ id: entry.id, status: to }] : [],
      ),
      ...refused,
    ];
    return Result.ok({ results });
  });
};
