import { Result } from "better-result";
import { and, eq, isNotNull, sql } from "drizzle-orm";

import {
  BILLING_STATUS,
  TIME_ENTRY_SOURCE,
  timeEntries,
} from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import {
  getTimePeriodLockError,
  readTimePolicy,
  roundToBillingIncrement,
} from "@/api/lib/billing-time";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const timerStop = createSafeHandler(
  {
    description:
      "Stop the signed-in user's running timer in the current matter, " +
      "writing the elapsed minutes onto its draft time entry and rounding " +
      "the billed minutes up to the billing increment. Fails when that user " +
      "has no running timer in this matter.",
    permissions: { timeEntry: ["update"] },
    mcp: { type: "capability", reason: "billing_admin" },
  },
  async function* ({ safeDb, session, user, workspaceId, recordAuditEvent }) {
    const policy = yield* Result.await(
      readTimePolicy({
        safeDb,
        organizationId: session.activeOrganizationId,
      }),
    );
    const now = new Date();
    const stoppedEntry = yield* Result.await(
      safeDb(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${user.id}))`,
        );
        const [activeEntry] = await tx
          .select({
            id: timeEntries.id,
            dateWorked: timeEntries.dateWorked,
            timerStartedAt: timeEntries.timerStartedAt,
          })
          .from(timeEntries)
          .where(
            and(
              eq(timeEntries.userId, user.id),
              eq(timeEntries.workspaceId, workspaceId),
              eq(timeEntries.source, TIME_ENTRY_SOURCE.TIMER),
              eq(timeEntries.status, BILLING_STATUS.DRAFT),
              isNotNull(timeEntries.timerStartedAt),
            ),
          )
          .limit(1)
          .for("update");

        if (!activeEntry?.timerStartedAt) {
          return null;
        }

        const violation = getTimePeriodLockError(
          policy,
          activeEntry.dateWorked,
        );
        if (violation) {
          return { type: "violation" as const, error: violation };
        }

        const startedAt = activeEntry.timerStartedAt;
        const elapsedMs = now.getTime() - startedAt.getTime();
        const rawMinutes = Math.max(1, Math.round(elapsedMs / 60_000));
        const billedMinutes = roundToBillingIncrement(
          rawMinutes,
          policy.timeMinimumUnitMinutes,
        );

        await tx
          .update(timeEntries)
          .set({
            durationMinutes: rawMinutes,
            billedMinutes,
            timerStartedAt: null,
            timerStoppedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(timeEntries.id, activeEntry.id),
              eq(timeEntries.workspaceId, workspaceId),
            ),
          );

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.TIME_ENTRY,
          resourceId: activeEntry.id,
          workspaceId,
          changes: {
            timerStartedAt: {
              old: startedAt.toISOString(),
              new: null,
            },
            timerStoppedAt: { old: null, new: now.toISOString() },
            durationMinutes: { old: 0, new: rawMinutes },
            billedMinutes: { old: 0, new: billedMinutes },
          },
        });

        return {
          type: "stopped" as const,
          id: activeEntry.id,
          durationMinutes: rawMinutes,
          billedMinutes,
        };
      }),
    );

    if (!stoppedEntry) {
      return Result.err(
        new HandlerError({ status: 404, message: "No active timer found" }),
      );
    }

    if (stoppedEntry.type === "violation") {
      return Result.err(stoppedEntry.error);
    }

    return Result.ok({
      id: stoppedEntry.id,
      durationMinutes: stoppedEntry.durationMinutes,
      billedMinutes: stoppedEntry.billedMinutes,
    });
  },
);

export default timerStop;
