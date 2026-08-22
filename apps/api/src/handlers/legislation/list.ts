import { and, asc, eq, gt, ilike, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import {
  LEGISLATION_TITLE_SORT_KEY_CHARS,
  legislationDocuments,
  legislationSources,
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
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import { brandPersistedLegislationDocumentId } from "@/api/lib/safe-id-boundaries";

export const listStatutesQuerySchema = t.Object({
  country: t.String({ minLength: 2, maxLength: 3 }),
  query: t.Optional(t.String({ maxLength: 256 })),
  language: t.Optional(t.String({ maxLength: 8 })),
  limit: t.Optional(tPaginationLimit(LIMITS.legislationListPageSizeMax)),
  cursor: t.Optional(tPaginationCursor()),
});

type ListStatutesQuery = Static<typeof listStatutesQuerySchema>;

type TitleSortIdCursor = {
  titleSortKey: string;
  id: SafeId<"legislationDocument">;
};

const decodeTitleSortIdCursor = (cursor: string): TitleSortIdCursor | null => {
  const parts = decodePaginationCursor(cursor);

  if (parts?.length !== 2) {
    return null;
  }

  const [titleCursorPart, id] = parts;

  if (typeof titleCursorPart !== "string" || !isUuidPaginationCursorPart(id)) {
    return null;
  }

  return {
    // The prior release emitted the full title. Accept that concrete rolling
    // deployment state, but normalize it to the generated ordering key; this
    // release emits only the bounded key below.
    titleSortKey: Array.from(titleCursorPart)
      .slice(0, LEGISLATION_TITLE_SORT_KEY_CHARS)
      .join(""),
    id: brandPersistedLegislationDocumentId(id),
  };
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

export const listStatutesHandler = async (
  query: ListStatutesQuery,
  legislationDb: LegislationReadDb,
) => {
  const limit = query.limit ?? LIMITS.legislationListPageSizeDefault;
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

  const trimmedQuery = query.query?.trim();

  if (trimmedQuery) {
    const pattern = `%${escapeLike(trimmedQuery)}%`;
    const titleOrEli = or(
      ilike(legislationDocuments.title, pattern),
      ilike(legislationDocuments.eli, pattern),
    );

    if (titleOrEli) {
      conditions.push(titleOrEli);
    }
  }

  if (query.cursor !== undefined) {
    const cursor = decodeTitleSortIdCursor(query.cursor);

    if (cursor === null) {
      return status(400, { message: "Invalid cursor" });
    }

    const keyset = or(
      gt(legislationDocuments.titleSortKey, cursor.titleSortKey),
      and(
        eq(legislationDocuments.titleSortKey, cursor.titleSortKey),
        gt(legislationDocuments.id, cursor.id),
      ),
    );

    if (keyset) {
      conditions.push(keyset);
    }
  }

  const rows = await legislationDb(
    async (tx) =>
      await tx
        .select({
          id: legislationDocuments.id,
          eli: legislationDocuments.eli,
          title: legislationDocuments.title,
          titleSortKey: legislationDocuments.titleSortKey,
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
        .orderBy(
          asc(legislationDocuments.titleSortKey),
          asc(legislationDocuments.id),
        )
        .limit(limit + 1),
  );

  const page = createCursorPage({
    rows,
    limit,
    cursorForItem: (item) =>
      encodePaginationCursor([item.titleSortKey, item.id]),
  });

  return {
    ...page,
    items: page.items.map(({ titleSortKey: _titleSortKey, ...item }) => item),
  };
};
