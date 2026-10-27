import { panic, Result } from "better-result";
import {
  and,
  asc,
  eq,
  getColumns,
  gt,
  gte,
  inArray,
  lte,
  ne,
  not,
  or,
  sql,
} from "drizzle-orm";

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
import {
  canApproveAssignedTimeEntry,
  canApproveTimeEntries,
} from "@/api/lib/billing/time-entry-authorization";
import { timeEntryIsRunning } from "@/api/lib/billing/time-entry-running";
import type { SafeId } from "@/api/lib/branded-types";
import { readBounded } from "@/api/lib/db/read-bounded";
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
  await readBounded(
    tx
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
      .orderBy(asc(timeEntries.dateWorked), asc(timeEntries.id)),
    LIMITS.timeEntriesApprovalBatchMax,
  );

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

type SubmitScope = {
  userId: SafeId<"user">;
  memberRole: AuthorizedMemberRole;
  startDate: string;
  endDate: string;
  policy: TimePolicy;
  now: Date;
};

/**
 * Every submit precondition, as the write's own condition: the entry is still
 * the timekeeper's, in the dates, not running, priced, described when the
 * policy asks for it, not in a locked month, not in the future in its zone,
 * and in a live matter (or internal). `timeSubmitRefusal` names the reason for
 * a row that fails it; the two must list the same rules.
 */
const submitGuard = ({
  userId,
  startDate,
  endDate,
  policy,
  now,
}: Omit<SubmitScope, "memberRole">) =>
  and(
    eq(timeEntries.userId, userId),
    gte(timeEntries.dateWorked, startDate),
    lte(timeEntries.dateWorked, endDate),
    sql`NOT ${timeEntryIsRunning()}`,
    not(
      and(
        eq(timeEntries.activityGroup, TIME_ENTRY_ACTIVITY_GROUP.CLIENT),
        eq(timeEntries.billable, true),
        eq(timeEntries.currency, UNPRICED_TIME_ENTRY_CURRENCY),
      ) ?? panic("The unpriced condition is never empty"),
    ),
    policy.timeNarrativeRequired
      ? sql`${timeEntries.narrative} ~ '[^[:space:]]'`
      : undefined,
    policy.timeLockedThroughMonth === null
      ? undefined
      : gt(timeEntries.dateWorked, policy.timeLockedThroughMonth),
    sql`${timeEntries.dateWorked} <= (${now.toISOString()}::timestamptz AT TIME ZONE ${timeEntries.timezoneId})::date`,
    // Internal work has no matter, so only a matter being deleted excludes.
    sql`NOT EXISTS (SELECT 1 FROM ${workspaces} WHERE ${workspaces.id} = ${timeEntries.workspaceId} AND ${workspaces.status} = 'deleting')`,
  ) ?? panic("The submit guard is never empty");

// Approving in the same step also needs the approver to be the timekeeper,
// unless they approve everyone's time.
const approveGuard = (scope: SubmitScope) =>
  canApproveTimeEntries(scope.memberRole)
    ? submitGuard(scope)
    : (and(submitGuard(scope), eq(timeEntries.approverUserId, scope.userId)) ??
      panic("The approve guard is never empty"));

// Moves the drafts in two guarded batches; returns the ids that moved.
const writeMoves = async (
  tx: Transaction,
  {
    scope,
    moves,
    recordAuditEvent,
  }: {
    scope: SubmitScope;
    moves: readonly Moved[];
    recordAuditEvent: AuditRecorder;
  },
) => {
  const { userId, now } = scope;
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
            guard: submitGuard(scope),
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
            guard: approveGuard(scope),
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
 * Why each draft the guarded write left in place did not move, read again
 * after the write: it changed since the first read. Never silently skipped.
 */
const refusalsOfUnmoved = async (
  tx: Transaction,
  {
    ids,
    organizationId,
    policy,
    now,
  }: {
    ids: readonly SafeId<"timeEntry">[];
    organizationId: SafeId<"organization">;
    policy: TimePolicy;
    now: Date;
  },
): Promise<TimeSubmitOutcome[]> => {
  if (ids.length === 0) {
    return [];
  }
  const rows = await tx
    .select({ ...getColumns(timeEntries), running: timeEntryIsRunning() })
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.organizationId, organizationId),
        inArray(timeEntries.id, [...ids]),
      ),
    )
    .limit(ids.length);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const reasonFor = (entry: SubmissionEntry | undefined): TimeSubmitRefusal => {
    if (entry === undefined) {
      return "not_found";
    }
    if (entry.status !== BILLING_STATUS.DRAFT) {
      return "wrong_status";
    }
    // Still a draft: whatever it now fails, or a change the read cannot name
    // (it moved out of the dates or to another approver).
    return timeSubmitRefusal({ entry, policy, now }) ?? "invalid_entry";
  };
  return ids.map((id) => ({
    id,
    status: "refused",
    reason: reasonFor(byId.get(id)),
  }));
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
    if (drafts.type === "overflow") {
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
    for (const entry of drafts.rows) {
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
      scope: { userId, memberRole, startDate, endDate, policy, now },
      moves,
      recordAuditEvent,
    });
    const unmoved = await refusalsOfUnmoved(tx, {
      ids: moves.flatMap(({ entry }) =>
        moved.has(entry.id) ? [] : [entry.id],
      ),
      organizationId,
      policy,
      now,
    });
    const results: TimeSubmitOutcome[] = [
      ...moves.flatMap(({ entry, to }) =>
        moved.has(entry.id) ? [{ id: entry.id, status: to }] : [],
      ),
      ...unmoved,
      ...refused,
    ];
    return Result.ok({ results });
  });
};
