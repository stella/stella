import { panic, Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import * as v from "valibot";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  BILLING_STATUS,
  TIME_ENTRY_SOURCE,
  timeEntries,
  timeTimers,
} from "@/api/db/schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { lockTimerOwnerIdentities } from "@/api/lib/db/aggregate-lock";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";

export const timerParams = v.object({ id: resourceIdSchema("timeTimer") });
export const timerDetails = v.object({
  matterId: v.optional(v.nullable(resourceIdSchema("workspace"))),
  description: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(10_000)))),
});

export type TimerOwner = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

// Ownership is deliberately independent of the organization's administrative role.
export const ownedTimers = ({ organizationId, userId }: TimerOwner) =>
  and(
    eq(timeTimers.organizationId, organizationId),
    eq(timeTimers.userId, userId),
  );

export const timerNotFound = (caller: "owner" | "admin" = "owner") =>
  new HandlerError({
    status: 404,
    message: "Timer not found",
    hint:
      caller === "admin"
        ? "List organization running timers with time-timers.admin.list before choosing a timer ID."
        : "List your timers before choosing a timer ID.",
  });

export const timerScopeChanged = () =>
  new HandlerError({
    status: 409,
    code: "timer_scope_changed",
    message: "The timer changed. Reload timers and retry.",
  });

export const lockTimerOwner = async (tx: Transaction, owner: TimerOwner) => {
  await lockTimerOwnerIdentities({ tx, owners: [owner] });
};

type ReadOwnedTimerOptions = {
  tx: Transaction;
  owner: TimerOwner;
  id: SafeId<"timeTimer">;
  lock?: "update" | "advisory";
};
export const readOwnedTimer = async ({
  tx,
  owner,
  id,
  lock = "update",
}: ReadOwnedTimerOptions) => {
  const query = tx
    .select()
    .from(timeTimers)
    .where(and(ownedTimers(owner), eq(timeTimers.id, id)))
    .limit(1);
  // Admin completion has DELETE permission only; the owner advisory lock
  // serializes its read with every timer mutation without an UPDATE policy.
  const [timer] = lock === "update" ? await query.for("update") : await query;
  return timer;
};

export const timerSeconds = (
  timer: typeof timeTimers.$inferSelect,
  now: Date,
) => {
  switch (timer.state) {
    case "paused":
      return timer.accumulatedSeconds;
    case "running": {
      const resumedAt = timer.lastResumedAt;
      if (!resumedAt) {
        return panic("Running timer has no resume timestamp");
      }
      return (
        timer.accumulatedSeconds +
        Math.max(0, Math.floor((now.getTime() - resumedAt.getTime()) / 1000))
      );
    }
    default:
      timer.state satisfies never;
      return panic("Unknown timer state");
  }
};

export const timerItem = (timer: typeof timeTimers.$inferSelect) => ({
  id: timer.id,
  matterId: timer.workspaceId,
  description: timer.description,
  state: timer.state,
  startedAt: timer.startedAt.toISOString(),
  accumulatedSeconds: timer.accumulatedSeconds,
  lastResumedAt: timer.lastResumedAt?.toISOString() ?? null,
  createdAt: timer.createdAt.toISOString(),
  updatedAt: timer.updatedAt.toISOString(),
});

type TimerProjectionSource = Omit<
  typeof timeTimers.$inferSelect,
  "workspaceId"
> & {
  matterId: (typeof timeTimers.$inferSelect)["workspaceId"];
};
const UNPROJECTED_TIMER_COLUMNS = [
  "organizationId",
  "userId",
  "legacyTimeEntryId",
] as const satisfies readonly (keyof TimerProjectionSource)[];
type MissingTimerColumn = UnprojectedColumns<
  TimerProjectionSource,
  ReturnType<typeof timerItem>,
  (typeof UNPROJECTED_TIMER_COLUMNS)[number]
>;
type UnexpectedTimerColumn = UnbackedProjectionKeys<
  TimerProjectionSource,
  ReturnType<typeof timerItem>,
  (typeof UNPROJECTED_TIMER_COLUMNS)[number]
>;
true satisfies MissingTimerColumn extends never ? true : never;
true satisfies UnexpectedTimerColumn extends never ? true : never;

// A migrated timer runs on its original draft entry. Submitting or approving
// that entry takes this owner lock and refuses a running timer, so under the
// lock a resume sees whether the entry is still a draft it may run on.
const linkedEntryIsDraft = async (
  tx: Transaction,
  owner: TimerOwner,
  timer: typeof timeTimers.$inferSelect,
) => {
  if (timer.legacyTimeEntryId === null) {
    return true;
  }
  const [entry] = await tx
    .select({ status: timeEntries.status })
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.id, timer.legacyTimeEntryId),
        eq(timeEntries.organizationId, owner.organizationId),
        eq(timeEntries.userId, owner.userId),
      ),
    )
    .limit(1);
  return entry === undefined || entry.status === BILLING_STATUS.DRAFT;
};

type ChangeTimerStateOptions = {
  tx: Transaction;
  owner: TimerOwner;
  id: SafeId<"timeTimer">;
  state: (typeof timeTimers.$inferSelect)["state"];
  recordAuditEvent: AuditRecorder;
};
const changeTimerState = async ({
  tx,
  owner,
  id,
  state,
  recordAuditEvent,
}: ChangeTimerStateOptions) => {
  await lockTimerOwner(tx, owner);
  const timer = await readOwnedTimer({ tx, owner, id });
  if (!timer) {
    return Result.err(timerNotFound());
  }
  if (timer.state === state) {
    return Result.ok(timerItem(timer));
  }
  if (state === "running" && !(await linkedEntryIsDraft(tx, owner, timer))) {
    return Result.err(
      new HandlerError({
        status: 409,
        code: "timer_original_entry_changed",
        message: "The original timer entry has changed",
        hint: "The entry this timer runs on was submitted or approved. Confirm or discard the timer instead of resuming it.",
      }),
    );
  }
  const now = new Date();
  if (state === "running") {
    await pauseRunningTimers({ tx, owner, now, recordAuditEvent });
  }
  const [changed] = await tx
    .update(timeTimers)
    .set({
      state,
      accumulatedSeconds: timerSeconds(timer, now),
      lastResumedAt: state === "running" ? now : null,
      updatedAt: now,
    })
    .where(and(ownedTimers(owner), eq(timeTimers.id, timer.id)))
    .returning();
  if (!changed) {
    return panic("Locked timer update returned no row");
  }
  await recordAuditEvent(tx, {
    action: AUDIT_ACTION.UPDATE,
    resourceType: AUDIT_RESOURCE_TYPE.TIME_TIMER,
    resourceId: timer.id,
    workspaceId: timer.workspaceId,
    changes: { state: { old: timer.state, new: state } },
  });
  return Result.ok(timerItem(changed));
};

type PauseRunningTimersOptions = {
  tx: Transaction;
  owner: TimerOwner;
  now: Date;
  recordAuditEvent: AuditRecorder;
};

export const pauseRunningTimers = async ({
  tx,
  owner,
  now,
  recordAuditEvent,
}: PauseRunningTimersOptions) => {
  const paused = await tx
    .update(timeTimers)
    .set({
      state: "paused",
      accumulatedSeconds: sql`${timeTimers.accumulatedSeconds} + GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (${now.toISOString()}::timestamptz - ${timeTimers.lastResumedAt}))))::integer`,
      lastResumedAt: null,
      updatedAt: now,
    })
    .where(and(ownedTimers(owner), eq(timeTimers.state, "running")))
    .returning();
  if (paused.length === 0) {
    return;
  }
  await recordAuditEvent(
    tx,
    paused.map((timer) => ({
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.TIME_TIMER,
      resourceId: timer.id,
      workspaceId: timer.workspaceId,
      changes: { state: { old: "running", new: "paused" } },
    })),
  );
};

type DeleteLegacyTimerDraftOptions = {
  tx: Transaction;
  owner: TimerOwner;
  entry: typeof timeEntries.$inferSelect;
  timerId: SafeId<"timeTimer">;
  recordAuditEvent: AuditRecorder;
};
export const deleteLegacyTimerDraft = async ({
  tx,
  owner,
  entry,
  timerId,
  recordAuditEvent,
}: DeleteLegacyTimerDraftOptions) => {
  if (
    entry.status !== BILLING_STATUS.DRAFT ||
    entry.source !== TIME_ENTRY_SOURCE.TIMER
  ) {
    return;
  }
  await tx
    .delete(timeEntries)
    .where(
      and(
        eq(timeEntries.id, entry.id),
        eq(timeEntries.organizationId, owner.organizationId),
        eq(timeEntries.userId, owner.userId),
        eq(timeEntries.status, BILLING_STATUS.DRAFT),
        eq(timeEntries.source, TIME_ENTRY_SOURCE.TIMER),
      ),
    );
  await recordAuditEvent(tx, {
    action: AUDIT_ACTION.DELETE,
    resourceType: AUDIT_RESOURCE_TYPE.TIME_ENTRY,
    resourceId: entry.id,
    workspaceId: entry.workspaceId,
    changes: { migratedTimerId: { old: timerId, new: null } },
  });
};

type TimerStateTransitionContext = {
  safeDb: SafeDb;
  session: { activeOrganizationId: SafeId<"organization"> };
  user: { id: SafeId<"user"> };
  params: { id: SafeId<"timeTimer"> };
  recordAuditEvent: AuditRecorder;
};
export const timerStateTransition = (state: "running" | "paused") =>
  async function* ({
    safeDb,
    session,
    user,
    params,
    recordAuditEvent,
  }: TimerStateTransitionContext) {
    const outcome = yield* Result.await(
      safeDb(async (tx) =>
        changeTimerState({
          tx,
          owner: {
            organizationId: session.activeOrganizationId,
            userId: user.id,
          },
          id: params.id,
          state,
          recordAuditEvent,
        }),
      ),
    );
    return Result.ok(yield* outcome);
  };
