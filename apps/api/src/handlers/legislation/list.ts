import { panic } from "better-result";
import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import { LAW_YEAR_BOUNDS } from "@stll/api-contract/law-year";
import { PUBLIC_LEGISLATION_COUNTRIES } from "@stll/api-contract/legislation-publication";
import { LEGISLATION_LIST_VALIDITIES } from "@stll/api-contract/legislation-status";
import type { LegislationListValidity } from "@stll/api-contract/legislation-status";

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
import type { SafeId } from "@/api/lib/branded-types";
import { tPaginationCursor, tPaginationLimit } from "@/api/lib/custom-schema";
import { escapeLike } from "@/api/lib/escape-like";
import {
  ACT_NUMBER_PATTERN,
  actNumberCondition,
  actYearCondition,
} from "@/api/lib/legal-search/legislation-act-number";
import {
  isLatestOpenedVersionOfWorkAt,
  listedLegislationRef,
} from "@/api/lib/legal-search/legislation-listed-version";
import { publishedLegislationDocument } from "@/api/lib/legal-search/legislation-redistribution";
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

export const listStatutesQuerySchema = t.Object({
  country: tPublicLawCountry,
  query: t.Optional(t.String({ maxLength: 256 })),
  /** Year in the act number, not the consolidation date. */
  year: t.Optional(t.Integer(LAW_YEAR_BOUNDS)),
  /** An act's own number, `<number>/<year>`; the request asks for that work. */
  number: t.Optional(t.String({ pattern: ACT_NUMBER_PATTERN.source })),
  /** The collection the number was published in, when the caller knows it. */
  collection: t.Optional(t.String({ pattern: COLLECTION_PATTERN.source })),
  /** Calendar date whose applicable consolidation each work should return. */
  asOf: t.Optional(t.String({ format: "date" })),
  language: t.Optional(t.String({ maxLength: 8 })),
  /** The kind of act, exactly as the publisher names it (`zákon`, `vyhláška`). */
  documentType: t.Optional(t.String({ minLength: 1, maxLength: 128 })),
  /** Works still in force on `asOf`, or works that no longer are; both when absent. */
  validity: t.Optional(
    t.Enum(
      Object.fromEntries(
        LEGISLATION_LIST_VALIDITIES.map((value) => [value, value] as const),
      ),
    ),
  ),
  limit: t.Optional(tPaginationLimit(LIMITS.legislationListPageSizeMax)),
  cursor: t.Optional(tPaginationCursor()),
});

type ListStatutesQuery = Static<typeof listStatutesQuerySchema>;

/**
 * The two orderings the list serves, each with its own cursor protocol. A
 * cursor from one cannot continue the other: the sort keys differ.
 */
export const LEGISLATION_LIST_CURSOR_KIND = {
  /** No text: newest consolidation first. */
  recent: "recent-v1",
  /** A typed name: works named by it first, then works mentioning it. */
  search: "search-v1",
} as const;

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
    };

const titleSortKey = legislationTitleSortKey(legislationDocuments.title);
const validFromKey = versionSortKey(legislationDocuments.versionValidFrom);

const decodeListCursor = (cursor: string): ListCursor | null => {
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

  return null;
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
 * 0 for a work whose name starts with the typed text, 1 for one that merely
 * mentions it: `občanský zákoník` must rank the code above the acts amending
 * it (`kterým se mění zákon č. 89/2012 Sb., občanský zákoník`). Both sides
 * fold through `legislation_title_fold`, so a query typed without diacritics
 * ranks the same as one typed with them.
 */
const titleRank = (trimmedQuery: string): SQL<number> => sql<number>`(CASE
  WHEN ${legislationTitleFold(legislationTitleName(legislationDocuments.title))}
    LIKE ${legislationTitleFold(escapeLike(trimmedQuery))} || '%'
  THEN 0
  ELSE 1
END)`;

export const listStatutesHandler = async (
  query: ListStatutesQuery,
  legislationDb: LegislationReadDb,
) => {
  const countryRead = readPublicLawCountry(query.country, {
    admitted: PUBLIC_LEGISLATION_COUNTRIES,
  });
  if (countryRead.kind === "unavailable") {
    return countryRead.answer;
  }
  if (countryRead.kind === "unreadable") {
    return status(400, { message: countryRead.message });
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
    cursor.type !==
      (trimmedQuery === null
        ? LEGISLATION_LIST_CURSOR_KIND.recent
        : LEGISLATION_LIST_CURSOR_KIND.search)
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

  const page = createCursorPage({
    rows,
    limit,
    cursorForItem: (item) =>
      trimmedQuery === null
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
          ]),
  });

  return {
    ...page,
    items: page.items.map(
      ({
        rank: _rank,
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
    publishedLegislationDocument,
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
      sql`${legislationTitleFold(legislationDocuments.title)} LIKE '%' || ${legislationTitleFold(escapeLike(trimmedQuery))} || '%'`,
      ilike(legislationDocuments.eli, `%${escapeLike(trimmedQuery)}%`),
    );
    if (titleOrEli) {
      conditions.push(titleOrEli);
    }
  }

  const ordering =
    trimmedQuery === null
      ? {
          type: LEGISLATION_LIST_CURSOR_KIND.recent,
          orderBy: [desc(validFromKey), desc(legislationDocuments.id)],
        }
      : {
          type: LEGISLATION_LIST_CURSOR_KIND.search,
          rank: titleRank(trimmedQuery),
          orderBy: [
            asc(titleRank(trimmedQuery)),
            asc(titleSortKey),
            asc(legislationDocuments.id),
          ],
        };

  if (cursor !== null) {
    if (cursor.type !== ordering.type) {
      return panic("List statutes query received a mismatched cursor");
    }
    conditions.push(
      cursor.type === LEGISLATION_LIST_CURSOR_KIND.recent
        ? sql`(${validFromKey}, ${legislationDocuments.id}) < (${cursor.validFrom}::date, ${cursor.id}::uuid)`
        : sql`(${titleRank(trimmedQuery ?? "")}, ${titleSortKey}, ${legislationDocuments.id}) > (${cursor.rank}::int, ${cursor.titleSortKey}, ${cursor.id}::uuid)`,
    );
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
        ordering.type === LEGISLATION_LIST_CURSOR_KIND.search
          ? sql<number>`${ordering.rank}`.as("title_rank")
          : sql<number>`0`.as("title_rank"),
      country: legislationDocuments.country,
      language: legislationDocuments.language,
      documentType: legislationDocuments.documentType,
      status: legislationDocuments.status,
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
