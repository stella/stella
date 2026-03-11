import { and, eq, gte, lte, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db";
import { user } from "@/api/db/auth-schema";
import { timeEntries } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

import type { DateRangeQuery } from "./date-range-schema";

type HoursByUserHandlerProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  query: DateRangeQuery;
};

export const hoursByUserHandler = ({
  scopedDb,
  workspaceId,
  query,
}: HoursByUserHandlerProps) => {
  const conditions = [eq(timeEntries.workspaceId, workspaceId)];
  if (query.dateFrom) {
    conditions.push(gte(timeEntries.dateWorked, query.dateFrom));
  }
  if (query.dateTo) {
    conditions.push(lte(timeEntries.dateWorked, query.dateTo));
  }

  return scopedDb((tx) =>
    tx
      .select({
        userId: timeEntries.userId,
        userName: sql<string>`coalesce(${user.name}, 'Unknown')`,
        totalMinutes: sql<number>`coalesce(sum(${timeEntries.durationMinutes}), 0)::int`,
        count: sql<number>`count(*)::int`,
      })
      .from(timeEntries)
      .leftJoin(user, eq(timeEntries.userId, user.id))
      .where(and(...conditions))
      .groupBy(timeEntries.userId, user.name)
      .orderBy(sql`sum(${timeEntries.durationMinutes}) desc`)
      .limit(100),
  );
};
