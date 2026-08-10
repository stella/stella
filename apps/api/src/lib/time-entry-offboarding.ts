import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { timeEntries, workspaces } from "@/api/db/schema";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import { roundToBillingIncrement } from "@/api/lib/billing-time";
import type { SafeId } from "@/api/lib/branded-types";

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
            durationMinutes: timeEntries.durationMinutes,
            id: timeEntries.id,
            timerStartedAt: timeEntries.timerStartedAt,
          })
          .from(timeEntries)
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
          .for("update")
      : [];

    if (timer?.timerStartedAt) {
      const now = new Date();
      const durationMinutes = Math.max(
        1,
        Math.round((now.getTime() - timer.timerStartedAt.getTime()) / 60_000),
      );
      const billedMinutes = roundToBillingIncrement(durationMinutes);
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
};
