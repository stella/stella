import { and, eq, isNotNull, sql } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import type { ScopedDb } from "@/api/db";
import {
  BILLING_STATUS,
  TIME_ENTRY_SOURCE,
  timeEntries,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { tNanoid } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

export const timerStartBodySchema = t.Object({
  matterId: tNanoid,
  timezoneId: t.String({ minLength: 1, maxLength: 64 }),
  rateAtEntry: t.Integer({ minimum: 0 }),
  currency: t.String({ minLength: 3, maxLength: 3 }),
  narrative: t.Optional(t.String({ maxLength: 10_000 })),
});

type TimerStartBodySchema = Static<typeof timerStartBodySchema>;

type TimerStartHandlerProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: string;
  body: TimerStartBodySchema;
};

export const timerStartHandler = async ({
  scopedDb,
  organizationId,
  workspaceId,
  userId,
  body,
}: TimerStartHandlerProps) => {
  // Check active timer limit
  const activeTimerCount = await scopedDb((tx) =>
    tx.$count(
      timeEntries,
      and(
        eq(timeEntries.userId, userId),
        isNotNull(timeEntries.timerStartedAt),
        eq(timeEntries.source, TIME_ENTRY_SOURCE.TIMER),
        eq(timeEntries.status, BILLING_STATUS.DRAFT),
      ),
    ),
  );

  if (activeTimerCount >= LIMITS.activeTimersPerUser) {
    return status(400, {
      message: "You already have an active timer. Stop it first.",
    });
  }

  // Validate matter exists in workspace
  const matter = await scopedDb((tx) =>
    tx.query.entities.findFirst({
      where: { id: body.matterId, workspaceId: { eq: workspaceId } },
      columns: { id: true },
    }),
  );

  if (!matter) {
    return status(400, {
      message: "Matter not found in this workspace",
    });
  }

  const now = new Date();
  // en-CA locale formats dates as YYYY-MM-DD (ISO 8601)
  const todayStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: body.timezoneId,
  }).format(now);

  // Advisory lock + count + insert in one transaction to
  // prevent TOCTOU on the workspace time entry limit.
  const result = await scopedDb(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))`,
    );
    const totalEntries = await tx.$count(
      timeEntries,
      eq(timeEntries.workspaceId, workspaceId),
    );

    if (totalEntries >= LIMITS.timeEntriesPerWorkspace) {
      return null;
    }

    const [entry] = await tx
      .insert(timeEntries)
      .values({
        organizationId,
        workspaceId,
        userId,
        matterId: body.matterId,
        dateWorked: todayStr,
        timezoneId: body.timezoneId,
        durationMinutes: 0,
        billedMinutes: 0,
        rateAtEntry: body.rateAtEntry,
        currency: body.currency,
        narrative: body.narrative ?? "",
        source: TIME_ENTRY_SOURCE.TIMER,
        status: BILLING_STATUS.DRAFT,
        timerStartedAt: now,
      })
      .returning({
        id: timeEntries.id,
        timerStartedAt: timeEntries.timerStartedAt,
      });

    return entry;
  });

  if (!result) {
    return status(400, {
      message: "Time entries limit reached for this workspace",
    });
  }

  return {
    id: result.id,
    timerStartedAt: result.timerStartedAt?.toISOString(),
  };
};
