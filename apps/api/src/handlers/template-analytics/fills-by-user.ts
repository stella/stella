import { and, eq, gte, lte, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db";
import { user } from "@/api/db/auth-schema";
import { templateFills } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

import type { DateRangeQuery } from "../analytics/date-range-schema";

type FillsByUserHandlerProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  query: DateRangeQuery;
};

export const fillsByUserHandler = async ({
  scopedDb,
  organizationId,
  query,
}: FillsByUserHandlerProps) => {
  const conditions = [eq(templateFills.organizationId, organizationId)];
  if (query.dateFrom) {
    conditions.push(gte(templateFills.createdAt, new Date(query.dateFrom)));
  }
  if (query.dateTo) {
    conditions.push(
      lte(templateFills.createdAt, new Date(`${query.dateTo}T23:59:59Z`)),
    );
  }

  return await scopedDb((tx) =>
    tx
      .select({
        userId: templateFills.userId,
        userName: sql<string>`coalesce(${user.name}, 'Unknown')`,
        count: sql<number>`count(*)::int`,
      })
      .from(templateFills)
      .leftJoin(user, eq(templateFills.userId, user.id))
      .where(and(...conditions))
      .groupBy(templateFills.userId, user.name)
      .orderBy(sql`count(*) desc`)
      .limit(LIMITS.analyticsFillsByUserLimit),
  );
};
