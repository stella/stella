import { Type } from "@sinclair/typebox";
import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { member } from "@/api/db/auth-schema";
import type { SafeDb } from "@/api/db/safe-db";
import { timeDailyTargets } from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const DAILY_TARGET_MAX_MINUTES = 1440;
export const dailyTargetBody = t.Object({
  minutes: t.Nullable(
    Type.Integer({ minimum: 1, maximum: DAILY_TARGET_MAX_MINUTES }),
    { description: "Daily target in minutes; null clears the target" },
  ),
});

export const leftTodayMinutes = (target: number | null, logged: number) =>
  target === null ? null : Math.max(0, target - logged);

type SetDailyTargetOptions = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  minutes: number | null;
  recordAuditEvent: AuditRecorder;
};
export const setDailyTarget = async function* ({
  safeDb,
  organizationId,
  userId,
  minutes,
  recordAuditEvent,
}: SetDailyTargetOptions) {
  if (
    minutes !== null &&
    (!Number.isInteger(minutes) ||
      minutes <= 0 ||
      minutes > DAILY_TARGET_MAX_MINUTES)
  ) {
    return Result.err(
      new HandlerError({
        status: 400,
        code: "invalid_daily_target",
        message: "Daily target must be between 1 and 1440 minutes",
        hint: "Pass an integer from 1 to 1440, or null to clear the target.",
      }),
    );
  }
  const outcome = yield* Result.await(
    safeDb(async (tx) => {
      // Lock the membership to serialize target changes and prevent removal mid-write.
      const memberships = await tx
        .select({ id: member.id })
        .from(member)
        .where(
          and(
            eq(member.organizationId, organizationId),
            eq(member.userId, userId),
          ),
        )
        .limit(1)
        .for("update");
      const membership = memberships.at(0);
      if (membership === undefined) {
        return Result.err(
          new HandlerError({
            status: 404,
            code: "daily_target_member_not_found",
            message: "Member not found in the active organization",
            hint: "Choose a current member of the active organization.",
          }),
        );
      }
      const existingRows = await tx
        .select({ minutes: timeDailyTargets.minutes })
        .from(timeDailyTargets)
        .where(
          and(
            eq(timeDailyTargets.organizationId, organizationId),
            eq(timeDailyTargets.userId, userId),
          ),
        )
        .limit(1);
      const previous = existingRows.at(0)?.minutes ?? null;
      if (previous === minutes) {
        return Result.ok({ dailyTargetMinutes: minutes });
      }
      const rows = await tx
        .insert(timeDailyTargets)
        .values({ organizationId, userId, minutes })
        .onConflictDoUpdate({
          target: [timeDailyTargets.organizationId, timeDailyTargets.userId],
          set: { minutes, updatedAt: new Date() },
        })
        .returning({ minutes: timeDailyTargets.minutes });
      const updated = rows.at(0);
      if (updated === undefined) {
        return panic("Daily target update returned no row");
      }
      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.TIME_DAILY_TARGET,
        resourceId: membership.id,
        changes: { minutes: { old: previous, new: minutes } },
      });
      return Result.ok({ dailyTargetMinutes: updated.minutes });
    }),
  );
  return Result.ok(yield* outcome);
};
