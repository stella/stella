import { and, desc, eq, lt, sql, type SQL } from "drizzle-orm";
import { status, t, type Static } from "elysia";

import type { ScopedDb } from "@/api/db";
import { caseLawDecisions } from "@/api/db/schema";
import { LIMITS } from "@/api/lib/limits";

export const listDecisionsQuerySchema = t.Object({
  limit: t.Optional(
    t.Number({
      minimum: 1,
      maximum: LIMITS.caseLawSearchPageSizeMax,
    }),
  ),
  cursor: t.Optional(t.String()),
  court: t.Optional(t.String({ maxLength: 512 })),
  country: t.Optional(t.String({ maxLength: 3 })),
  dateFrom: t.Optional(t.String({ format: "date" })),
  dateTo: t.Optional(t.String({ format: "date" })),
  decisionType: t.Optional(t.String({ maxLength: 128 })),
  sourceId: t.Optional(t.String({ maxLength: 21 })),
});

type ListDecisionsQuery = Static<typeof listDecisionsQuerySchema>;

export const listDecisionsHandler = async (
  query: ListDecisionsQuery,
  scopedDb: ScopedDb,
) => {
  const limit = query.limit ?? LIMITS.caseLawSearchPageSizeDefault;
  const conditions: SQL[] = [];

  if (query.cursor) {
    const separatorIdx = query.cursor.indexOf("_");
    if (separatorIdx > 0) {
      const ts = query.cursor.slice(0, separatorIdx);
      const id = query.cursor.slice(separatorIdx + 1);
      const date = new Date(ts);
      if (Number.isNaN(date.getTime())) {
        return status(400, { message: "Invalid cursor" });
      }
      conditions.push(
        sql`(${caseLawDecisions.createdAt}, ${caseLawDecisions.id}) < (${date}, ${id})`,
      );
    } else {
      const date = new Date(query.cursor);
      if (Number.isNaN(date.getTime())) {
        return status(400, { message: "Invalid cursor" });
      }
      conditions.push(lt(caseLawDecisions.createdAt, date));
    }
  }

  if (query.court) {
    conditions.push(eq(caseLawDecisions.court, query.court));
  }

  if (query.country) {
    conditions.push(eq(caseLawDecisions.country, query.country));
  }

  if (query.dateFrom) {
    conditions.push(sql`${caseLawDecisions.decisionDate} >= ${query.dateFrom}`);
  }

  if (query.dateTo) {
    conditions.push(sql`${caseLawDecisions.decisionDate} <= ${query.dateTo}`);
  }

  if (query.decisionType) {
    conditions.push(eq(caseLawDecisions.decisionType, query.decisionType));
  }

  if (query.sourceId) {
    conditions.push(eq(caseLawDecisions.sourceId, query.sourceId));
  }

  const decisions = await scopedDb((tx) =>
    tx
      .select({
        id: caseLawDecisions.id,
        caseNumber: caseLawDecisions.caseNumber,
        ecli: caseLawDecisions.ecli,
        court: caseLawDecisions.court,
        country: caseLawDecisions.country,
        language: caseLawDecisions.language,
        decisionDate: caseLawDecisions.decisionDate,
        decisionType: caseLawDecisions.decisionType,
        sourceUrl: caseLawDecisions.sourceUrl,
        createdAt: caseLawDecisions.createdAt,
      })
      .from(caseLawDecisions)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(caseLawDecisions.createdAt), desc(caseLawDecisions.id))
      .limit(limit + 1),
  );

  const hasMore = decisions.length > limit;
  const items = hasMore ? decisions.slice(0, limit) : decisions;
  const lastItem = hasMore ? items.at(-1) : null;
  const nextCursor = lastItem
    ? `${lastItem.createdAt.toISOString()}_${lastItem.id}`
    : null;

  return { decisions: items, nextCursor };
};
