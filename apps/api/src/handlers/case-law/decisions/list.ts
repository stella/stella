import { and, desc, eq, isNull, notExists, or, sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { status, t } from "elysia";
import type { Static } from "elysia";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { normalizeDecisionHeadnote } from "@/api/lib/case-law/decision-headnote";
import { readPublicDecisionLanguageAlternatesByGroup } from "@/api/lib/case-law/language-alternates";
import { publisherSummaryMetadataSql } from "@/api/lib/case-law/publisher-summary";
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
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isDateOnlyPaginationCursorPart,
} from "@/api/lib/pagination";
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

/**
 * The browse walk is newest decision first. Undated decisions sort last, as
 * one band, which is what the corpus-generation cursor index already stores
 * (`coalesce(decision_date, '-infinity')`, then id), so the walk is an index
 * range in either direction.
 */
export const decisionDateSortKeySql = (decisionDate: SQLWrapper): SQL<string> =>
  sql<string>`coalesce(${decisionDate}, '-infinity'::date)`;

/** Where a browse page ended: the last row's decision date (null when undated) and id. */
type DecisionDateCursor = {
  decisionDate: string | null;
  id: SafeId<"caseLawDecision">;
};

const encodeDecisionDateCursor = ({
  decisionDate,
  id,
}: DecisionDateCursor): string => encodePaginationCursor([decisionDate, id]);

const decodeDecisionDateCursor = (
  cursor: string,
): DecisionDateCursor | null => {
  const parts = decodePaginationCursor(cursor);
  if (parts?.length !== 2) {
    return null;
  }
  const [decisionDate, id] = parts;
  if (
    typeof id !== "string" ||
    !isUuid(id) ||
    (decisionDate !== null && !isDateOnlyPaginationCursorPart(decisionDate))
  ) {
    return null;
  }
  return { decisionDate, id: brandPersistedCaseLawDecisionId(id) };
};

/**
 * Rows strictly after the cursor in walk order. One row comparison on the same
 * expressions the ORDER BY uses, so the predicate and the sort cannot drift.
 */
const decisionDateKeysetAfter = ({
  decisionDate,
  id,
}: DecisionDateCursor): SQL =>
  sql`(${decisionDateSortKeySql(caseLawDecisions.decisionDate)}, ${caseLawDecisions.id})
    < (coalesce(${decisionDate}::date, '-infinity'::date), ${id}::uuid)`;

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
    const cursor = decodeDecisionDateCursor(query.cursor);
    if (cursor === null) {
      return status(400, { message: "Invalid cursor" });
    }
    conditions.push(decisionDateKeysetAfter(cursor));
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
        headnote: publisherSummaryMetadataSql(caseLawDecisions.metadata),
        citationCount: caseLawDecisions.citationCount,
        createdAt: caseLawDecisions.createdAt,
      })
      .from(caseLawDecisions)
      .innerJoin(
        caseLawSources,
        eq(caseLawSources.id, caseLawDecisions.sourceId),
      )
      .where(
        and(
          ...conditions,
          // A multilingual decision is listed once, by its oldest listable
          // version. Rows only ever arrive with newer timestamps, so no later
          // ingested translation can displace the representative between two
          // pages of one walk, and the keyset cursor stays valid. Siblings are
          // held to the same filters and the same redistribution gate as the
          // row itself.
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
                    sql`(${sibling.createdAt}, ${sibling.id}) < (${caseLawDecisions.createdAt}, ${caseLawDecisions.id})`,
                    redistributableCaseLawSourceFor(siblingSource.descriptor),
                    ...decisionFilterConditions(query, sibling),
                  ),
                ),
            ),
          ),
        ),
      )
      .orderBy(
        desc(decisionDateSortKeySql(caseLawDecisions.decisionDate)),
        desc(caseLawDecisions.id),
      )
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

  return createCursorPage({
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
      headnote: normalizeDecisionHeadnote(decision.headnote),
      citationCount: decision.citationCount,
      createdAt: decision.createdAt,
    })),
    limit,
    cursorForItem: (item) =>
      encodeDecisionDateCursor({
        decisionDate: item.decisionDate,
        id: item.id,
      }),
  });
};
