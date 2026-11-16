import { panic } from "better-result";
import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";
import * as v from "valibot";

import { apiDateSchema } from "@stll/api-contract/api-date";
import { numberFromString } from "@stll/api-contract/http-input";
import { LAW_YEAR_BOUNDS } from "@stll/api-contract/law-year";
import { PUBLIC_LEGISLATION_COUNTRIES } from "@stll/api-contract/legislation-publication";
import { LEGISLATION_LIST_VALIDITIES } from "@stll/api-contract/legislation-status";
import type { LegislationListValidity } from "@stll/api-contract/legislation-status";
import { STATUTE_ELI_IDENTITY_PATTERN } from "@stll/api-contract/statute-identity";
import {
  STATUTE_LIST_SORT_KEY_KINDS,
  STATUTE_LIST_SORT_NEEDS_YEAR_CODE,
  STATUTE_LIST_SORT_NEEDS_YEAR_MESSAGE,
  STATUTE_LIST_SORT_ORDERS,
  STATUTE_LIST_SORTS,
  statuteListSortIsBounded,
} from "@stll/api-contract/statute-list-sort";
import type {
  StatuteListSort,
  StatuteListSortKey,
} from "@stll/api-contract/statute-list-sort";

import {
  caseLawStatuteCitationCountState,
  LEGISLATION_TITLE_SORT_KEY_CHARS,
  legislationDocuments,
  legislationSources,
  legislationTitleFold,
  legislationTitleName,
  legislationTitleSortKey,
} from "@/api/db/schema";
import { projectStatuteListItem } from "@/api/handlers/legislation/catalog-response";
import {
  statuteCitationCaseCount,
  statuteCitationCountStateJoin,
} from "@/api/handlers/legislation/citation-count";
import { status } from "@/api/http/status";
import type { SafeId } from "@/api/lib/branded-types";
import {
  paginationCursorSchema,
  paginationLimitSchema,
} from "@/api/lib/custom-schema";
import { escapeLike, escapeLikeSql } from "@/api/lib/escape-like";
import {
  ACT_NUMBER_PATTERN,
  actNumberCondition,
  actYearCondition,
} from "@/api/lib/legal-search/legislation-act-number";
import { legislationDocumentStatusToday } from "@/api/lib/legal-search/legislation-current-version";
import {
  isLatestOpenedVersionOfWorkAt,
  listedLegislationRef,
} from "@/api/lib/legal-search/legislation-listed-version";
import { publishedLegislationDocumentFor } from "@/api/lib/legal-search/legislation-redistribution";
import {
  applicableKind,
  eligibleExpression,
  inForceOn,
  legislationVersionRefAt,
  notWithdrawn,
  opensBefore,
  opensOnOrBefore,
  versionSortKey,
} from "@/api/lib/legal-search/legislation-validity-window";
import {
  readPublicLawCountry,
  tPublicLawCountry,
} from "@/api/lib/legal-search/public-law-country";
import type {
  LegislationReadDb,
  LegislationReadTransaction,
} from "@/api/lib/legislation-public-read-db";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isDateOnlyPaginationCursorPart,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";
import { brandPersistedLegislationDocumentId } from "@/api/lib/safe-id-boundaries";

/** A publisher collection segment of an ELI: `sb`, `ul1`, `zz`. */
const COLLECTION_PATTERN = /^[a-z0-9]{1,8}$/u;

export const listStatutesQuerySchema = v.object({
  country: tPublicLawCountry,
  query: v.optional(v.pipe(v.string(), v.maxLength(256))),
  /** Year in the act number, not the consolidation date. */
  year: v.optional(
    numberFromString(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(LAW_YEAR_BOUNDS.minimum),
        v.maxValue(LAW_YEAR_BOUNDS.maximum),
      ),
    ),
  ),
  /** An act's own number, `<number>/<year>`; the request asks for that work. */
  number: v.optional(
    v.pipe(v.string(), v.regex(new RegExp(ACT_NUMBER_PATTERN.source, "u"))),
  ),
  /** The collection the number was published in, when the caller knows it. */
  collection: v.optional(
    v.pipe(v.string(), v.regex(new RegExp(COLLECTION_PATTERN.source, "u"))),
  ),
  /** Calendar date whose applicable consolidation each work should return. */
  asOf: v.optional(apiDateSchema),
  language: v.optional(v.pipe(v.string(), v.maxLength(8))),
  /** The kind of act, exactly as the publisher names it (`zákon`, `vyhláška`). */
  documentType: v.optional(
    v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
  ),
  /** Works still in force on `asOf`, or works that no longer are; both when absent. */
  validity: v.optional(v.picklist(LEGISLATION_LIST_VALIDITIES)),
  /**
   * A column to order by instead of the default order; only with `year`,
   * which bounds the set every Work's value is computed for.
   */
  sort: v.optional(v.picklist(STATUTE_LIST_SORTS)),
  limit: v.optional(
    numberFromString(paginationLimitSchema(LIMITS.legislationListPageSizeMax)),
  ),
  cursor: v.optional(paginationCursorSchema()),
});

type ListStatutesQuery = v.InferOutput<typeof listStatutesQuerySchema>;

/**
 * The orderings the list serves, each with its own cursor protocol. A cursor
 * from one cannot continue another: the sort keys differ.
 */
export const LEGISLATION_LIST_CURSOR_KIND = {
  /** No text: newest consolidation first. */
  recent: "recent-v1",
  /** A typed name: works named by it first, then works mentioning it. */
  search: "search-v1",
  /** One column's value, either way, Works without one last. */
  column: "column-v1",
} as const;

/** A column order's key at the cursor: a count, an ISO date, or none. */
type ColumnSortKeyValue = number | string | null;

type ListCursor =
  | {
      type: typeof LEGISLATION_LIST_CURSOR_KIND.recent;
      validFrom: string;
      id: SafeId<"legislationDocument">;
    }
  | {
      type: typeof LEGISLATION_LIST_CURSOR_KIND.search;
      rank: "0" | "1";
      titleSortKey: string;
      id: SafeId<"legislationDocument">;
    }
  | {
      type: typeof LEGISLATION_LIST_CURSOR_KIND.column;
      sort: StatuteListSort;
      key: ColumnSortKeyValue;
      id: SafeId<"legislationDocument">;
    };

const isStatuteListSort = (value: unknown): value is StatuteListSort =>
  STATUTE_LIST_SORTS.some((sort) => sort === value);

/** Whether a cursor's key is one the order's column can hold. */
const isColumnSortKeyValue = (
  sort: StatuteListSort,
  value: unknown,
): value is ColumnSortKeyValue => {
  if (value === null) {
    return true;
  }
  switch (STATUTE_LIST_SORT_KEY_KINDS[STATUTE_LIST_SORT_ORDERS[sort].key]) {
    case "number":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "date":
      return isDateOnlyPaginationCursorPart(value);
    default:
      return panic("Unhandled statute list sort key kind");
  }
};

const titleSortKey = legislationTitleSortKey(legislationDocuments.title);
const validFromKey = versionSortKey(legislationDocuments.versionValidFrom);

export const decodeListCursor = (cursor: string): ListCursor | null => {
  const parts = decodePaginationCursor(cursor);
  if (parts === null) {
    return null;
  }
  const [kind, ...rest] = parts;

  if (kind === LEGISLATION_LIST_CURSOR_KIND.recent && rest.length === 2) {
    const [validFrom, id] = rest;
    if (
      !isDateOnlyPaginationCursorPart(validFrom) ||
      !isUuidPaginationCursorPart(id)
    ) {
      return null;
    }
    return {
      type: LEGISLATION_LIST_CURSOR_KIND.recent,
      validFrom,
      id: brandPersistedLegislationDocumentId(id),
    };
  }

  if (kind === LEGISLATION_LIST_CURSOR_KIND.search && rest.length === 3) {
    const [rank, key, id] = rest;
    if (
      (rank !== "0" && rank !== "1") ||
      typeof key !== "string" ||
      Array.from(key).length > LEGISLATION_TITLE_SORT_KEY_CHARS ||
      !isUuidPaginationCursorPart(id)
    ) {
      return null;
    }
    return {
      type: LEGISLATION_LIST_CURSOR_KIND.search,
      rank,
      titleSortKey: key,
      id: brandPersistedLegislationDocumentId(id),
    };
  }

  if (kind === LEGISLATION_LIST_CURSOR_KIND.column && rest.length === 3) {
    const [sort, key, id] = rest;
    if (
      !isStatuteListSort(sort) ||
      !isColumnSortKeyValue(sort, key) ||
      !isUuidPaginationCursorPart(id)
    ) {
      return null;
    }
    return {
      type: LEGISLATION_LIST_CURSOR_KIND.column,
      sort,
      key,
      id: brandPersistedLegislationDocumentId(id),
    };
  }

  return null;
};

export const encodeListCursor = (cursor: ListCursor): string => {
  switch (cursor.type) {
    case LEGISLATION_LIST_CURSOR_KIND.recent:
      return encodePaginationCursor([cursor.type, cursor.validFrom, cursor.id]);
    case LEGISLATION_LIST_CURSOR_KIND.search:
      return encodePaginationCursor([
        cursor.type,
        cursor.rank,
        cursor.titleSortKey,
        cursor.id,
      ]);
    case LEGISLATION_LIST_CURSOR_KIND.column:
      return encodePaginationCursor([
        cursor.type,
        cursor.sort,
        cursor.key,
        cursor.id,
      ]);
    default:
      cursor satisfies never;
      return panic("Unhandled statute list cursor");
  }
};

/** The cursor kind a request's order is continued with. */
const listCursorKindFor = ({
  sort,
  trimmedQuery,
}: {
  sort: StatuteListSort | undefined;
  trimmedQuery: string | null;
}) => {
  if (sort !== undefined) {
    return LEGISLATION_LIST_CURSOR_KIND.column;
  }
  return trimmedQuery === null
    ? LEGISLATION_LIST_CURSOR_KIND.recent
    : LEGISLATION_LIST_CURSOR_KIND.search;
};

const listedRef = listedLegislationRef;
const workRef = legislationVersionRefAt("work");

/** The same Work's rows as the listed one: `(source, eli, language)`. */
const sameWork = sql`work.source_id = ${legislationDocuments.sourceId}
  AND work.eli = ${legislationDocuments.eli}
  AND work.language = ${legislationDocuments.language}`;

/**
 * Whether the publisher states that the listed row's Work never took effect:
 * it holds at least one consolidation, and every consolidation it holds is
 * never in force. Anything less (an inconsistent window, only a promulgated
 * text) proves nothing, and the Work is `unknown`.
 *
 * One aggregate over the Work's rows rather than `EXISTS … AND NOT EXISTS …`:
 * `bool_and` of no rows is null, so it is true only for a non-empty set that
 * is all never in force. An aggregate subquery stays a per-row probe, where
 * an `EXISTS` inside a `CASE` may be planned as a hashed scan of the table.
 */
const workNeverInForce = sql`coalesce((
  SELECT bool_and(${workRef.disposition} = 'never-in-force')
  FROM legislation_documents AS work
  WHERE ${sameWork}
    AND ${applicableKind(workRef)}
    AND ${notWithdrawn(workRef)}
), false)`;

/** Whether the listed wording still applies on `asOf`; see `LEGISLATION_LIST_VALIDITIES`. */
const listValidity = (asOf: SQLWrapper): SQL<LegislationListValidity> =>
  sql<LegislationListValidity>`(CASE
    WHEN ${inForceOn(listedRef, asOf)} THEN 'in-force'
    WHEN ${eligibleExpression(listedRef)} THEN 'ended'
    WHEN ${workNeverInForce} THEN 'never-in-force'
    ELSE 'unknown'
  END)`;

/**
 * When the Work's earliest eligible wording on record opens. What the corpus
 * proves is the first consolidation window, which is not always the day the
 * act took effect: e-Sbírka opens a Czech act's first window at publication
 * (89/2012 Sb. opens 2012-03-22, though it took effect 2014-01-01).
 *
 * A scalar subquery in the select list, so it is evaluated for the page's
 * rows only; each is one probe of the unique `(source, eli, valid_from,
 * language)` index.
 */
const firstVersionValidFrom = sql<string | null>`(
  SELECT min(${workRef.validFrom})::text
  FROM legislation_documents AS work
  WHERE ${sameWork}
    AND ${eligibleExpression(workRef)}
)`;

/**
 * How many eligible wordings replaced an earlier one up to `asOf`: the Work's
 * eligible windows opened by then, less the first. A count of wording
 * changes, not of amending acts: several acts taking effect the same day
 * count once, one act taking effect in stages counts per stage, and a Czech
 * act published before it took effect counts its entry into force once (see
 * `firstVersionValidFrom`). A promulgated text or a version that never took
 * effect replaced nothing, so neither counts.
 */
const amendmentCount = (asOf: SQLWrapper): SQL<number> => sql<number>`(
  SELECT greatest(count(*) - 1, 0)::integer
  FROM legislation_documents AS work
  WHERE ${sameWork}
    AND ${eligibleExpression(workRef)}
    AND ${opensOnOrBefore(workRef, asOf)}
)`;

/**
 * When the last change took effect: the listed wording's opening, when an
 * earlier eligible wording exists for it to have replaced
 * (`amendmentCount > 0`). A listed version that cannot apply changed nothing.
 */
const lastAmendedOn = sql<string | null>`(CASE
  WHEN ${eligibleExpression(listedRef)} AND EXISTS (
    SELECT 1
    FROM legislation_documents AS work
    WHERE ${sameWork}
      AND ${eligibleExpression(workRef)}
      AND ${opensBefore(workRef, legislationDocuments.versionValidFrom)}
  )
  THEN ${legislationDocuments.versionValidFrom}::text
END)`;

/**
 * The act's number as its ELI names it, read with the pattern the year
 * filter and the rows' number labels are read with, so the order by number
 * is the order of the numbers the rows print. Null for an ELI naming none.
 */
const actNumber = sql<number | null>`((regexp_match(
  ${legislationDocuments.eli},
  ${STATUTE_ELI_IDENTITY_PATTERN}
))[3])::integer`;

/**
 * What each column order sorts by: the value the row displays for that
 * column, computed the same way. Dates are ISO text compared byte for byte,
 * so their order is the calendar's whatever the database collation.
 */
const columnSortKey = (
  key: StatuteListSortKey,
  asOf: SQLWrapper,
): SQL<ColumnSortKeyValue> => {
  switch (key) {
    case "actNumber":
      return actNumber;
    case "firstVersion":
      return sql<string | null>`(${firstVersionValidFrom} COLLATE "C")`;
    case "amendments":
      return amendmentCount(asOf);
    case "lastAmended":
      return sql<string | null>`(${lastAmendedOn} COLLATE "C")`;
    case "citedBy":
      return statuteCitationCaseCount;
    default:
      key satisfies never;
      return panic("Unhandled statute list sort key");
  }
};

/** The select-list name the column order is sorted by, computed once a row. */
const SORT_KEY_COLUMN = sql.identifier("sort_key");

/**
 * The rows after the cursor in a column order: Works without a value come
 * last whichever way the order runs, and the document id breaks every tie.
 */
const afterColumnCursor = (
  sortKey: SQL<ColumnSortKeyValue>,
  cursor: Extract<
    ListCursor,
    { type: typeof LEGISLATION_LIST_CURSOR_KIND.column }
  >,
): SQL => {
  const descending = STATUTE_LIST_SORT_ORDERS[cursor.sort].direction === "desc";
  const beyond = descending ? sql`<` : sql`>`;
  const id = legislationDocuments.id;
  if (cursor.key === null) {
    return sql`(${sortKey} IS NULL AND ${id} ${beyond} ${cursor.id}::uuid)`;
  }
  return sql`(
    ${sortKey} ${beyond} ${cursor.key}
    OR (${sortKey} = ${cursor.key} AND ${id} ${beyond} ${cursor.id}::uuid)
    OR ${sortKey} IS NULL
  )`;
};

/**
 * 0 for a work whose name starts with the typed text, 1 for one that merely
 * mentions it: `občanský zákoník` must rank the code above the acts amending
 * it (`kterým se mění zákon č. 89/2012 Sb., občanský zákoník`). Both sides
 * fold through `legislation_title_fold`, so a query typed without diacritics
 * ranks the same as one typed with them.
 */
const titleRank = (trimmedQuery: string): SQL<number> => sql<number>`(CASE
  WHEN ${legislationTitleFold(legislationTitleName(legislationDocuments.title))}
    LIKE ${escapeLikeSql(legislationTitleFold(trimmedQuery))} || '%'
  THEN 0
  ELSE 1
END)`;

export const listStatutesHandler = async (
  query: ListStatutesQuery,
  legislationDb: LegislationReadDb,
) => {
  const countryRead = readPublicLawCountry(query.country, {
    domain: "legislation",
    admitted: PUBLIC_LEGISLATION_COUNTRIES,
    surface: "search",
  });
  if (countryRead.kind === "unavailable") {
    return countryRead.answer;
  }
  if (countryRead.kind === "unreadable") {
    return status(400, { message: countryRead.message });
  }
  // Every Work's value is computed to order by a column, so only a year's
  // acts are ever ordered that way; a jurisdiction is refused, not walked.
  if (query.sort !== undefined && !statuteListSortIsBounded(query)) {
    return status(400, {
      code: STATUTE_LIST_SORT_NEEDS_YEAR_CODE,
      message: STATUTE_LIST_SORT_NEEDS_YEAR_MESSAGE,
    });
  }
  const limit = normalizeTenantPageLimit(
    query.limit ?? LIMITS.legislationListPageSizeDefault,
  );
  const cursor =
    query.cursor === undefined ? null : decodeListCursor(query.cursor);
  if (query.cursor !== undefined && cursor === null) {
    return status(400, { message: "Invalid cursor" });
  }
  const asOf =
    query.asOf === undefined ? sql`CURRENT_DATE` : sql`${query.asOf}::date`;
  const trimmedQuery = query.query?.trim() || null;
  if (
    cursor !== null &&
    (cursor.type !== listCursorKindFor({ sort: query.sort, trimmedQuery }) ||
      (cursor.type === LEGISLATION_LIST_CURSOR_KIND.column &&
        cursor.sort !== query.sort))
  ) {
    return status(400, { message: "Invalid cursor" });
  }
  if (
    query.number !== undefined &&
    actNumberCondition({
      number: query.number,
      collection: query.collection,
    }) === null
  ) {
    return status(400, { message: "Invalid act number" });
  }

  const normalizedQuery = { ...query };
  delete normalizedQuery.query;
  if (trimmedQuery !== null) {
    normalizedQuery.query = trimmedQuery;
  }

  const rows = await legislationDb(
    async (tx) =>
      await buildListStatutesQuery(tx, {
        country: countryRead.country,
        query: normalizedQuery,
        limit,
        cursor,
        asOf,
      }),
  );

  const { sort } = query;
  const page = createCursorPage({
    rows,
    limit,
    cursorForItem: (item) => {
      if (sort !== undefined) {
        return encodeListCursor({
          type: LEGISLATION_LIST_CURSOR_KIND.column,
          sort,
          key: item.sortKey,
          id: item.id,
        });
      }
      return trimmedQuery === null
        ? encodePaginationCursor([
            LEGISLATION_LIST_CURSOR_KIND.recent,
            item.validFromKey,
            item.id,
          ])
        : encodePaginationCursor([
            LEGISLATION_LIST_CURSOR_KIND.search,
            String(item.rank),
            item.titleSortKey,
            item.id,
          ]);
    },
  });

  return {
    ...page,
    items: page.items.map(
      ({
        rank: _rank,
        sortKey: _sortKey,
        titleSortKey: _titleSortKey,
        validFromKey: _validFromKey,
        ...item
      }) => projectStatuteListItem(item),
    ),
  };
};

type BuildListStatutesQueryOptions = {
  country: string;
  query: Omit<ListStatutesQuery, "country" | "limit" | "cursor" | "asOf">;
  limit: number;
  cursor: ListCursor | null;
  asOf: SQLWrapper;
};

/** Builds the same bounded production statement used by the public list handler. */
export const buildListStatutesQuery = (
  tx: LegislationReadTransaction,
  { country, query, limit, cursor, asOf }: BuildListStatutesQueryOptions,
) => {
  const conditions: SQL[] = [
    publishedLegislationDocumentFor("search"),
    eq(legislationDocuments.country, country),
    isLatestOpenedVersionOfWorkAt(asOf),
  ];

  if (query.validity !== undefined) {
    conditions.push(sql`${listValidity(asOf)} = ${query.validity}`);
  }

  if (query.documentType !== undefined) {
    conditions.push(eq(legislationDocuments.documentType, query.documentType));
  }

  if (query.language) {
    conditions.push(eq(legislationDocuments.language, query.language));
  }

  if (query.year !== undefined) {
    conditions.push(actYearCondition(query.year));
  }

  if (query.number !== undefined) {
    const byNumber = actNumberCondition({
      number: query.number,
      collection: query.collection,
    });
    if (byNumber === null) {
      return panic("List statutes query received an invalid act number");
    }
    conditions.push(byNumber);
  }

  const trimmedQuery = query.query?.trim() || null;

  if (trimmedQuery !== null) {
    const titleOrEli = or(
      sql`${legislationTitleFold(legislationDocuments.title)} LIKE '%' || ${escapeLikeSql(legislationTitleFold(trimmedQuery))} || '%'`,
      ilike(legislationDocuments.eli, `%${escapeLike(trimmedQuery)}%`),
    );
    if (titleOrEli) {
      conditions.push(titleOrEli);
    }
  }

  if (query.sort !== undefined && !statuteListSortIsBounded(query)) {
    return panic("List statutes query ordered an unbounded set by a column");
  }
  const columnOrder =
    query.sort === undefined ? null : STATUTE_LIST_SORT_ORDERS[query.sort];
  const sortKey =
    columnOrder === null ? null : columnSortKey(columnOrder.key, asOf);

  const ordering = (() => {
    if (columnOrder !== null) {
      // By the select-list name, so each row's value is computed once.
      const direction = columnOrder.direction === "desc" ? sql`DESC` : sql`ASC`;
      return {
        type: LEGISLATION_LIST_CURSOR_KIND.column,
        orderBy: [
          sql`${SORT_KEY_COLUMN} ${direction} NULLS LAST`,
          columnOrder.direction === "desc"
            ? desc(legislationDocuments.id)
            : asc(legislationDocuments.id),
        ],
      };
    }
    return trimmedQuery === null
      ? {
          type: LEGISLATION_LIST_CURSOR_KIND.recent,
          orderBy: [desc(validFromKey), desc(legislationDocuments.id)],
        }
      : {
          type: LEGISLATION_LIST_CURSOR_KIND.search,
          orderBy: [
            asc(titleRank(trimmedQuery)),
            asc(titleSortKey),
            asc(legislationDocuments.id),
          ],
        };
  })();

  if (cursor !== null) {
    if (cursor.type !== ordering.type) {
      return panic("List statutes query received a mismatched cursor");
    }
    switch (cursor.type) {
      case LEGISLATION_LIST_CURSOR_KIND.recent:
        conditions.push(
          sql`(${validFromKey}, ${legislationDocuments.id}) < (${cursor.validFrom}::date, ${cursor.id}::uuid)`,
        );
        break;
      case LEGISLATION_LIST_CURSOR_KIND.search:
        conditions.push(
          sql`(${titleRank(trimmedQuery ?? "")}, ${titleSortKey}, ${legislationDocuments.id}) > (${cursor.rank}::int, ${cursor.titleSortKey}, ${cursor.id}::uuid)`,
        );
        break;
      case LEGISLATION_LIST_CURSOR_KIND.column:
        if (sortKey === null || cursor.sort !== query.sort) {
          return panic("List statutes query received a mismatched cursor");
        }
        conditions.push(afterColumnCursor(sortKey, cursor));
        break;
      default:
        cursor satisfies never;
        return panic("Unhandled statute list cursor");
    }
  }

  return tx
    .select({
      id: legislationDocuments.id,
      eli: legislationDocuments.eli,
      slug: legislationDocuments.slug,
      title: legislationDocuments.title,
      titleSortKey,
      validFromKey: sql<string>`${validFromKey}::text`.as("valid_from_key"),
      rank:
        trimmedQuery === null
          ? sql<number>`0`.as("title_rank")
          : sql<number>`${titleRank(trimmedQuery)}`.as("title_rank"),
      sortKey:
        sortKey === null
          ? sql<ColumnSortKeyValue>`NULL`.as("sort_key")
          : sql<ColumnSortKeyValue>`${sortKey}`.as("sort_key"),
      country: legislationDocuments.country,
      language: legislationDocuments.language,
      documentType: legislationDocuments.documentType,
      status: legislationDocumentStatusToday,
      effectiveDate: legislationDocuments.effectiveDate,
      versionValidFrom: legislationDocuments.versionValidFrom,
      versionValidTo: legislationDocuments.versionValidTo,
      sourceUrl: legislationDocuments.sourceUrl,
      documentUrl: legislationDocuments.documentUrl,
      citationCaseCount: statuteCitationCaseCount.as("citation_case_count"),
      firstVersionValidFrom: firstVersionValidFrom.as(
        "first_version_valid_from",
      ),
      amendmentCount: amendmentCount(asOf).as("amendment_count"),
      lastAmendedOn: lastAmendedOn.as("last_amended_on"),
      validity: listValidity(asOf).as("validity"),
    })
    .from(legislationDocuments)
    .innerJoin(
      legislationSources,
      eq(legislationSources.id, legislationDocuments.sourceId),
    )
    .leftJoin(caseLawStatuteCitationCountState, statuteCitationCountStateJoin)
    .where(and(...conditions))
    .orderBy(...ordering.orderBy)
    .limit(limit + 1);
};
