import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

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
import {
  statuteCitationCaseCount,
  statuteCitationCountStateJoin,
} from "@/api/handlers/legislation/citation-count";
import type { SafeId } from "@/api/lib/branded-types";
import { tPaginationCursor, tPaginationLimit } from "@/api/lib/custom-schema";
import { escapeLike } from "@/api/lib/escape-like";
import { publishedLegislationDocument } from "@/api/lib/legal-search/legislation-redistribution";
import {
  inForceOn,
  versionSortKey,
} from "@/api/lib/legal-search/legislation-validity-window";
import {
  readPublicLawCountry,
  tPublicLawCountry,
} from "@/api/lib/legal-search/public-law-country";
import type { LegislationReadDb } from "@/api/lib/legislation-public-read-db";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isDateOnlyPaginationCursorPart,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import { brandPersistedLegislationDocumentId } from "@/api/lib/safe-id-boundaries";

/** `<number>/<year>` as a collection prints it: `89/2012`. */
export const ACT_NUMBER_PATTERN = /^([0-9]{1,5})\/([0-9]{4})$/u;
/** A publisher collection segment of an ELI: `sb`, `ul1`, `zz`. */
const COLLECTION_PATTERN = /^[a-z0-9]{1,8}$/u;

export const listStatutesQuerySchema = t.Object({
  country: tPublicLawCountry,
  query: t.Optional(t.String({ maxLength: 256 })),
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
    t.Union(LEGISLATION_LIST_VALIDITIES.map((value) => t.Literal(value))),
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

/**
 * The one applicable consolidation of a work: no later window covering the
 * same date exists for its `(source, eli, language)`. The anti-join keeps the
 * list flat, so Postgres can stop at the page limit.
 */
const isVersionOfWorkAt = (asOf: SQLWrapper): SQL => sql`NOT EXISTS (
    SELECT 1
    FROM legislation_documents AS newer
    WHERE newer.source_id = ${legislationDocuments.sourceId}
      AND newer.eli = ${legislationDocuments.eli}
      AND newer.language = ${legislationDocuments.language}
      AND newer.id <> ${legislationDocuments.id}
      AND (${inForceOn(sql`newer.version_valid_from`, sql`newer.version_valid_to`, asOf)})
      AND (
        ${versionSortKey(sql`newer.version_valid_from`)},
        newer.id
      ) > (
        ${versionSortKey(legislationDocuments.versionValidFrom)},
        ${legislationDocuments.id}
      )
  )`;

/** The version each work's ordinary, present-day listing shows. */
export const isCurrentVersionOfWork = isVersionOfWorkAt(sql`CURRENT_DATE`);

/**
 * The row a listing shows per Work: the latest wording that opened on or
 * before `asOf`, whether or not its window is still open. A Work whose last
 * wording closed is listed as ended rather than dropped, so a repealed act
 * stays findable; a Work whose every wording opens after `asOf` is not listed.
 */
const isLatestOpenedVersionOfWorkAt = (asOf: SQLWrapper): SQL => sql`(
  ${legislationDocuments.versionValidFrom} IS NULL
  OR ${legislationDocuments.versionValidFrom} <= ${asOf}
) AND NOT EXISTS (
    SELECT 1
    FROM legislation_documents AS newer
    WHERE newer.source_id = ${legislationDocuments.sourceId}
      AND newer.eli = ${legislationDocuments.eli}
      AND newer.language = ${legislationDocuments.language}
      AND newer.id <> ${legislationDocuments.id}
      AND (newer.version_valid_from IS NULL OR newer.version_valid_from <= ${asOf})
      AND (
        ${versionSortKey(sql`newer.version_valid_from`)},
        newer.id
      ) > (
        ${versionSortKey(legislationDocuments.versionValidFrom)},
        ${legislationDocuments.id}
      )
  )`;

/** Whether the listed wording still applies on `asOf`; see `LEGISLATION_LIST_VALIDITIES`. */
const listValidity = (asOf: SQLWrapper): SQL<LegislationListValidity> =>
  sql<LegislationListValidity>`(CASE
    WHEN ${legislationDocuments.versionValidTo} IS NULL
      OR ${legislationDocuments.versionValidTo} > ${asOf}
    THEN 'in-force'
    ELSE 'ended'
  END)`;

/** The same Work's rows as the listed one: `(source, eli, language)`. */
const sameWork = sql`work.source_id = ${legislationDocuments.sourceId}
  AND work.eli = ${legislationDocuments.eli}
  AND work.language = ${legislationDocuments.language}`;

/**
 * When the Work's earliest wording on record opens. What the corpus proves is
 * the first consolidation window, which is not always the day the act took
 * effect: e-Sbírka opens a Czech act's first window at publication (89/2012
 * Sb. opens 2012-03-22, though it took effect 2014-01-01).
 *
 * A scalar subquery in the select list, so it is evaluated for the page's
 * rows only; each is one probe of the unique `(source, eli, valid_from,
 * language)` index.
 */
const firstVersionValidFrom = sql<string | null>`(
  SELECT min(work.version_valid_from)::text
  FROM legislation_documents AS work
  WHERE ${sameWork}
)`;

/**
 * How many wordings replaced an earlier one up to `asOf`: the Work's windows
 * opened by then, less the first. A count of wording changes, not of amending
 * acts: several acts taking effect the same day count once, one act taking
 * effect in stages counts per stage, and a Czech act published before it took
 * effect counts its entry into force once (see `firstVersionValidFrom`).
 */
const amendmentCount = (asOf: SQLWrapper): SQL<number> => sql<number>`(
  SELECT greatest(count(*) - 1, 0)::integer
  FROM legislation_documents AS work
  WHERE ${sameWork}
    AND work.version_valid_from <= ${asOf}
)`;

/**
 * When the last change took effect: the listed wording's opening, when an
 * earlier wording exists for it to have replaced (`amendmentCount > 0`).
 */
const lastAmendedOn = sql<string | null>`(CASE
  WHEN EXISTS (
    SELECT 1
    FROM legislation_documents AS work
    WHERE ${sameWork}
      AND work.version_valid_from < ${legislationDocuments.versionValidFrom}
  )
  THEN ${legislationDocuments.versionValidFrom}::text
END)`;

/**
 * The work an act number names. ELIs end in `/<collection>/<year>/<number>`
 * (`/eli/cz/sb/2012/89`), so the number is matched on that tail: a suffix
 * match the trigram index serves, made exact by the anchored pattern so
 * `/2012/89` cannot answer for `/2012/189`. Without a collection every
 * collection of the jurisdiction qualifies; the caller shows the candidates
 * rather than picking one.
 */
const actNumberCondition = (
  number: string,
  collection: string | undefined,
): SQL | null => {
  const match = ACT_NUMBER_PATTERN.exec(number);
  const ordinal = match?.[1];
  const year = match?.[2];
  if (ordinal === undefined || year === undefined) {
    return null;
  }
  const tail = `${year}/${ordinal}`;
  const anchored =
    collection === undefined ? `(^|/)${tail}$` : `/${collection}/${tail}$`;
  return sql`(
    ${legislationDocuments.eli} LIKE ${`%${tail}`}
    AND ${legislationDocuments.eli} ~ ${anchored}
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
  if (countryRead.kind === "unreadable") {
    return status(400, { message: countryRead.message });
  }
  const limit = query.limit ?? LIMITS.legislationListPageSizeDefault;
  const cursor =
    query.cursor === undefined ? null : decodeListCursor(query.cursor);
  if (query.cursor !== undefined && cursor === null) {
    return status(400, { message: "Invalid cursor" });
  }
  const asOf =
    query.asOf === undefined ? sql`CURRENT_DATE` : sql`${query.asOf}::date`;
  const conditions: SQL[] = [
    publishedLegislationDocument,
    eq(legislationDocuments.country, countryRead.country),
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

  if (query.number !== undefined) {
    const byNumber = actNumberCondition(query.number, query.collection);
    if (byNumber === null) {
      return status(400, { message: "Invalid act number" });
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
      return status(400, { message: "Invalid cursor" });
    }
    conditions.push(
      cursor.type === LEGISLATION_LIST_CURSOR_KIND.recent
        ? sql`(${validFromKey}, ${legislationDocuments.id}) < (${cursor.validFrom}::date, ${cursor.id}::uuid)`
        : sql`(${titleRank(trimmedQuery ?? "")}, ${titleSortKey}, ${legislationDocuments.id}) > (${cursor.rank}::int, ${cursor.titleSortKey}, ${cursor.id}::uuid)`,
    );
  }

  const rows = await legislationDb(
    async (tx) =>
      await tx
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
        .leftJoin(
          caseLawStatuteCitationCountState,
          statuteCitationCountStateJoin,
        )
        .where(and(...conditions))
        .orderBy(...ordering.orderBy)
        .limit(limit + 1),
  );

  const page = createCursorPage({
    rows,
    limit,
    cursorForItem: (item) =>
      ordering.type === LEGISLATION_LIST_CURSOR_KIND.recent
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
      }) => item,
    ),
  };
};
