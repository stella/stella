import { and, countDistinct, eq, gte, lte, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db";
import { templateFills, templates } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

import type { DateRangeQuery } from "../analytics/date-range-schema";

type SummaryHandlerProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  query: DateRangeQuery;
};

export const summaryHandler = async ({
  scopedDb,
  organizationId,
  query,
}: SummaryHandlerProps) => {
  const conditions = [eq(templateFills.organizationId, organizationId)];
  if (query.dateFrom) {
    conditions.push(gte(templateFills.createdAt, new Date(query.dateFrom)));
  }
  if (query.dateTo) {
    conditions.push(
      lte(templateFills.createdAt, new Date(`${query.dateTo}T23:59:59Z`)),
    );
  }

  const rows = await scopedDb((tx) =>
    tx
      .select({
        totalFills: sql<number>`count(*)::int`,
        uniqueTemplates: countDistinct(templateFills.templateId),
        pdfCount: sql<number>`count(*) filter (where ${templateFills.format} = 'pdf')::int`,
        errorCount: sql<number>`count(*) filter (where ${templateFills.status} = 'error')::int`,
        partialCount: sql<number>`count(*) filter (where ${templateFills.status} = 'partial')::int`,
      })
      .from(templateFills)
      .where(and(...conditions)),
  );

  const result = rows[0];
  if (!result || result.totalFills === 0) {
    return {
      totalFills: 0,
      uniqueTemplates: 0,
      pdfRatio: 0,
      errorRate: 0,
      partialRate: 0,
      templateCount: 0,
    };
  }

  // Total stored templates for context
  const templateRows = await scopedDb((tx) =>
    tx
      .select({ count: sql<number>`count(*)::int` })
      .from(templates)
      .where(eq(templates.organizationId, organizationId)),
  );

  const templateCount = templateRows[0]?.count ?? 0;

  return {
    totalFills: result.totalFills,
    uniqueTemplates: result.uniqueTemplates,
    pdfRatio: Math.round((result.pdfCount / result.totalFills) * 100),
    errorRate: Math.round((result.errorCount / result.totalFills) * 100),
    partialRate: Math.round((result.partialCount / result.totalFills) * 100),
    templateCount,
  };
};
