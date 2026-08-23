import { and, desc, eq, lt, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { readDecisionLanguageAlternateCounts } from "@/api/lib/case-law/language-alternate-counts";
import { redistributableCaseLawSource } from "@/api/lib/case-law/redistribution";
import {
  isUuid,
  tPaginationCursor,
  tPaginationLimit,
  tSafeId,
} from "@/api/lib/custom-schema";
import {
  createTimestampIdCursorCodec,
  parsePgTimestampCursorValue,
  pgTimestampCursorBoundary,
} from "@/api/lib/db-pagination";
import { LIMITS } from "@/api/lib/limits";
import { createCursorPage } from "@/api/lib/pagination";
import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";

export const listDecisionsQuerySchema = t.Object({
  limit: t.Optional(tPaginationLimit(LIMITS.caseLawSearchPageSizeMax)),
  cursor: t.Optional(tPaginationCursor()),
  court: t.Optional(t.String({ maxLength: 512 })),
  country: t.Optional(t.String({ maxLength: 3 })),
  dateFrom: t.Optional(t.String({ format: "date" })),
  dateTo: t.Optional(t.String({ format: "date" })),
  decisionType: t.Optional(t.String({ maxLength: 128 })),
  sourceId: t.Optional(tSafeId("caseLawSource")),
  language: t.Optional(t.String({ maxLength: 8 })),
});

type ListDecisionsQuery = Static<typeof listDecisionsQuerySchema>;

const caseLawCreatedAtCursor = createTimestampIdCursorCodec({
  column: caseLawDecisions.createdAt,
  brandId: brandPersistedCaseLawDecisionId,
});

export const listDecisionsHandler = async (
  query: ListDecisionsQuery,
  caseLawDb: CaseLawPublicReadDb,
) => {
  const limit = query.limit ?? LIMITS.caseLawSearchPageSizeDefault;
  const conditions: SQL[] = [redistributableCaseLawSource];

  if (query.cursor) {
    const currentCursor = caseLawCreatedAtCursor.decode(query.cursor);
    if (currentCursor) {
      const cursorCondition = caseLawCreatedAtCursor.keysetAfter({
        cursor: currentCursor,
        direction: "descending",
        idColumn: caseLawDecisions.id,
      });
      if (cursorCondition) {
        conditions.push(cursorCondition);
      }
    } else {
      const separatorIdx = query.cursor.indexOf("_");
      if (separatorIdx > 0) {
        const ts = query.cursor.slice(0, separatorIdx);
        const id = query.cursor.slice(separatorIdx + 1);
        const timestamp = parsePgTimestampCursorValue(ts);
        if (timestamp === null || !isUuid(id)) {
          return status(400, { message: "Invalid cursor" });
        }
        const cursorCondition = caseLawCreatedAtCursor.keysetAfter({
          cursor: {
            timestamp,
            id: brandPersistedCaseLawDecisionId(id),
          },
          direction: "descending",
          idColumn: caseLawDecisions.id,
        });
        if (cursorCondition) {
          conditions.push(cursorCondition);
        }
      } else {
        const timestamp = parsePgTimestampCursorValue(query.cursor);
        if (timestamp === null) {
          return status(400, { message: "Invalid cursor" });
        }
        // Old cursors without an id cannot express a tie-break. Retain their
        // timestamp-only boundary while all newly emitted cursors use the
        // complete shared tuple codec below.
        conditions.push(
          lt(caseLawDecisions.createdAt, pgTimestampCursorBoundary(timestamp)),
        );
      }
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
        createdAtCursor:
          caseLawCreatedAtCursor.cursorValue.as("created_at_cursor"),
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
      ? await readDecisionLanguageAlternateCounts({
          caseLawDb,
          languageGroupKeys,
        })
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

  const page = createCursorPage({
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
      createdAtCursor: decision.createdAtCursor,
    })),
    limit,
    cursorForItem: (item) =>
      caseLawCreatedAtCursor.encode(item.createdAtCursor, item.id),
  });

  return {
    ...page,
    items: page.items.map(
      ({ createdAtCursor: _createdAtCursor, ...item }) => item,
    ),
  };
};
