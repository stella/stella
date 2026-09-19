import { and, eq, sql } from "drizzle-orm";

import type { Block } from "@stll/legal-ast/document-ast";

import { legislationDocuments } from "@/api/db/schema";
import { corpusStorageMode } from "@/api/env-base";
import type { SafeId } from "@/api/lib/branded-types";
import type { CorpusStorageMode } from "@/api/lib/corpus-storage-mode";
import { readCorpusAst } from "@/api/lib/legal-search/corpus-reads";
import {
  parsePersistedCorpusAst,
  readCorpusPayloadOrFallback,
} from "@/api/lib/legal-search/corpus-storage";
import {
  derivedAiLegislationVersion,
  redistributableLegislationVersion,
} from "@/api/lib/legal-search/legislation-redistribution";
import type { LegislationReadDb } from "@/api/lib/legislation-public-read-db";

/** What a stored consolidation must carry for its blocks to be readable. */
export type LegislationVersionAstRow = {
  id: SafeId<"legislationDocument">;
  astS3Key: string | null;
  documentAst: unknown;
};

/**
 * Whether a version's blocks come from object storage rather than from the
 * Postgres copy. The projection and the reader below both decide from this one
 * predicate, so a row can never be projected without the payload the reader
 * then asks for.
 */
export const versionAstFromObjectStorage = (
  mode: CorpusStorageMode,
  astS3Key: string | null,
): astS3Key is string => mode !== "off" && astS3Key !== null;

/**
 * The columns `readVersionBlocks` reads, for a caller's own select.
 *
 * `document_ast` holds a whole consolidated statute, so it is projected only
 * for the rows that will be parsed out of it. For a row object storage serves,
 * the `CASE` never evaluates the column, so Postgres neither detoasts the
 * JSONB nor puts it on the wire.
 */
export const versionAstColumnsFor = (mode: CorpusStorageMode) => ({
  id: legislationDocuments.id,
  astS3Key: legislationDocuments.astS3Key,
  documentAst:
    mode === "off"
      ? sql<unknown>`${legislationDocuments.documentAst}`
      : sql<unknown>`CASE WHEN ${legislationDocuments.astS3Key} IS NULL THEN ${legislationDocuments.documentAst} END`,
});

export const versionAstColumns = versionAstColumnsFor(corpusStorageMode);

/**
 * The Postgres copy of one version's AST, on its own: one row, one column, and
 * only after the object read has already failed.
 *
 * This is a second transaction, so it re-applies the redistribution gate the
 * first one passed rather than trusting it. A source revoked between the two
 * reads answers with no row here, and the caller reports the payload
 * unavailable instead of serving text the publisher has withdrawn.
 */
type ReadStoredVersionAstOptions = {
  legislationDb: LegislationReadDb;
  id: SafeId<"legislationDocument">;
  purpose?: "reader" | "derived-ai";
};

export const readStoredVersionAst = async ({
  legislationDb,
  id,
  purpose = "reader",
}: ReadStoredVersionAstOptions): Promise<unknown> => {
  const [row] = await legislationDb(
    async (tx) =>
      await tx
        .select({ documentAst: legislationDocuments.documentAst })
        .from(legislationDocuments)
        .where(
          and(
            eq(legislationDocuments.id, id),
            redistributableLegislationVersion,
            purpose === "derived-ai" ? derivedAiLegislationVersion : undefined,
          ),
        )
        .limit(1),
  );
  return row?.documentAst ?? null;
};

export type ReadVersionBlocksOptions = {
  row: LegislationVersionAstRow;
  legislationDb: LegislationReadDb;
  /** Names the reading endpoint in a payload-unavailable capture. */
  step: string;
  purpose?: "reader" | "derived-ai";
};

/**
 * One version's parsed blocks, from object storage when the corpus keeps them
 * there and from the Postgres copy otherwise (the same order the document
 * read uses).
 *
 * Corpus payloads are whole zstd objects, so a block range cannot be read on
 * its own: a caller that needs one reads the version once and slices the
 * result. Never call this inside a database transaction, because object
 * storage is a network hop that must not hold one open.
 */
export const readVersionBlocks = async ({
  row,
  legislationDb,
  step,
  purpose = "reader",
}: ReadVersionBlocksOptions): Promise<readonly Block[]> => {
  const { astS3Key } = row;

  const ast = versionAstFromObjectStorage(corpusStorageMode, astS3Key)
    ? await readCorpusPayloadOrFallback({
        documentId: row.id,
        key: astS3Key,
        step,
        read: async () => await readCorpusAst(astS3Key),
        fallback: async () =>
          parsePersistedCorpusAst(
            await readStoredVersionAst({ legislationDb, id: row.id, purpose }),
          ),
      })
    : parsePersistedCorpusAst(row.documentAst);

  return ast !== null && "blocks" in ast ? ast.blocks : [];
};
