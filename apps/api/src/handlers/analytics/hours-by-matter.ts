import { and, eq, gte, lte, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db";
import { entities, timeEntries } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

import type { DateRangeQuery } from "./date-range-schema";

type HoursByMatterHandlerProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  query: DateRangeQuery;
};

export const hoursByMatterHandler = ({
  scopedDb,
  workspaceId,
  query,
}: HoursByMatterHandlerProps) => {
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
        matterId: timeEntries.matterId,
        matterName: sql<string>`coalesce(${entities.name}, 'Untitled')`,
        totalMinutes: sql<number>`coalesce(sum(${timeEntries.durationMinutes}), 0)::int`,
        billedMinutes: sql<number>`coalesce(sum(case when ${timeEntries.billable} then ${timeEntries.billedMinutes} else 0 end), 0)::int`,
        count: sql<number>`count(*)::int`,
      })
      .from(timeEntries)
      .leftJoin(entities, eq(timeEntries.matterId, entities.id))
      .where(and(...conditions))
      .groupBy(timeEntries.matterId, entities.name)
      .orderBy(sql`sum(${timeEntries.durationMinutes}) desc`)
      .limit(100),
  );
};
