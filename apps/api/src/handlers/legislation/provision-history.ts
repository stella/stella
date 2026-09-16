import { and, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import { mapWithConcurrency } from "@stll/concurrency";

import { legislationDocuments, legislationSources } from "@/api/db/schema";
import { extractProvisionText } from "@/api/handlers/legislation/provision-text";
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
import { derivedAiLegislationSource } from "@/api/lib/legal-search/legislation-redistribution";
import {
  UNVERSIONED_SORT_DATE,
  versionSortKey,
} from "@/api/lib/legal-search/legislation-validity-window";
import {
  readVersionBlocks,
  versionAstColumns,
} from "@/api/lib/legal-search/legislation-version-blocks";
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

const HISTORY_READ_STEP = "provisionHistory.corpusAst";

export const provisionHistoryParamsSchema = t.Object({
  documentId: tSafeId("legislationDocument"),
  anchor: t.String({ minLength: 1, maxLength: 256 }),
});

export const provisionHistoryQuerySchema = t.Object({
  limit: t.Optional(
    tPaginationLimit(LIMITS.legislationProvisionHistoryPageSizeMax),
  ),
  cursor: t.Optional(tPaginationCursor()),
});

type ProvisionHistoryQuery = Static<typeof provisionHistoryQuerySchema>;

type ProvisionHistoryOptions = {
  documentId: SafeId<"legislationDocument">;
  anchor: string;
  query: ProvisionHistoryQuery;
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

const versionColumns = {
  ...versionAstColumns,
  versionValidFrom: legislationDocuments.versionValidFrom,
  versionValidTo: legislationDocuments.versionValidTo,
  // Displaying a consolidation's wording and feeding it to a model are
  // separate publisher permissions. The reader ignores this; the agent-facing
  // history withholds the text of a version whose source bars derived AI use,
  // so the permission travels with every item instead of being re-queried.
  allowsDerivedAi: derivedAiLegislationSource,
};

/**
 * One provision's text across the consolidations of its Work, newest window
 * first, so a reader can diff a section without downloading whole statutes.
 *
 * The page walks versions, not occurrences: a version in which the anchor is
 * absent is dropped from `items` while still counting against the page, so
 * the cursor stays a plain keyset over the version order. The addressed
 * document only establishes the Work key: an anchor a later consolidation
 * dropped is still reachable, and "provision not found" is answered once the
 * walk has seen every version of the Work without one occurrence.
 */
export const readProvisionHistoryHandler = async ({
  documentId,
  anchor,
  query,
  legislationDb,
}: ProvisionHistoryOptions) => {
  const limit =
    query.limit ?? LIMITS.legislationProvisionHistoryPageSizeDefault;
  let cursor: VersionCursor | null = null;

  if (query.cursor !== undefined) {
    cursor = decodeVersionCursor(query.cursor);

    if (cursor === null) {
      return status(400, { message: "Invalid cursor" });
    }
  }

  const versions = await legislationDb(async (tx) => {
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
      .select(versionColumns)
      .from(legislationDocuments)
      .innerJoin(
        legislationSources,
        eq(legislationSources.id, legislationDocuments.sourceId),
      )
      .where(and(...conditions))
      .orderBy(
        sql`${versionSortKey(legislationDocuments.versionValidFrom)} desc`,
        sql`${legislationDocuments.id} desc`,
      )
      .limit(limit + 1);
  });

  if (versions === null) {
    return status(404, { message: "Legislation document not found" });
  }

  // One object-storage read per version, bounded rather than one request per
  // item: a page is already capped far below the version page size because
  // each item costs one whole AST.
  const texts = await mapWithConcurrency({
    items: versions,
    limit: LIMITS.legislationProvisionReadConcurrency,
    operation: async (version) =>
      extractProvisionText(
        await readVersionBlocks({
          row: version,
          legislationDb,
          step: HISTORY_READ_STEP,
        }),
        anchor,
      ),
  });

  const page = createCursorPage({
    rows: versions.map((version, index) => ({
      allowsDerivedAi: version.allowsDerivedAi,
      documentId: version.id,
      versionValidFrom: version.versionValidFrom,
      versionValidTo: version.versionValidTo,
      text: texts[index] ?? null,
    })),
    limit,
    cursorForItem: (item) =>
      encodePaginationCursor([
        item.versionValidFrom ?? UNVERSIONED_SORT_DATE,
        item.documentId,
      ]),
  });

  const items = page.items.flatMap(({ text, ...item }) =>
    text === null ? [] : [{ ...item, text }],
  );

  // No consolidation of the Work carried the anchor and there is nothing
  // older to look at, so the anchor addresses no provision of this Work.
  if (items.length === 0 && page.nextCursor === null) {
    return status(404, { message: "Provision not found" });
  }

  return { ...page, items };
};
