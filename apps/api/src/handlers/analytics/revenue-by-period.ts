import { and, eq, gte, lte, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db";
import { timeEntries } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

import type { GRANULARITY_VALUES, PeriodQuery } from "./date-range-schema";

type RevenueByPeriodHandlerProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  query: PeriodQuery;
};

const TRUNC_MAP: Record<(typeof GRANULARITY_VALUES)[number], string> = {
  day: "day",
  week: "week",
  month: "month",
};

export const revenueByPeriodHandler = async ({
  scopedDb,
  workspaceId,
  query,
}: RevenueByPeriodHandlerProps) => {
  const granularity = query.granularity ?? "week";
  const trunc = TRUNC_MAP[granularity];

  const conditions = [eq(timeEntries.workspaceId, workspaceId)];
  if (query.dateFrom) {
    conditions.push(gte(timeEntries.dateWorked, query.dateFrom));
  }
  if (query.dateTo) {
    conditions.push(lte(timeEntries.dateWorked, query.dateTo));
  }

  return await scopedDb((tx) =>
    tx
      .select({
        period: sql<string>`date_trunc(${trunc}, ${timeEntries.dateWorked}::date)::date::text`,
        revenue: sql<number>`coalesce(round(sum(case when ${timeEntries.billable} then ${timeEntries.billedMinutes}::numeric * ${timeEntries.rateAtEntry} / 60 else 0 end)), 0)::int`,
      })
      .from(timeEntries)
      .where(and(...conditions))
      .groupBy(sql`date_trunc(${trunc}, ${timeEntries.dateWorked}::date)`)
      .orderBy(sql`date_trunc(${trunc}, ${timeEntries.dateWorked}::date)`),
  );
};
