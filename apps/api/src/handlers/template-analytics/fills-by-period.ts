import { and, eq, gte, lte, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db";
import { templateFills } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import type {
  GRANULARITY_VALUES,
  PeriodQuery,
} from "../analytics/date-range-schema";

type FillsByPeriodHandlerProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  query: PeriodQuery;
};

const TRUNC_MAP: Record<(typeof GRANULARITY_VALUES)[number], string> = {
  day: "day",
  week: "week",
  month: "month",
};

export const fillsByPeriodHandler = ({
  scopedDb,
  organizationId,
  query,
}: FillsByPeriodHandlerProps) => {
  const granularity = query.granularity ?? "week";
  const trunc = TRUNC_MAP[granularity];

  const conditions = [eq(templateFills.organizationId, organizationId)];
  if (query.dateFrom) {
    conditions.push(gte(templateFills.createdAt, new Date(query.dateFrom)));
  }
  if (query.dateTo) {
    conditions.push(
      lte(templateFills.createdAt, new Date(`${query.dateTo}T23:59:59Z`)),
    );
  }

  return scopedDb((tx) =>
    tx
      .select({
        period: sql<string>`date_trunc(${sql.raw(`'${trunc}'`)}, ${templateFills.createdAt})::date::text`,
        count: sql<number>`count(*)::int`,
      })
      .from(templateFills)
      .where(and(...conditions))
      .groupBy(
        sql`date_trunc(${sql.raw(`'${trunc}'`)}, ${templateFills.createdAt})`,
      )
      .orderBy(
        sql`date_trunc(${sql.raw(`'${trunc}'`)}, ${templateFills.createdAt})`,
      )
      .limit(LIMITS.analyticsFillsByPeriodLimit),
  );
};
