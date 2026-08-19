import { and, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import { legislationDocuments } from "@/api/db/schema";
import {
  UNVERSIONED_SORT_DATE,
  versionSortKey,
} from "@/api/handlers/legislation/validity-window";
import {
  selectWorkKey,
  workKeyConditions,
} from "@/api/handlers/legislation/work-key";
import type { SafeId } from "@/api/lib/branded-types";
import {
  tPaginationCursor,
  tPaginationLimit,
  tSafeId,
} from "@/api/lib/custom-schema";
import type { LegislationReadDb } from "@/api/lib/legislation-public-read-db";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
  isDateOnlyPaginationCursorPart,
} from "@/api/lib/pagination";
import { brandPersistedLegislationDocumentId } from "@/api/lib/safe-id-boundaries";

export const listStatuteVersionsParamsSchema = t.Object({
  documentId: tSafeId("legislationDocument"),
});

export const listStatuteVersionsQuerySchema = t.Object({
  limit: t.Optional(tPaginationLimit(LIMITS.legislationVersionsPageSizeMax)),
  cursor: t.Optional(tPaginationCursor()),
});

type ListStatuteVersionsQuery = Static<typeof listStatuteVersionsQuerySchema>;

type ListStatuteVersionsOptions = {
  documentId: SafeId<"legislationDocument">;
  query: ListStatuteVersionsQuery;
  legislationDb: LegislationReadDb;
};

type VersionCursor = {
  validFrom: string;
  id: SafeId<"legislationDocument">;
};

const decodeVersionCursor = (cursor: string): VersionCursor | null => {
  const parts = decodePaginationCursor(cursor);

  if (parts?.length !== 2) {
    return null;
  }

  const [validFrom, id] = parts;

  if (
    !isDateOnlyPaginationCursorPart(validFrom) ||
    !isUuidPaginationCursorPart(id)
  ) {
    return null;
  }

  return { validFrom, id: brandPersistedLegislationDocumentId(id) };
};

/**
 * Every consolidated version of the work the given document belongs to,
 * newest validity window first. The work key is the source, ELI and
 * language triple the unique indexes are built on.
 */
export const listStatuteVersionsHandler = async ({
  documentId,
  query,
  legislationDb,
}: ListStatuteVersionsOptions) => {
  const limit = query.limit ?? LIMITS.legislationVersionsPageSizeDefault;
  let cursor: VersionCursor | null = null;

  if (query.cursor !== undefined) {
    cursor = decodeVersionCursor(query.cursor);

    if (cursor === null) {
      return status(400, { message: "Invalid cursor" });
    }
  }

  const rows = await legislationDb(async (tx) => {
    const work = await selectWorkKey(tx, documentId);

    if (work === null) {
      return null;
    }

    const conditions: SQL[] = workKeyConditions(work);

    if (cursor !== null) {
      conditions.push(
        sql`(${versionSortKey(legislationDocuments.versionValidFrom)}, ${legislationDocuments.id}) < (${cursor.validFrom}::date, ${cursor.id}::uuid)`,
      );
    }

    return await tx
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
      .where(and(...conditions))
      .orderBy(
        sql`${versionSortKey(legislationDocuments.versionValidFrom)} desc`,
        sql`${legislationDocuments.id} desc`,
      )
      .limit(limit + 1);
  });

  if (rows === null) {
    return status(404, { message: "Legislation document not found" });
  }

  return createCursorPage({
    rows,
    limit,
    cursorForItem: (item) =>
      encodePaginationCursor([
        item.versionValidFrom ?? UNVERSIONED_SORT_DATE,
        item.id,
      ]),
  });
};
