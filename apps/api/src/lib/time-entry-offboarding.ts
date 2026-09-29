import { APIError } from "better-auth/api";
import { Result } from "better-result";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { timeEntries, timeTimers, workspaces } from "@/api/db/schema";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import {
  DEFAULT_TIME_POLICY,
  getTimePeriodLockError,
  roundToBillingIncrement,
} from "@/api/lib/billing-time";
import type { SafeId } from "@/api/lib/branded-types";
import {
  lockTimerOwner,
  ownedTimers,
  pauseRunningTimers,
  timerSeconds,
} from "@/api/lib/billing/time-timers";

/**
 * Close the removed member's single active timer while the caller's
 * offboarding transaction owns the user/workspace locks.
 */
export const closeRemovedMemberActiveTimer = async ({
  organizationId,
  tx,
  userId,
}: {
  organizationId: SafeId<"organization">;
  tx: Transaction;
  userId: SafeId<"user">;
}) => {
  const owner = { organizationId, userId };
  await lockTimerOwner(tx, owner);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId}))`);

  const [activeTimer] = await tx
    .select({
      id: timeEntries.id,
      workspaceId: timeEntries.workspaceId,
    })
    .from(timeEntries)
    .innerJoin(workspaces, eq(workspaces.id, timeEntries.workspaceId))
    .where(
      and(
        eq(workspaces.organizationId, organizationId),
        eq(timeEntries.userId, userId),
        isNotNull(timeEntries.timerStartedAt),
        isNull(timeEntries.timerStoppedAt),
      ),
    )
    .limit(1);

  const recordAuditEvent = createBackgroundAuditRecorder({
    execution: {
      performer: {
        type: "service",
        id: "organization-member-removal",
        name: "Organization member removal",
      },
      trigger: {
        type: "system",
        source: "organization_member_removal",
      },
    },
    organizationId,
    userId,
    workspaceId: null,
  });

  if (activeTimer) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${activeTimer.workspaceId}))`,
    );
    const [lockedWorkspace] = await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, activeTimer.workspaceId))
      .for("update");
    const [timer] = lockedWorkspace
      ? await tx
          .select({
            billedMinutes: timeEntries.billedMinutes,
            dateWorked: timeEntries.dateWorked,
            durationMinutes: timeEntries.durationMinutes,
            id: timeEntries.id,
            timerStartedAt: timeEntries.timerStartedAt,
            clock: timeTimers,
          })
          .from(timeEntries)
          .leftJoin(
            timeTimers,
            and(
              eq(timeTimers.legacyTimeEntryId, timeEntries.id),
              ownedTimers(owner),
            ),
          )
          .where(
            and(
              eq(timeEntries.id, activeTimer.id),
              eq(timeEntries.workspaceId, activeTimer.workspaceId),
              eq(timeEntries.userId, userId),
              isNotNull(timeEntries.timerStartedAt),
              isNull(timeEntries.timerStoppedAt),
            ),
          )
          .limit(1)
          .for("update", { of: timeEntries })
      : [];

    if (timer?.timerStartedAt) {
      const settings = await tx.query.organizationSettings.findFirst({
        where: { organizationId: { eq: organizationId } },
        columns: {
          timeMinimumUnitMinutes: true,
          timeLockedThroughMonth: true,
        },
      });
      if (
        getTimePeriodLockError(
          { ...DEFAULT_TIME_POLICY, ...settings },
          timer.dateWorked,
        )
      ) {
        return Result.err(
          new APIError("BAD_REQUEST", {
            error: "time_period_locked",
            message:
              "The time period is locked. Move the locked-through month back before removing this member.",
          }),
        );
      }
      const minimumUnitMinutes =
        settings?.timeMinimumUnitMinutes ??
        DEFAULT_TIME_POLICY.timeMinimumUnitMinutes;
      const now = new Date();
      const durationMinutes = Math.max(
        1,
        Math.round(
          (timer.clock
            ? timerSeconds(timer.clock, now)
            : (now.getTime() - timer.timerStartedAt.getTime()) / 1000) / 60,
        ),
      );
      const billedMinutes = roundToBillingIncrement(
        durationMinutes,
        minimumUnitMinutes,
      );
      await tx
        .update(timeEntries)
        .set({
          durationMinutes,
          billedMinutes,
          timerStartedAt: null,
          timerStoppedAt: now,
          updatedAt: now,
        })
        .where(eq(timeEntries.id, timer.id));

      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.TIME_ENTRY,
        resourceId: timer.id,
        workspaceId: activeTimer.workspaceId,
        changes: {
          timerStartedAt: {
            old: timer.timerStartedAt.toISOString(),
            new: null,
          },
          timerStoppedAt: { old: null, new: now.toISOString() },
          durationMinutes: {
            old: timer.durationMinutes,
            new: durationMinutes,
          },
          billedMinutes: { old: timer.billedMinutes, new: billedMinutes },
        },
        metadata: { cause: "organization_member_removed" },
      });
    }
  }
  await pauseRunningTimers({
    tx,
    owner,
    now: new Date(),
    recordAuditEvent,
  });
  const [remaining] = await tx
    .select({ id: timeTimers.id })
    .from(timeTimers)
    .where(and(ownedTimers(owner), eq(timeTimers.state, "running")))
    .limit(1);
  if (remaining) {
    return Result.err(
      new APIError("BAD_REQUEST", {
        error: "timer_offboarding_incomplete",
        message: "Timers could not be stopped before member removal",
      }),
    );
  }
  return Result.ok(undefined);
};
