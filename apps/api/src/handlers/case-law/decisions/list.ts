import { and, desc, eq, isNull, lt, notExists, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { status, t } from "elysia";
import type { Static } from "elysia";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { readPublicDecisionLanguageAlternatesByGroup } from "@/api/lib/case-law/language-alternates";
import {
  redistributableCaseLawSource,
  redistributableCaseLawSourceFor,
} from "@/api/lib/case-law/redistribution";
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

/** The language versions of a decision, so the sibling rule can be applied to them. */
const sibling = alias(caseLawDecisions, "sibling");
const siblingSource = alias(caseLawSources, "sibling_source");

/** The table or its alias: the alias carries its own table name in the types. */
type DecisionFilterColumns = Record<
  | "country"
  | "court"
  | "decisionDate"
  | "decisionType"
  | "language"
  | "sourceId",
  AnyPgColumn
>;

/**
 * The request filters against one decision row. Applied to the listed row and
 * to its language siblings alike: a sibling the request would not list must
 * not hide the version it would.
 */
const decisionFilterConditions = (
  query: ListDecisionsQuery,
  decision: DecisionFilterColumns,
): SQL[] => {
  const conditions: SQL[] = [];
  if (query.court) {
    conditions.push(eq(decision.court, query.court));
  }
  if (query.country) {
    conditions.push(eq(decision.country, query.country));
  }
  if (query.dateFrom) {
    conditions.push(sql`${decision.decisionDate} >= ${query.dateFrom}`);
  }
  if (query.dateTo) {
    conditions.push(sql`${decision.decisionDate} <= ${query.dateTo}`);
  }
  if (query.decisionType) {
    conditions.push(eq(decision.decisionType, query.decisionType));
  }
  if (query.sourceId) {
    conditions.push(eq(decision.sourceId, query.sourceId));
  }
  if (query.language) {
    conditions.push(eq(decision.language, query.language));
  }
  return conditions;
};

export const listDecisionsHandler = async (
  query: ListDecisionsQuery,
  caseLawDb: CaseLawPublicReadDb,
) => {
  const limit = query.limit ?? LIMITS.caseLawSearchPageSizeDefault;
  const conditions: SQL[] = [
    redistributableCaseLawSource,
    ...decisionFilterConditions(query, caseLawDecisions),
  ];

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
      .where(
        and(
          ...conditions,
          // A multilingual decision is listed once, by the version this walk
          // reaches first: the one no listable sibling sorts ahead of. That is
          // a property of the row, not of the page, so the keyset cursor stays
          // valid across pages. Siblings are held to the same filters and the
          // same redistribution gate as the row itself.
          or(
            isNull(caseLawDecisions.languageGroupKey),
            notExists(
              tx
                .select({ one: sql`1` })
                .from(sibling)
                .innerJoin(
                  siblingSource,
                  eq(siblingSource.id, sibling.sourceId),
                )
                .where(
                  and(
                    eq(
                      sibling.languageGroupKey,
                      caseLawDecisions.languageGroupKey,
                    ),
                    // oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison -- column against column inside one statement, nothing round-trips through a JS Date
                    sql`(${sibling.createdAt}, ${sibling.id}) > (${caseLawDecisions.createdAt}, ${caseLawDecisions.id})`,
                    redistributableCaseLawSourceFor(siblingSource.descriptor),
                    ...decisionFilterConditions(query, sibling),
                  ),
                ),
            ),
          ),
        ),
      )
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
  const alternatesByGroupKey =
    await readPublicDecisionLanguageAlternatesByGroup({
      caseLawDb,
      languageGroupKeys,
    });

  const page = createCursorPage({
    rows: decisions.map((decision) => ({
      id: decision.id,
      caseNumber: decision.caseNumber,
      slug: decision.slug,
      ecli: decision.ecli,
      court: decision.court,
      country: decision.country,
      language: decision.language,
      languageAlternates: alternatesByGroupKey.alternatesFor(
        decision.languageGroupKey,
      ),
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
