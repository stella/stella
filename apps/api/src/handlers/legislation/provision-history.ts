import { and, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import type { Block } from "@stll/legal-ast/document-ast";

import { legislationDocuments } from "@/api/db/schema";
import { corpusStorageMode } from "@/api/env-base";
import { extractProvisionText } from "@/api/handlers/legislation/provision-text";
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
import {
  parsePersistedCorpusAst,
  readCorpusAst,
  readCorpusPayloadOrFallback,
} from "@/api/lib/legal-search/corpus-storage";
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

type VersionRow = {
  id: SafeId<"legislationDocument">;
  versionValidFrom: string | null;
  versionValidTo: string | null;
  astS3Key: string | null;
  documentAst: unknown;
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
  id: legislationDocuments.id,
  versionValidFrom: legislationDocuments.versionValidFrom,
  versionValidTo: legislationDocuments.versionValidTo,
  astS3Key: legislationDocuments.astS3Key,
  documentAst: legislationDocuments.documentAst,
};

/**
 * One version's parsed blocks, from object storage when the corpus keeps them
 * there and from the Postgres copy otherwise (the same order the document
 * read uses).
 */
const readVersionBlocks = async (
  row: VersionRow,
): Promise<readonly Block[]> => {
  const { astS3Key } = row;

  const ast =
    corpusStorageMode !== "off" && astS3Key !== null
      ? await readCorpusPayloadOrFallback({
          documentId: row.id,
          key: astS3Key,
          step: "provisionHistory.corpusAst",
          read: async () => await readCorpusAst(astS3Key),
          fallback: () => parsePersistedCorpusAst(row.documentAst),
        })
      : parsePersistedCorpusAst(row.documentAst);

  return ast !== null && "blocks" in ast ? ast.blocks : [];
};

/**
 * One provision's text across the consolidations of its Work, newest window
 * first, so a reader can diff a section without downloading whole statutes.
 *
 * The page walks versions, not occurrences: a version in which the anchor is
 * absent is dropped from `items` while still counting against the page, so
 * the cursor stays a plain keyset over the version order.
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

  const resolved = await legislationDb(async (tx) => {
    const work = await selectWorkKey(tx, documentId);

    if (work === null) {
      return null;
    }

    const [origin] = await tx
      .select(versionColumns)
      .from(legislationDocuments)
      .where(eq(legislationDocuments.id, documentId))
      .limit(1);

    const conditions: SQL[] = workKeyConditions(work);

    if (cursor !== null) {
      conditions.push(
        sql`(${versionSortKey(legislationDocuments.versionValidFrom)}, ${legislationDocuments.id}) < (${cursor.validFrom}::date, ${cursor.id}::uuid)`,
      );
    }

    const versions = await tx
      .select(versionColumns)
      .from(legislationDocuments)
      .where(and(...conditions))
      .orderBy(
        sql`${versionSortKey(legislationDocuments.versionValidFrom)} desc`,
        sql`${legislationDocuments.id} desc`,
      )
      .limit(limit + 1);

    return { origin, versions };
  });

  if (resolved?.origin === undefined) {
    return status(404, { message: "Legislation document not found" });
  }

  const { origin, versions } = resolved;
  const originText = extractProvisionText(
    await readVersionBlocks(origin),
    anchor,
  );

  if (originText === null) {
    return status(404, { message: "Provision not found" });
  }

  const texts = await Promise.all(
    versions.map(async (version) =>
      version.id === origin.id
        ? originText
        : extractProvisionText(await readVersionBlocks(version), anchor),
    ),
  );

  const page = createCursorPage({
    rows: versions.map((version, index) => ({
      documentId: version.id,
      versionValidFrom: version.versionValidFrom,
      versionValidTo: version.versionValidTo,
      text: texts.at(index) ?? null,
    })),
    limit,
    cursorForItem: (item) =>
      encodePaginationCursor([
        item.versionValidFrom ?? UNVERSIONED_SORT_DATE,
        item.documentId,
      ]),
  });

  return {
    ...page,
    items: page.items.flatMap(({ text, ...item }) =>
      text === null ? [] : [{ ...item, text }],
    ),
  };
};
