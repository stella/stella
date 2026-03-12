import { and, eq, gte, lte, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db";
import { templateFills, templates } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

import type { DateRangeQuery } from "../analytics/date-range-schema";

type TopTemplatesHandlerProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  query: DateRangeQuery;
};

export const topTemplatesHandler = async ({
  scopedDb,
  organizationId,
  query,
}: TopTemplatesHandlerProps) => {
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
        templateId: templateFills.templateId,
        name: sql<string>`coalesce(${templates.name}, 'Deleted template')`,
        count: sql<number>`count(*)::int`,
      })
      .from(templateFills)
      .leftJoin(templates, eq(templateFills.templateId, templates.id))
      .where(and(...conditions))
      .groupBy(templateFills.templateId, templates.name)
      .orderBy(sql`count(*) desc`)
      .limit(LIMITS.analyticsTopTemplatesLimit),
  );
};
