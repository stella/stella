import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { validCaseLawLanguageAlternateCountSql } from "@/api/handlers/case-law/decisions/language";
import { redistributableCaseLawSource } from "@/api/handlers/case-law/redistribution";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { isUuid, tSafeId } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import { createCursorPage } from "@/api/lib/pagination";

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

export const listDecisionsHandler = async (
  query: ListDecisionsQuery,
  caseLawDb: CaseLawPublicReadDb,
) => {
  const limit = query.limit ?? LIMITS.caseLawSearchPageSizeDefault;
  const conditions: SQL[] = [redistributableCaseLawSource];

  if (query.cursor) {
    const separatorIdx = query.cursor.indexOf("_");
    if (separatorIdx > 0) {
      const ts = query.cursor.slice(0, separatorIdx);
      const id = query.cursor.slice(separatorIdx + 1);
      const date = new Date(ts);
      if (Number.isNaN(date.getTime()) || !isUuid(id)) {
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

  const decisions = await caseLawDb((tx) =>
    tx
      .select({
        id: caseLawDecisions.id,
        caseNumber: caseLawDecisions.caseNumber,
        slug: caseLawDecisions.slug,
        ecli: caseLawDecisions.ecli,
        court: caseLawDecisions.court,
        country: caseLawDecisions.country,
        language: caseLawDecisions.language,
        languageGroupKey: caseLawDecisions.languageGroupKey,
        decisionDate: caseLawDecisions.decisionDate,
        decisionType: caseLawDecisions.decisionType,
        sourceUrl: caseLawDecisions.sourceUrl,
        createdAt: caseLawDecisions.createdAt,
      })
      .from(caseLawDecisions)
      .innerJoin(
        caseLawSources,
        eq(caseLawSources.id, caseLawDecisions.sourceId),
      )
      .where(and(...conditions))
      .orderBy(desc(caseLawDecisions.createdAt), desc(caseLawDecisions.id))
      .limit(limit + 1),
  );

  const languageGroupKeys = [
    ...new Set(
      decisions
        .map((decision) => decision.languageGroupKey)
        .filter((value): value is string => value !== null),
    ),
  ];
  const languageAlternateCounts =
    languageGroupKeys.length > 0
      ? await caseLawDb((tx) =>
          tx
            .select({
              languageGroupKey: caseLawDecisions.languageGroupKey,
              count: validCaseLawLanguageAlternateCountSql,
            })
            .from(caseLawDecisions)
            .innerJoin(
              caseLawSources,
              eq(caseLawSources.id, caseLawDecisions.sourceId),
            )
            .where(
              and(
                inArray(caseLawDecisions.languageGroupKey, languageGroupKeys),
                redistributableCaseLawSource,
              ),
            )
            .groupBy(caseLawDecisions.languageGroupKey),
        )
      : [];
  const languageAlternateCountByGroupKey = new Map(
    languageAlternateCounts
      .filter(
        (
          row,
        ): row is {
          count: number;
          languageGroupKey: string;
        } => row.languageGroupKey !== null,
      )
      .map((row) => [row.languageGroupKey, row.count]),
  );

  return createCursorPage({
    rows: decisions.map((decision) => ({
      id: decision.id,
      caseNumber: decision.caseNumber,
      slug: decision.slug,
      ecli: decision.ecli,
      court: decision.court,
      country: decision.country,
      language: decision.language,
      languageAlternateCount:
        decision.languageGroupKey === null
          ? 0
          : (languageAlternateCountByGroupKey.get(decision.languageGroupKey) ??
            1),
      languageGroupKey: decision.languageGroupKey,
      decisionDate: decision.decisionDate,
      decisionType: decision.decisionType,
      sourceUrl: decision.sourceUrl,
      createdAt: decision.createdAt,
    })),
    limit,
    cursorForItem: (item) => `${item.createdAt.toISOString()}_${item.id}`,
  });
};
