import { and, count, desc, eq, isNotNull, lt, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { status, t } from "elysia";
import type { Static } from "elysia";

import type { ScopedDb } from "@/api/db";
import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { courtWeightSql } from "@/api/handlers/case-law/citation-score";
import { tSafeId } from "@/api/lib/custom-schema";
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
  sourceId: t.Optional(tSafeId("caseLawSource")),
  language: t.Optional(t.String({ maxLength: 8 })),
});

type ListDecisionsQuery = Static<typeof listDecisionsQuerySchema>;

const facetRows = async (
  scopedDb: ScopedDb,
  column: AnyPgColumn,
  conditions: SQL[],
) =>
  await scopedDb((tx) =>
    tx
      .select({
        value: column,
        count: count(),
      })
      .from(caseLawDecisions)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .groupBy(column)
      .orderBy(desc(count()))
      .limit(LIMITS.caseLawFacetLimit),
  );

export const listDecisionsHandler = async (
  query: ListDecisionsQuery,
  scopedDb: ScopedDb,
) => {
  const limit = query.limit ?? LIMITS.caseLawSearchPageSizeDefault;
  const conditions: SQL[] = [];
  const courtWeightExpr = courtWeightSql("citing_d.court");

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

  if (query.language) {
    conditions.push(eq(caseLawDecisions.language, query.language));
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
        languageGroupKey: caseLawDecisions.languageGroupKey,
        decisionDate: caseLawDecisions.decisionDate,
        decisionType: caseLawDecisions.decisionType,
        sourceUrl: caseLawDecisions.sourceUrl,
        sourceName: caseLawSources.name,
        citationCount: sql<number>`(
          SELECT count(*)::int
          FROM case_law_citations c
          WHERE c.cited_decision_id = ${caseLawDecisions.id}
        )`,
        positiveCitationCount: sql<number>`(
          SELECT count(*)::int
          FROM case_law_citations c
          WHERE c.cited_decision_id = ${caseLawDecisions.id}
            AND c.polarity = 'positive'
        )`,
        supportiveCitationCount: sql<number>`(
          SELECT count(*)::int
          FROM case_law_citations c
          WHERE c.cited_decision_id = ${caseLawDecisions.id}
            AND c.polarity = 'supportive'
        )`,
        negativeCitationCount: sql<number>`(
          SELECT count(*)::int
          FROM case_law_citations c
          WHERE c.cited_decision_id = ${caseLawDecisions.id}
            AND c.polarity = 'negative'
        )`,
        authorityScore: sql<number>`(
          SELECT ln(
            1 + coalesce(
              sum(
                (${sql.raw(courtWeightExpr)})
                * (1.0 / (1 + COALESCE(extract(epoch FROM (now() - citing_d.decision_date)) / (365.25 * 86400), 1.0)))
              ),
              0
            ) / GREATEST(
              extract(epoch FROM (now() - ${caseLawDecisions.decisionDate})) / (365.25 * 86400),
              1.0
            )
          )
          FROM case_law_citations c
          JOIN case_law_decisions citing_d
            ON citing_d.id = c.citing_decision_id
          WHERE c.cited_decision_id = ${caseLawDecisions.id}
        )`,
        createdAt: caseLawDecisions.createdAt,
      })
      .from(caseLawDecisions)
      .innerJoin(
        caseLawSources,
        eq(caseLawSources.id, caseLawDecisions.sourceId),
      )
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

  if (query.cursor) {
    return { decisions: items, facets: null, nextCursor };
  }

  const courtConditions = [
    ...(query.country ? [eq(caseLawDecisions.country, query.country)] : []),
    ...(query.dateFrom
      ? [sql`${caseLawDecisions.decisionDate} >= ${query.dateFrom}`]
      : []),
    ...(query.dateTo
      ? [sql`${caseLawDecisions.decisionDate} <= ${query.dateTo}`]
      : []),
    ...(query.decisionType
      ? [eq(caseLawDecisions.decisionType, query.decisionType)]
      : []),
    ...(query.sourceId ? [eq(caseLawDecisions.sourceId, query.sourceId)] : []),
    ...(query.language ? [eq(caseLawDecisions.language, query.language)] : []),
  ];
  const countryConditions = [
    ...(query.court ? [eq(caseLawDecisions.court, query.court)] : []),
    ...(query.dateFrom
      ? [sql`${caseLawDecisions.decisionDate} >= ${query.dateFrom}`]
      : []),
    ...(query.dateTo
      ? [sql`${caseLawDecisions.decisionDate} <= ${query.dateTo}`]
      : []),
    ...(query.decisionType
      ? [eq(caseLawDecisions.decisionType, query.decisionType)]
      : []),
    ...(query.sourceId ? [eq(caseLawDecisions.sourceId, query.sourceId)] : []),
    ...(query.language ? [eq(caseLawDecisions.language, query.language)] : []),
  ];
  const languageConditions = [
    ...(query.court ? [eq(caseLawDecisions.court, query.court)] : []),
    ...(query.country ? [eq(caseLawDecisions.country, query.country)] : []),
    ...(query.dateFrom
      ? [sql`${caseLawDecisions.decisionDate} >= ${query.dateFrom}`]
      : []),
    ...(query.dateTo
      ? [sql`${caseLawDecisions.decisionDate} <= ${query.dateTo}`]
      : []),
    ...(query.decisionType
      ? [eq(caseLawDecisions.decisionType, query.decisionType)]
      : []),
    ...(query.sourceId ? [eq(caseLawDecisions.sourceId, query.sourceId)] : []),
  ];
  const decisionTypeConditions = [
    isNotNull(caseLawDecisions.decisionType),
    ...(query.court ? [eq(caseLawDecisions.court, query.court)] : []),
    ...(query.country ? [eq(caseLawDecisions.country, query.country)] : []),
    ...(query.dateFrom
      ? [sql`${caseLawDecisions.decisionDate} >= ${query.dateFrom}`]
      : []),
    ...(query.dateTo
      ? [sql`${caseLawDecisions.decisionDate} <= ${query.dateTo}`]
      : []),
    ...(query.sourceId ? [eq(caseLawDecisions.sourceId, query.sourceId)] : []),
    ...(query.language ? [eq(caseLawDecisions.language, query.language)] : []),
  ];

  const [court, country, language, decisionType] = await Promise.all([
    facetRows(scopedDb, caseLawDecisions.court, courtConditions),
    facetRows(scopedDb, caseLawDecisions.country, countryConditions),
    facetRows(scopedDb, caseLawDecisions.language, languageConditions),
    facetRows(scopedDb, caseLawDecisions.decisionType, decisionTypeConditions),
  ]);

  return {
    decisions: items,
    facets: {
      court,
      country,
      language,
      decisionType: decisionType.flatMap((row) =>
        row.value === null ? [] : [row],
      ),
    },
    nextCursor,
  };
};
