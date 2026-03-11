import { and, eq, gte, lte, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db";
import { timeEntries } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

import type { DateRangeQuery } from "./date-range-schema";

type SummaryHandlerProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  query: DateRangeQuery;
};

export const summaryHandler = async ({
  scopedDb,
  workspaceId,
  query,
}: SummaryHandlerProps) => {
  const conditions = [eq(timeEntries.workspaceId, workspaceId)];
  if (query.dateFrom) {
    conditions.push(gte(timeEntries.dateWorked, query.dateFrom));
  }
  if (query.dateTo) {
    conditions.push(lte(timeEntries.dateWorked, query.dateTo));
  }

  const rows = await scopedDb((tx) =>
    tx
      .select({
        totalMinutes: sql<number>`coalesce(sum(${timeEntries.durationMinutes}), 0)::int`,
        billedMinutes: sql<number>`coalesce(sum(case when ${timeEntries.billable} then ${timeEntries.billedMinutes} else 0 end), 0)::int`,
        billedAmount: sql<number>`coalesce(round(sum(case when ${timeEntries.billable} then ${timeEntries.billedMinutes}::numeric * ${timeEntries.rateAtEntry} / 60 else 0 end)), 0)::int`,
        entryCount: sql<number>`count(*)::int`,
        billableMinutes: sql<number>`coalesce(sum(case when ${timeEntries.billable} then ${timeEntries.durationMinutes} else 0 end), 0)::int`,
        currency: sql<string>`coalesce(mode() within group (order by ${timeEntries.currency}), 'USD')`,
      })
      .from(timeEntries)
      .where(and(...conditions)),
  );

  // Aggregate without GROUP BY always returns exactly one row
  const result = rows[0];
  if (!result) {
    return {
      totalMinutes: 0,
      billedMinutes: 0,
      billedAmount: 0,
      entryCount: 0,
      utilization: 0,
      currency: "USD",
    };
  }

  const utilization =
    result.totalMinutes > 0
      ? Math.round((result.billableMinutes / result.totalMinutes) * 100)
      : 0;

  return {
    totalMinutes: result.totalMinutes,
    billedMinutes: result.billedMinutes,
    billedAmount: result.billedAmount,
    entryCount: result.entryCount,
    utilization,
    currency: result.currency,
  };
};
