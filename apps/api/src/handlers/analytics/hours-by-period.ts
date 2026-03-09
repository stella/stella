import { and, eq, gte, lte, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db";
import { timeEntries } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { GRANULARITY_VALUES, PeriodQuery } from "./date-range-schema";

type HoursByPeriodHandlerProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  query: PeriodQuery;
};

const TRUNC_MAP: Record<(typeof GRANULARITY_VALUES)[number], string> = {
  day: "day",
  week: "week",
  month: "month",
};

export const hoursByPeriodHandler = ({
  scopedDb,
  workspaceId,
  query,
}: HoursByPeriodHandlerProps) => {
  const granularity = query.granularity ?? "week";
  const trunc = TRUNC_MAP[granularity];

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
        period: sql<string>`date_trunc(${trunc}, ${timeEntries.dateWorked}::date)::date::text`,
        totalMinutes: sql<number>`coalesce(sum(${timeEntries.durationMinutes}), 0)::int`,
      })
      .from(timeEntries)
      .where(and(...conditions))
      .groupBy(sql`date_trunc(${trunc}, ${timeEntries.dateWorked}::date)`)
      .orderBy(sql`date_trunc(${trunc}, ${timeEntries.dateWorked}::date)`),
  );
};
