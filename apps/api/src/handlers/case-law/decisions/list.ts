import { panic } from "better-result";
import { and, asc, desc, eq, not, sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import * as v from "valibot";

import { apiDateSchema } from "@stll/api-contract/api-date";
import {
  PUBLIC_CASE_LAW_COUNTRIES,
  publicCaseLawCountry,
} from "@stll/api-contract/case-law-launch-readiness";
import { numberFromString } from "@stll/api-contract/http-input";
import {
  DECISION_LIST_SORTS,
  type DecisionListSort,
  DEFAULT_DECISION_LIST_SORT,
} from "@stll/api-contract/search";
import { isUuid } from "@stll/uuid-codec";

import { caseLawSources, publishedCaseLawDecisions } from "@/api/db/schema";
import { status } from "@/api/http/status";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import {
  courtPresentation,
  readCourtRegistry,
} from "@/api/lib/case-law/court-presentation";
import type { CourtWeightMap } from "@/api/lib/case-law/court-weights";
import {
  decisionPageOffsetSchema,
  decisionPageRequestRefusal,
} from "@/api/lib/case-law/decision-page-offset";
import { publicDecisionRowColumns } from "@/api/lib/case-law/decision-row-columns";
import { readDecisionHeadnote } from "@/api/lib/case-law/decision-text";
import { decisionTypeFilterSql } from "@/api/lib/case-law/decision-type-filter-sql";
import { readPublicDecisionLanguageAlternatesByGroup } from "@/api/lib/case-law/language-alternates";
import { loadPublicCourtWeights } from "@/api/lib/case-law/public-case-law-config";
import {
  redistributableCaseLawSource,
  redistributableCaseLawSourceFor,
} from "@/api/lib/case-law/redistribution";
import {
  paginationCursorSchema,
  paginationLimitSchema,
  resourceIdSchema,
} from "@/api/lib/custom-schema";
import {
  readPublicLawCountry,
  tPublicLawCountry,
} from "@/api/lib/legal-search/public-law-country";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isDateOnlyPaginationCursorPart,
} from "@/api/lib/pagination";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";
import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";

export const listDecisionsQuerySchema = v.object({
  limit: v.optional(
    numberFromString(paginationLimitSchema(LIMITS.caseLawSearchPageSizeMax)),
  ),
  cursor: v.optional(paginationCursorSchema()),
  offset: v.exactOptional(numberFromString(decisionPageOffsetSchema())),
  court: v.optional(v.pipe(v.string(), v.maxLength(512))),
  country: tPublicLawCountry,
  dateFrom: v.optional(apiDateSchema),
  dateTo: v.optional(apiDateSchema),
  decisionType: v.optional(v.pipe(v.string(), v.maxLength(128))),
  sourceId: v.optional(resourceIdSchema("caseLawSource")),
  language: v.optional(v.pipe(v.string(), v.maxLength(8))),
  sort: v.optional(v.picklist(DECISION_LIST_SORTS)),
});

type ListDecisionsQuery = v.InferOutput<typeof listDecisionsQuerySchema>;

/**
 * The browse walk's sort key. Undated decisions coalesce to `-infinity`, one
 * band, which is what the browse indexes store (`coalesce(decision_date,
 * '-infinity')`, then id), so a walk in either direction is an index range:
 * newest first reads it backward, oldest first forward.
 */
export const decisionDateSortKeySql = (decisionDate: SQLWrapper): SQL<string> =>
  sql<string>`coalesce(${decisionDate}, '-infinity'::date)`;

/**
 * Where a browse page ended, in the order it was read: the last row's
 * decision date and id. Bound to the order, because a position in one walk is
 * not a position in the other. An oldest-first walk lists dated decisions
 * only (`decisionListDatedConditions`), so its cursor always has a date.
 */
type DecisionDateCursor =
  | {
      sort: "newest";
      /** Null in the undated band, which a newest-first walk ends with. */
      decisionDate: string | null;
      id: SafeId<"caseLawDecision">;
    }
  | {
      sort: "oldest";
      decisionDate: string;
      id: SafeId<"caseLawDecision">;
    };

export const encodeDecisionDateCursor = ({
  sort,
  decisionDate,
  id,
}: DecisionDateCursor): string =>
  encodePaginationCursor([sort, decisionDate, id]);

/** The cursor a listed row ends its page with, in the order it was read. */
const decisionDateCursorFor = (
  sort: DecisionListSort,
  { decisionDate, id }: { decisionDate: string | null; id: string },
): DecisionDateCursor => {
  const decisionId = brandPersistedCaseLawDecisionId(id);
  switch (sort) {
    case "newest":
      return { sort, decisionDate, id: decisionId };
    case "oldest":
      return {
        sort,
        decisionDate:
          decisionDate ??
          panic("An oldest-first page listed a decision with no date"),
        id: decisionId,
      };
    default:
      sort satisfies never;
      return panic(`Unhandled decision list sort: ${String(sort)}`);
  }
};

/**
 * The position a request resumes from, or null for a cursor this order did
 * not issue: one of the other order, or an undated position, which no
 * oldest-first page ends on.
 */
export const decodeDecisionDateCursor = (
  cursor: string,
  sort: DecisionListSort,
): DecisionDateCursor | null => {
  const parts = decodePaginationCursor(cursor);
  if (parts?.length !== 3) {
    return null;
  }
  const [cursorSort, decisionDate, id] = parts;
  if (
    cursorSort !== sort ||
    typeof id !== "string" ||
    !isUuid(id) ||
    (decisionDate !== null && !isDateOnlyPaginationCursorPart(decisionDate)) ||
    (sort === "oldest" && decisionDate === null)
  ) {
    return null;
  }
  return decisionDateCursorFor(sort, { decisionDate, id });
};

/**
 * Rows strictly after the cursor in walk order. One row comparison on the same
 * expressions the ORDER BY uses, so the predicate and the sort cannot drift.
 */
const decisionDateKeysetAfter = (cursor: DecisionDateCursor): SQL => {
  const key = sql`(${decisionDateSortKeySql(publishedCaseLawDecisions.decisionDate)}, ${publishedCaseLawDecisions.id})`;
  const position = sql`(coalesce(${cursor.decisionDate}::date, '-infinity'::date), ${cursor.id}::uuid)`;
  switch (cursor.sort) {
    case "newest":
      return sql`${key} < ${position}`;
    case "oldest":
      return sql`${key} > ${position}`;
    default:
      cursor satisfies never;
      return panic(`Unhandled decision list cursor: ${String(cursor)}`);
  }
};

/**
 * The walk's ORDER BY: the sort key, then id, both in the order's direction,
 * so each browse index serves either order as one range read one way.
 */
const decisionListOrderBy = (sort: DecisionListSort): SQL[] => {
  const key = decisionDateSortKeySql(publishedCaseLawDecisions.decisionDate);
  switch (sort) {
    case "newest":
      return [desc(key), desc(publishedCaseLawDecisions.id)];
    case "oldest":
      return [asc(key), asc(publishedCaseLawDecisions.id)];
    default:
      sort satisfies never;
      return panic(`Unhandled decision list sort: ${String(sort)}`);
  }
};

/**
 * The decisions an order has a place for. Newest first keeps the undated band
 * at its end, where the backward walk reaches it last. Oldest first lists
 * dated decisions only, as the search's date order does
 * (`decisionDatedFilterSql`): read forward, the `-infinity` band would lead
 * every first page, and a decision the source never dated is not the oldest.
 * Stated on the sort key, so the exclusion is where the index range starts
 * rather than a filter over it.
 */
const decisionListDatedConditions = (sort: DecisionListSort): SQL[] => {
  switch (sort) {
    case "newest":
      return [];
    case "oldest":
      return [
        sql`${decisionDateSortKeySql(publishedCaseLawDecisions.decisionDate)} > '-infinity'::date`,
      ];
    default:
      sort satisfies never;
      return panic(`Unhandled decision list sort: ${String(sort)}`);
  }
};

/** The language versions of a decision, so the sibling rule can be applied to them. */
const sibling = alias(publishedCaseLawDecisions, "sibling");
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
  conditions.push(eq(decision.country, query.country));
  // Date bounds compare the walk's own sort key, so both browse indexes take
  // them as a range of the walk; on the bare column they filter a walk that
  // starts at the newest decision. The key gives undated rows `-infinity`: a
  // lower bound excludes them, an upper bound alone must exclude them itself.
  const sortKey = decisionDateSortKeySql(decision.decisionDate);
  if (query.dateFrom) {
    conditions.push(sql`${sortKey} >= ${query.dateFrom}::date`);
  }
  if (query.dateTo) {
    conditions.push(sql`${sortKey} <= ${query.dateTo}::date`);
    if (!query.dateFrom) {
      conditions.push(sql`${sortKey} > '-infinity'::date`);
    }
  }
  if (query.decisionType) {
    conditions.push(
      decisionTypeFilterSql(decision.decisionType, query.decisionType),
    );
  }
  if (query.sourceId) {
    conditions.push(eq(decision.sourceId, query.sourceId));
  }
  if (query.language) {
    conditions.push(eq(decision.language, query.language));
  }
  return conditions;
};

type ListDecisionsPageQueryOptions = {
  query: ListDecisionsQuery;
  sort: DecisionListSort;
  limit: number;
  cursor: DecisionDateCursor | undefined;
  /**
   * Rows ahead of a page addressed by number. Absent for a first page and for
   * a cursor page, whose keyset predicate already places it.
   */
  offset?: number | undefined;
  tx: CaseLawPublicReadTransaction;
};

/** The browse read, exposed so its access path can be checked on the real builder. */
export const listDecisionsPageQuery = ({
  query,
  sort,
  limit,
  cursor,
  offset = 0,
  tx,
}: ListDecisionsPageQueryOptions) => {
  const conditions: SQL[] = [
    redistributableCaseLawSource,
    ...decisionFilterConditions(query, publishedCaseLawDecisions),
    ...decisionListDatedConditions(sort),
  ];
  if (cursor !== undefined) {
    conditions.push(decisionDateKeysetAfter(cursor));
  }

  // The representative check stays a correlated, per-row test on the index
  // walk. Flattened into an anti-join, or kept as a lateral join filtered on
  // null, the planner estimates that almost no row survives it, expects to
  // read the whole country to fill a page, and sorts the corpus instead of
  // walking the date index. As a subplan it is estimated as half the rows,
  // which is the walk's real shape: most decisions have no earlier version.
  // `OFFSET 0` is a deliberate optimization fence, not a no-op to clean up:
  // PostgreSQL never pulls an EXISTS with an offset up into a join, so it is
  // what keeps the check a subplan. `list-plan.db.test.ts` fails without it.
  const earlierSibling = tx
    .select({ id: sibling.id })
    .from(sibling)
    .innerJoin(siblingSource, eq(siblingSource.id, sibling.sourceId))
    .where(
      and(
        eq(
          sibling.languageGroupKey,
          publishedCaseLawDecisions.languageGroupKey,
        ),
        // oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison -- column against column inside one statement, nothing round-trips through a JS Date
        sql`(${sibling.createdAt}, ${sibling.id}) < (${publishedCaseLawDecisions.createdAt}, ${publishedCaseLawDecisions.id})`,
        redistributableCaseLawSourceFor(siblingSource.descriptor),
        ...decisionFilterConditions(query, sibling),
      ),
    )
    .limit(1);
  const hasEarlierSibling = sql`exists (${earlierSibling} offset 0)`;

  return tx
    .select(publicDecisionRowColumns())
    .from(publishedCaseLawDecisions)
    .innerJoin(
      caseLawSources,
      eq(caseLawSources.id, publishedCaseLawDecisions.sourceId),
    )
    .where(
      and(
        ...conditions,
        // Only an older version eligible for this request hides a row.
        // A null group key matches no sibling, so ungrouped rows remain.
        not(hasEarlierSibling),
      ),
    )
    .orderBy(...decisionListOrderBy(sort))
    .limit(limit + 1)
    .offset(offset);
};

export const listDecisionsHandler = async (
  query: ListDecisionsQuery,
  caseLawDb: CaseLawPublicReadDb,
  /**
   * The court registry the chip beside each court name is drawn from. The
   * default is the public corpus's cached registry, read beside the page's
   * transaction rather than inside it; a harness supplies its own.
   */
  readCourtWeights: () => Promise<CourtWeightMap> = loadPublicCourtWeights,
) => {
  const countryRead = readPublicLawCountry(query.country, {
    domain: "caseLaw",
    admitted: PUBLIC_CASE_LAW_COUNTRIES,
    surface: "search",
  });
  if (countryRead.kind === "unavailable") {
    return countryRead.answer;
  }
  if (countryRead.kind === "unreadable") {
    return status(400, { message: countryRead.message });
  }
  const country = publicCaseLawCountry(countryRead.country);
  if (country === null) {
    return status(404, { message: "Not Found" });
  }
  const scopedQuery = { ...query, country };
  const limit = normalizeTenantPageLimit(
    query.limit ?? LIMITS.caseLawSearchPageSizeDefault,
  );
  const pageRefusal = decisionPageRequestRefusal({
    cursor: query.cursor,
    limit,
    offset: query.offset,
  });
  if (pageRefusal !== null) {
    return status(400, { message: pageRefusal });
  }
  const sort = query.sort ?? DEFAULT_DECISION_LIST_SORT;
  const cursor = query.cursor
    ? decodeDecisionDateCursor(query.cursor, sort)
    : undefined;
  if (cursor === null) {
    return status(400, { message: "Invalid cursor" });
  }

  const decisions = await caseLawDb((tx) =>
    listDecisionsPageQuery({
      query: scopedQuery,
      sort,
      limit,
      cursor,
      offset: query.offset,
      tx,
    }),
  );

  const languageGroupKeys = [
    ...new Set(
      decisions
        .map((decision) => decision.languageGroupKey)
        .filter((value): value is string => value !== null),
    ),
  ];
  // Two independent reads of the page's context: the alternates come from
  // Postgres, the court registry from a loader that caches for a minute.
  const [alternatesByGroupKey, courtWeights] = await Promise.all([
    readPublicDecisionLanguageAlternatesByGroup({
      caseLawDb,
      languageGroupKeys,
    }),
    // Bounded and degraded to no badge: a court chip is not worth failing a
    // page of decisions over.
    readCourtRegistry(readCourtWeights),
  ]);

  return createCursorPage({
    rows: decisions.map((decision) => {
      const presentation = courtPresentation(courtWeights, {
        country: decision.country,
        court: decision.court,
        courtId: decision.courtId,
        ecli: decision.ecli,
      });
      return {
        id: decision.id,
        caseNumber: decision.caseNumber,
        caseNumberType: decision.caseNumberType,
        slug: decision.slug,
        ecli: decision.ecli,
        court: decision.court,
        courtAbbreviation: presentation.courtAbbreviation,
        courtTier: presentation.courtTier,
        country: decision.country,
        language: decision.language,
        languageAlternates: alternatesByGroupKey.alternatesFor(
          decision.languageGroupKey,
        ),
        decisionDate: decision.decisionDate,
        decisionType: decision.decisionType,
        sourceUrl: decision.sourceUrl,
        headnote: readDecisionHeadnote({
          headnote: decision.headnote,
          keywords: decision.keywords,
        }),
        citationCount: decision.citationCount,
        createdAt: decision.createdAt,
      };
    }),
    limit,
    cursorForItem: (item) =>
      encodeDecisionDateCursor(
        decisionDateCursorFor(sort, {
          decisionDate: item.decisionDate,
          id: item.id,
        }),
      ),
  });
};
