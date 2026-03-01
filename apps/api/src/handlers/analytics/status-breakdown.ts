import { and, eq, gte, lte, sql } from "drizzle-orm";

import { db } from "@/api/db";
import { timeEntries } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { DateRangeQuery } from "./date-range-schema";

type StatusBreakdownHandlerProps = {
  workspaceId: SafeId<"workspace">;
  query: DateRangeQuery;
};

export const statusBreakdownHandler = ({
  workspaceId,
  query,
}: StatusBreakdownHandlerProps) => {
  const conditions = [eq(timeEntries.workspaceId, workspaceId)];
  if (query.dateFrom) {
    conditions.push(gte(timeEntries.dateWorked, query.dateFrom));
  }
  if (query.dateTo) {
    conditions.push(lte(timeEntries.dateWorked, query.dateTo));
  }

  return db
    .select({
      status: timeEntries.status,
      count: sql<number>`count(*)::int`,
      totalMinutes: sql<number>`coalesce(sum(${timeEntries.durationMinutes}), 0)::int`,
    })
    .from(timeEntries)
    .where(and(...conditions))
    .groupBy(timeEntries.status)
    .orderBy(sql`count(*) desc`);
};
