import { and, asc, eq, gt, ilike, or, sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import { legislationDocuments, legislationSources } from "@/api/db/schema";
import { redistributableLegislationSource } from "@/api/handlers/legislation/redistribution";
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

type TitleIdCursor = {
  title: string;
  id: SafeId<"legislationDocument">;
};

const decodeTitleIdCursor = (cursor: string): TitleIdCursor | null => {
  const parts = decodePaginationCursor(cursor);

  if (parts?.length !== 2) {
    return null;
  }

  const [title, id] = parts;

  if (typeof title !== "string" || !isUuidPaginationCursorPart(id)) {
    return null;
  }

  return { title, id: brandPersistedLegislationDocumentId(id) };
};

/** Works with no version window sort below every dated consolidation. */
const UNVERSIONED_SORT_DATE = "0001-01-01";

/**
 * A version window that has opened and has not closed. A null
 * `version_valid_from` marks a work kept as a single unversioned text.
 */
const inForceToday = (validFrom: SQLWrapper, validTo: SQLWrapper): SQL => sql`(
  ${validFrom} IS NULL OR ${validFrom} <= CURRENT_DATE
) AND (
  ${validTo} IS NULL OR ${validTo} >= CURRENT_DATE
)`;

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
      coalesce(newer.version_valid_from, DATE '${sql.raw(UNVERSIONED_SORT_DATE)}'),
      newer.id
    ) > (
      coalesce(${legislationDocuments.versionValidFrom}, DATE '${sql.raw(UNVERSIONED_SORT_DATE)}'),
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
    const cursor = decodeTitleIdCursor(query.cursor);

    if (cursor === null) {
      return status(400, { message: "Invalid cursor" });
    }

    const keyset = or(
      gt(legislationDocuments.title, cursor.title),
      and(
        eq(legislationDocuments.title, cursor.title),
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
        .orderBy(asc(legislationDocuments.title), asc(legislationDocuments.id))
        .limit(limit + 1),
  );

  return createCursorPage({
    rows,
    limit,
    cursorForItem: (item) => encodePaginationCursor([item.title, item.id]),
  });
};
