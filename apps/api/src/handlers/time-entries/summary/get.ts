import { Result } from "better-result";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { t } from "elysia";

import { timeEntries } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { addDays, parseIsoDateLocal } from "@/api/lib/dates";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const MAX_SUMMARY_DAYS = 31;

const timeEntrySummaryQuerySchema = t.Object({
  dateFrom: t.String({ format: "date" }),
  dateTo: t.String({ format: "date" }),
});

const readTimeEntrySummary = createSafeHandler(
  {
    description:
      "Summarize the signed-in user's time in the current matter for a bounded date range.",
    permissions: { timeEntry: ["read"] },
    mcp: { type: "capability", reason: "billing_admin" },
    access: "read",
    query: timeEntrySummaryQuerySchema,
  },
  async function* ({ query, safeDb, user, workspaceId }) {
    const from = parseIsoDateLocal(query.dateFrom);
    const to = parseIsoDateLocal(query.dateTo);

    if (!from || !to || to < from || to > addDays(from, MAX_SUMMARY_DAYS - 1)) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: `Summary range must contain between 1 and ${MAX_SUMMARY_DAYS} days`,
        }),
      );
    }

    const [summary] = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            entryCount: sql<number>`count(*)::int`,
            totalMinutes: sql<number>`coalesce(sum(${timeEntries.durationMinutes}), 0)::int`,
            billedMinutes: sql<number>`coalesce(sum(${timeEntries.billedMinutes}), 0)::int`,
          })
          .from(timeEntries)
          .where(
            and(
              eq(timeEntries.workspaceId, workspaceId),
              eq(timeEntries.userId, user.id),
              gte(timeEntries.dateWorked, query.dateFrom),
              lte(timeEntries.dateWorked, query.dateTo),
            ),
          ),
      ),
    );

    return Result.ok(
      summary ?? { entryCount: 0, totalMinutes: 0, billedMinutes: 0 },
    );
  },
);

export default readTimeEntrySummary;
