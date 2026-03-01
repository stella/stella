import { and, eq, isNotNull } from "drizzle-orm";
import { status } from "elysia";

import { db } from "@/api/db";
import { timeEntries } from "@/api/db/schema";
import { roundToIncrement } from "@/api/handlers/time-entries/create";

type TimerStopHandlerProps = {
  userId: string;
};

export const timerStopHandler = async ({ userId }: TimerStopHandlerProps) => {
  const [activeEntry] = await db
    .select({
      id: timeEntries.id,
      workspaceId: timeEntries.workspaceId,
      timerStartedAt: timeEntries.timerStartedAt,
    })
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.userId, userId),
        eq(timeEntries.source, "timer"),
        eq(timeEntries.status, "draft"),
        isNotNull(timeEntries.timerStartedAt),
      ),
    )
    .limit(1);

  if (!activeEntry?.timerStartedAt) {
    return status(404, {
      message: "No active timer found",
    });
  }

  const now = new Date();
  const elapsedMs = now.getTime() - activeEntry.timerStartedAt.getTime();
  const rawMinutes = Math.max(1, Math.round(elapsedMs / 60_000));
  const billedMinutes = roundToIncrement(rawMinutes);

  await db
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
        eq(timeEntries.workspaceId, activeEntry.workspaceId),
      ),
    );

  return {
    id: activeEntry.id,
    durationMinutes: rawMinutes,
    billedMinutes,
  };
};
