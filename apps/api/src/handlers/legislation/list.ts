import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import {
  LEGISLATION_TITLE_SORT_KEY_CHARS,
  legislationDocuments,
  legislationSources,
  legislationTitleFold,
  legislationTitleName,
  legislationTitleSortKey,
} from "@/api/db/schema";
import { redistributableLegislationSource } from "@/api/handlers/legislation/redistribution";
import {
  inForceToday,
  versionSortKey,
} from "@/api/handlers/legislation/validity-window";
import type { SafeId } from "@/api/lib/branded-types";
import { tPaginationCursor, tPaginationLimit } from "@/api/lib/custom-schema";
import { escapeLike } from "@/api/lib/escape-like";
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
  country: t.String({ minLength: 2, maxLength: 3 }),
  query: t.Optional(t.String({ maxLength: 256 })),
  /** An act's own number, `<number>/<year>`; the request asks for that work. */
  number: t.Optional(t.String({ pattern: ACT_NUMBER_PATTERN.source })),
  /** The collection the number was published in, when the caller knows it. */
  collection: t.Optional(t.String({ pattern: COLLECTION_PATTERN.source })),
  language: t.Optional(t.String({ maxLength: 8 })),
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
 * Keeps only the version in force for its work: no other in-force row of the
 * same work (source, ELI and language, the key the unique indexes use) has a
 * later validity window. An anti-join rather than `DISTINCT ON` so the query
 * stays flat and Postgres can stop at the page limit.
 */
const isCurrentVersionOfWork = sql`NOT EXISTS (
  SELECT 1
  FROM legislation_documents AS newer
  WHERE newer.source_id = ${legislationDocuments.sourceId}
    AND newer.eli = ${legislationDocuments.eli}
    AND newer.language = ${legislationDocuments.language}
    AND newer.id <> ${legislationDocuments.id}
    AND (${inForceToday(sql`newer.version_valid_from`, sql`newer.version_valid_to`)})
    AND (
      ${versionSortKey(sql`newer.version_valid_from`)},
      newer.id
    ) > (
      ${versionSortKey(legislationDocuments.versionValidFrom)},
      ${legislationDocuments.id}
    )
)`;

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
  const limit = query.limit ?? LIMITS.legislationListPageSizeDefault;
  const cursor =
    query.cursor === undefined ? null : decodeListCursor(query.cursor);
  if (query.cursor !== undefined && cursor === null) {
    return status(400, { message: "Invalid cursor" });
  }
  const conditions: SQL[] = [
    redistributableLegislationSource,
    eq(legislationDocuments.country, query.country.toUpperCase()),
    inForceToday(
      legislationDocuments.versionValidFrom,
      legislationDocuments.versionValidTo,
    ),
    isCurrentVersionOfWork,
  ];

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
        })
        .from(legislationDocuments)
        .innerJoin(
          legislationSources,
          eq(legislationSources.id, legislationDocuments.sourceId),
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
