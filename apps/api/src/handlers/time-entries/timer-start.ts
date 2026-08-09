import { Result } from "better-result";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { t } from "elysia";

import {
  ACTIVE_TIMER_INDEX_NAME,
  BILLING_STATUS,
  TIME_ENTRY_SOURCE,
  timeEntries,
  workspaces,
} from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { UNPRICED_TIME_ENTRY_CURRENCY } from "@/api/lib/billing-constants";
import { resolveRate } from "@/api/lib/billing-rates";
import { tSafeId } from "@/api/lib/custom-schema";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { cents } from "@/api/lib/money";
import { isPgConstraintError, PG_ERROR } from "@/api/lib/pg-error";
import { formatTodayInTimeZone } from "@/api/lib/timezone";

const timerStartBodySchema = t.Object({
  workItemId: t.Optional(t.Nullable(tSafeId("entity"))),
  timezoneId: t.String({ minLength: 1, maxLength: 64 }),
  narrative: t.Optional(t.String({ maxLength: 10_000 })),
});

const timerStart = createSafeHandler(
  {
    permissions: { timeEntry: ["create"] },
    mcp: { type: "capability", reason: "billing_admin" },
    body: timerStartBodySchema,
  },
  async function* ({
    safeDb,
    session,
    workspaceId,
    user,
    body,
    recordAuditEvent,
  }) {
    const now = new Date();
    const todayStr = yield* formatTodayInTimeZone({
      timezoneId: body.timezoneId,
      now,
    });

    // Validate the optional work context belongs to this matter.
    const workItemId = body.workItemId;
    const workItem = workItemId
      ? yield* Result.await(
          safeDb((tx) =>
            tx.query.entities.findFirst({
              where: {
                id: { eq: workItemId },
                workspaceId: { eq: workspaceId },
              },
              columns: { id: true },
            }),
          ),
        )
      : null;

    if (workItemId && !workItem) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Work item not found in this matter",
        }),
      );
    }

    const resolvedRate = yield* resolveRate({
      safeDb,
      workspaceId,
      userId: user.id,
      dateWorked: todayStr,
    });
    const rateAtEntry = resolvedRate?.hourlyRate ?? 0;
    const currency = resolvedRate?.currency ?? UNPRICED_TIME_ENTRY_CURRENCY;

    // Advisory lock + count + insert in one transaction to
    // prevent TOCTOU on the workspace time entry limit.
    const txResult = await safeDb(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${user.id}))`);
      const activeTimerCount = await tx.$count(
        timeEntries,
        and(
          eq(timeEntries.userId, user.id),
          isNotNull(timeEntries.timerStartedAt),
          eq(timeEntries.source, TIME_ENTRY_SOURCE.TIMER),
          eq(timeEntries.status, BILLING_STATUS.DRAFT),
        ),
      );
      if (activeTimerCount >= LIMITS.activeTimersPerUser) {
        return { type: "active_timer" as const };
      }

      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))`,
      );
      const [activeWorkspace] = await tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(
          and(eq(workspaces.id, workspaceId), eq(workspaces.status, "active")),
        )
        .limit(1);
      if (!activeWorkspace) {
        return { type: "workspace_inactive" as const };
      }
      const totalEntries = await tx.$count(
        timeEntries,
        eq(timeEntries.workspaceId, workspaceId),
      );

      if (totalEntries >= LIMITS.timeEntriesPerWorkspace) {
        return { type: "limit" as const };
      }

      const [entry] = await tx
        .insert(timeEntries)
        .values({
          organizationId: session.activeOrganizationId,
          workspaceId,
          userId: user.id,
          workItemId: workItemId ?? null,
          dateWorked: todayStr,
          timezoneId: body.timezoneId,
          durationMinutes: 0,
          billedMinutes: 0,
          rateAtEntry: cents(rateAtEntry),
          currency,
          narrative: body.narrative ?? "",
          source: TIME_ENTRY_SOURCE.TIMER,
          status: BILLING_STATUS.DRAFT,
          timerStartedAt: now,
        })
        .returning({
          id: timeEntries.id,
          timerStartedAt: timeEntries.timerStartedAt,
        });

      if (entry) {
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.TIME_ENTRY,
          resourceId: entry.id,
          changes: {
            created: {
              old: null,
              new: {
                workItemId: workItemId ?? null,
                dateWorked: todayStr,
                source: TIME_ENTRY_SOURCE.TIMER,
                status: BILLING_STATUS.DRAFT,
                timerStartedAt: now.toISOString(),
                rateAtEntry: cents(rateAtEntry),
                currency,
              },
            },
          },
        });
      }

      return entry
        ? { type: "created" as const, entry }
        : { type: "limit" as const };
    });

    if (Result.isError(txResult)) {
      if (
        DatabaseError.is(txResult.error) &&
        isPgConstraintError(
          txResult.error.cause,
          PG_ERROR.UNIQUE_VIOLATION,
          ACTIVE_TIMER_INDEX_NAME,
        )
      ) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "You already have an active timer. Stop it first.",
          }),
        );
      }
      return Result.err(txResult.error);
    }

    const txValue = txResult.value;

    if (txValue.type === "active_timer") {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "You already have an active timer. Stop it first.",
        }),
      );
    }

    if (txValue.type === "limit") {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Time entries limit reached for this workspace",
        }),
      );
    }

    if (txValue.type === "workspace_inactive") {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "This matter is no longer active",
        }),
      );
    }

    return Result.ok({
      id: txValue.entry.id,
      timerStartedAt: txValue.entry.timerStartedAt?.toISOString(),
    });
  },
);

export default timerStart;
