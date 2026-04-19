import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { user } from "@/api/db/auth-schema";
import { timeEntries } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const readTimeEntryByIdParamsSchema = t.Object({
  id: tNanoid,
});

const readTimeEntryById = createSafeHandler(
  {
    permissions: { workspace: ["read"] },
    params: readTimeEntryByIdParamsSchema,
  },
  async function* ({ safeDb, workspaceId, params }) {
    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: timeEntries.id,
            userId: timeEntries.userId,
            matterId: timeEntries.matterId,
            dateWorked: timeEntries.dateWorked,
            timezoneId: timeEntries.timezoneId,
            durationMinutes: timeEntries.durationMinutes,
            billedMinutes: timeEntries.billedMinutes,
            rateAtEntry: timeEntries.rateAtEntry,
            currency: timeEntries.currency,
            narrative: timeEntries.narrative,
            invoiceNarrative: timeEntries.invoiceNarrative,
            billable: timeEntries.billable,
            noCharge: timeEntries.noCharge,
            status: timeEntries.status,
            source: timeEntries.source,
            taskCode: timeEntries.taskCode,
            activityCode: timeEntries.activityCode,
            timerStartedAt: timeEntries.timerStartedAt,
            timerStoppedAt: timeEntries.timerStoppedAt,
            createdAt: timeEntries.createdAt,
            updatedAt: timeEntries.updatedAt,
          })
          .from(timeEntries)
          .where(
            and(
              eq(timeEntries.id, params.id),
              eq(timeEntries.workspaceId, workspaceId),
            ),
          ),
      ),
    );
    const row = rows.at(0);

    if (!row) {
      return Result.err(
        new HandlerError({ status: 404, message: "Time entry not found" }),
      );
    }

    let userName: string | null = null;
    const rowUserId = row.userId;
    if (rowUserId) {
      const [u] = yield* Result.await(
        safeDb((tx) =>
          tx
            .select({ name: user.name })
            .from(user)
            .where(eq(user.id, rowUserId)),
        ),
      );
      userName = u?.name ?? null;
    }

    return Result.ok({
      ...row,
      userName,
      timerStartedAt: row.timerStartedAt?.toISOString() ?? null,
      timerStoppedAt: row.timerStoppedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt?.toISOString() ?? null,
    });
  },
);

export default readTimeEntryById;
