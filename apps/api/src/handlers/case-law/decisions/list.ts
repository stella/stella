import { panic } from "better-result";
import { and, eq, not, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
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

import { caseLawSources, publishedCaseLawDecisions } from "@/api/db/schema";
import { status } from "@/api/http/status";
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
  type DecisionDateBand,
  decisionDateBandAfterSql,
  decisionDateBandOrderBySql,
  decisionDateBandsFrom,
  decisionDateBandSql,
  type DecisionDatePosition,
  decisionDatePositionOf,
  decisionDateSortKeySql,
  decodeDecisionDateCursor,
  encodeDecisionDateCursor,
} from "@/api/lib/case-law/decision-date-order";
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
import { createCursorPage } from "@/api/lib/pagination";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";

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
  // lower bound excludes them, an upper bound alone must exclude them itself,
  // here rather than by band, because a sibling is held to it too.
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

/**
 * Whether a request's filters admit the undated band at all. A date bound
 * excludes every undated decision, so its walk stops after the dated band
 * rather than reading an empty range.
 */
export const admitsDecisionDateBand = (
  query: ListDecisionsQuery,
  band: DecisionDateBand,
): boolean => {
  switch (band) {
    case "dated":
      return true;
    case "undated":
      return query.dateFrom === undefined && query.dateTo === undefined;
    default:
      band satisfies never;
      return panic(`Unhandled decision date band: ${String(band)}`);
  }
};

type DecisionBandWalkOptions = {
  query: ListDecisionsQuery;
  sort: DecisionListSort;
  band: DecisionDateBand;
  /** Where the previous page ended, when it ended inside this band. */
  position: DecisionDatePosition | undefined;
  tx: CaseLawPublicReadTransaction;
};

/** One band of the browse walk: the rows it lists and the order it lists them in. */
const decisionBandWalk = ({
  query,
  sort,
  band,
  position,
  tx,
}: DecisionBandWalkOptions) => {
  const columns = {
    decisionDate: publishedCaseLawDecisions.decisionDate,
    id: publishedCaseLawDecisions.id,
  };
  const conditions: SQL[] = [
    redistributableCaseLawSource,
    ...decisionFilterConditions(query, publishedCaseLawDecisions),
    decisionDateBandSql(band, columns.decisionDate),
  ];
  if (position !== undefined) {
    conditions.push(
      decisionDateBandAfterSql({ order: sort, position, columns }),
    );
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
  // A sibling in the other band is still eligible: the walk lists it there.
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

  return {
    where: and(
      ...conditions,
      // Only an older version eligible for this request hides a row.
      // A null group key matches no sibling, so ungrouped rows remain.
      not(hasEarlierSibling),
    ),
    orderBy: decisionDateBandOrderBySql(sort, columns),
  };
};

type ListDecisionsPageQueryOptions = DecisionBandWalkOptions & {
  /** Rows to read: a page plus one, which says whether another follows. */
  take: number;
  /** Rows of this band ahead of a page addressed by number. */
  offset?: number | undefined;
};

/**
 * One band's page of the browse walk, exposed so its access path can be
 * checked on the real builder.
 */
export const listDecisionsPageQuery = ({
  take,
  offset = 0,
  ...walkOptions
}: ListDecisionsPageQueryOptions) => {
  const { where, orderBy } = decisionBandWalk(walkOptions);
  return walkOptions.tx
    .select(publicDecisionRowColumns())
    .from(publishedCaseLawDecisions)
    .innerJoin(
      caseLawSources,
      eq(caseLawSources.id, publishedCaseLawDecisions.sourceId),
    )
    .where(where)
    .orderBy(...orderBy)
    .limit(take)
    .offset(offset);
};

/**
 * How many of a band's rows a page addressed by number skips, counted up to
 * the offset; the rest of the offset falls in the next band. Bounded by the
 * offset, which the result depth bounds.
 */
const countDecisionBandRowsAhead = ({
  offset,
  ...walkOptions
}: DecisionBandWalkOptions & { offset: number }) => {
  const { where, orderBy } = decisionBandWalk(walkOptions);
  const ahead = walkOptions.tx
    .select({ id: publishedCaseLawDecisions.id })
    .from(publishedCaseLawDecisions)
    .innerJoin(
      caseLawSources,
      eq(caseLawSources.id, publishedCaseLawDecisions.sourceId),
    )
    .where(where)
    .orderBy(...orderBy)
    .limit(offset)
    .as("ahead");
  return walkOptions.tx
    .select({ count: sql<number>`count(*)::int` })
    .from(ahead);
};

type ListDecisionsPageOptions = {
  query: ListDecisionsQuery;
  sort: DecisionListSort;
  limit: number;
  position: DecisionDatePosition | undefined;
  offset: number;
  tx: CaseLawPublicReadTransaction;
};

/**
 * A page of the browse walk: the dated band, then the undated band, each an
 * index range read in the order's direction. A page that reaches the end of
 * the dated band continues into the undated one, so a cursor issued in either
 * band resumes exactly where its page ended.
 */
const readListDecisionsPage = async ({
  query,
  sort,
  limit,
  position,
  offset,
  tx,
}: ListDecisionsPageOptions) => {
  const rows = [];
  let skip = offset;
  // db-await-in-loop: at most two bands, read in order; the second only when the first ends inside the page
  for (const band of decisionDateBandsFrom(position)) {
    if (rows.length > limit) {
      break;
    }
    if (!admitsDecisionDateBand(query, band)) {
      continue;
    }
    const walkOptions = {
      query,
      sort,
      band,
      position: position?.band === band ? position : undefined,
      tx,
    };
    const bandRows = await listDecisionsPageQuery({
      ...walkOptions,
      take: limit + 1 - rows.length,
      offset: skip,
    });
    rows.push(...bandRows);
    if (skip === 0) {
      continue;
    }
    // A page that listed a row of this band spent its offset inside it; one
    // that listed none skipped the whole band and carries the rest over.
    if (bandRows.length > 0) {
      skip = 0;
      continue;
    }
    const [ahead] = await countDecisionBandRowsAhead({
      ...walkOptions,
      offset: skip,
    });
    skip -= ahead?.count ?? panic("A count query returned no row");
  }
  return rows;
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
  // A cursor is bound to the order that issued it: a position in one walk is
  // not a position in the other.
  const position = query.cursor
    ? decodeDecisionDateCursor(query.cursor, sort)
    : undefined;
  if (position === null) {
    return status(400, { message: "Invalid cursor" });
  }

  // One transaction, so both bands of a page read the same snapshot.
  const decisions = await caseLawDb(
    async (tx) =>
      await readListDecisionsPage({
        query: scopedQuery,
        sort,
        limit,
        position,
        offset: query.offset ?? 0,
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
      encodeDecisionDateCursor(sort, decisionDatePositionOf(item)),
  });
};
