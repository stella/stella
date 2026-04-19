import { Result } from "better-result";
import { and, eq, isNotNull } from "drizzle-orm";

import {
  BILLING_STATUS,
  TIME_ENTRY_SOURCE,
  timeEntries,
} from "@/api/db/schema";
import { roundToIncrement } from "@/api/handlers/time-entries/create";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const timerStop = createSafeHandler(
  {
    permissions: { timeEntry: ["update"] },
  },
  async function* ({ safeDb, user }) {
    const [activeEntry] = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: timeEntries.id,
            workspaceId: timeEntries.workspaceId,
            timerStartedAt: timeEntries.timerStartedAt,
          })
          .from(timeEntries)
          .where(
            and(
              eq(timeEntries.userId, user.id),
              eq(timeEntries.source, TIME_ENTRY_SOURCE.TIMER),
              eq(timeEntries.status, BILLING_STATUS.DRAFT),
              isNotNull(timeEntries.timerStartedAt),
            ),
          )
          .limit(1),
      ),
    );

    if (!activeEntry?.timerStartedAt) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "No active timer found",
        }),
      );
    }

    const now = new Date();
    const elapsedMs = now.getTime() - activeEntry.timerStartedAt.getTime();
    const rawMinutes = Math.max(1, Math.round(elapsedMs / 60_000));
    const billedMinutes = roundToIncrement(rawMinutes);

    yield* Result.await(
      safeDb((tx) =>
        tx
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
          ),
      ),
    );

    return Result.ok({
      id: activeEntry.id,
      durationMinutes: rawMinutes,
      billedMinutes,
    });
  },
);

export default timerStop;
