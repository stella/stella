import { panic, Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import { t } from "elysia";

import type { Transaction } from "@/api/db/root";
import {
  BILLING_STATUS,
  TIME_ENTRY_SOURCE,
  timeEntries,
  timeTimers,
} from "@/api/db/schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";

export const timerParams = t.Object({ id: tSafeId("timeTimer") });
export const timerDetails = t.Object({
  matterId: t.Optional(t.Nullable(tSafeId("workspace"))),
  description: t.Optional(t.Nullable(t.String({ maxLength: 10_000 }))),
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

export const timerNotFound = () =>
  new HandlerError({
    status: 404,
    message: "Timer not found",
    hint: "List your timers before choosing a timer ID.",
  });

export const lockTimerOwner = async (tx: Transaction, owner: TimerOwner) => {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`timer:${owner.organizationId}:${owner.userId}`}))`,
  );
};

type ReadOwnedTimerOptions = {
  tx: Transaction;
  owner: TimerOwner;
  id: SafeId<"timeTimer">;
};
export const readOwnedTimer = async ({
  tx,
  owner,
  id,
}: ReadOwnedTimerOptions) => {
  const [timer] = await tx
    .select()
    .from(timeTimers)
    .where(and(ownedTimers(owner), eq(timeTimers.id, id)))
    .limit(1)
    .for("update");
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

type ChangeTimerStateOptions = {
  tx: Transaction;
  owner: TimerOwner;
  id: SafeId<"timeTimer">;
  state: (typeof timeTimers.$inferSelect)["state"];
  recordAuditEvent: AuditRecorder;
};
export const changeTimerState = async ({
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
