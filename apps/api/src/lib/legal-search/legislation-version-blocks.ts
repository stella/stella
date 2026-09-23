import { and, eq, sql } from "drizzle-orm";

import type { Block, DocumentAst } from "@stll/legal-ast/document-ast";

import { legislationDocuments } from "@/api/db/schema";
import { corpusStorageMode } from "@/api/env-base";
import type { SafeId } from "@/api/lib/branded-types";
import type { CorpusStorageMode } from "@/api/lib/corpus-storage-mode";
import { createCorpusAstCache } from "@/api/lib/legal-search/corpus-ast-cache";
import {
  readCorpusText,
  readSizedCorpusAst,
} from "@/api/lib/legal-search/corpus-reads";
import {
  parsePersistedCorpusAst,
  readCorpusPayloadOrFallback,
} from "@/api/lib/legal-search/corpus-storage";
import type { EmptyAst } from "@/api/lib/legal-search/document-types";
import {
  derivedAiLegislationVersion,
  redistributableLegislationVersion,
} from "@/api/lib/legal-search/legislation-redistribution";
import type { LegislationReadDb } from "@/api/lib/legislation-public-read-db";
import { LIMITS } from "@/api/lib/limits";

/** What a stored consolidation must carry for its blocks to be readable. */
export type LegislationVersionAstRow = {
  id: SafeId<"legislationDocument">;
  astS3Key: string | null;
  documentAst: unknown;
};

/**
 * Whether a version's payload (AST or text) comes from object storage rather
 * than from the Postgres copy. The projections and the readers below all
 * decide from this one predicate, so a row can never be projected without the
 * payload the reader then asks for.
 */
export const versionPayloadFromObjectStorage = (
  mode: CorpusStorageMode,
  storedKey: string | null,
): storedKey is string => mode !== "off" && storedKey !== null;

/**
 * The columns `readVersionAst` reads, for a caller's own select.
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
 * The columns `readVersionText` reads, for a caller's own select. The same
 * rule as {@link versionAstColumnsFor}: `fulltext` runs to megabytes for a
 * large code, so only a row object storage does not serve carries it.
 */
export const versionTextColumnsFor = (mode: CorpusStorageMode) => ({
  textS3Key: legislationDocuments.textS3Key,
  fulltext:
    mode === "off"
      ? sql<string | null>`${legislationDocuments.fulltext}`
      : sql<
          string | null
        >`CASE WHEN ${legislationDocuments.textS3Key} IS NULL THEN ${legislationDocuments.fulltext} END`,
});

export const versionTextColumns = versionTextColumnsFor(corpusStorageMode);

type StoredVersionReadOptions = {
  legislationDb: LegislationReadDb;
  id: SafeId<"legislationDocument">;
  purpose?: "reader" | "derived-ai";
};

/**
 * The gate a Postgres-copy read applies on its own. It runs in a second
 * transaction, after the object read has already failed, so it re-applies the
 * redistribution gate the first one passed rather than trusting it. A source
 * revoked between the two reads answers with no row, and the caller reports
 * the payload unavailable instead of serving text the publisher has withdrawn.
 */
const storedVersionGate = ({
  id,
  purpose = "reader",
}: Pick<StoredVersionReadOptions, "id" | "purpose">) =>
  and(
    eq(legislationDocuments.id, id),
    redistributableLegislationVersion,
    purpose === "derived-ai" ? derivedAiLegislationVersion : undefined,
  );

/** The Postgres copy of one version's AST: one row, one column. */
export const readStoredVersionAst = async ({
  legislationDb,
  ...gate
}: StoredVersionReadOptions): Promise<unknown> => {
  const [row] = await legislationDb(
    async (tx) =>
      await tx
        .select({ documentAst: legislationDocuments.documentAst })
        .from(legislationDocuments)
        .where(storedVersionGate(gate))
        .limit(1),
  );
  return row?.documentAst ?? null;
};

/** The Postgres copy of one version's text: one row, one column. */
const readStoredVersionText = async ({
  legislationDb,
  ...gate
}: StoredVersionReadOptions): Promise<string | null> => {
  const [row] = await legislationDb(
    async (tx) =>
      await tx
        .select({ fulltext: legislationDocuments.fulltext })
        .from(legislationDocuments)
        .where(storedVersionGate(gate))
        .limit(1),
  );
  return row?.fulltext ?? null;
};

type ReadVersionTextOptions = {
  row: {
    id: SafeId<"legislationDocument">;
    textS3Key: string | null;
    fulltext: string | null;
  };
  legislationDb: LegislationReadDb;
  /** Names the reading endpoint in a payload-unavailable capture. */
  step: string;
};

/**
 * One version's text, from object storage when the corpus keeps it there and
 * from the Postgres copy otherwise. Never call this inside a database
 * transaction.
 */
export const readVersionText = async ({
  row: { id, textS3Key, fulltext },
  legislationDb,
  step,
}: ReadVersionTextOptions): Promise<string | null> =>
  versionPayloadFromObjectStorage(corpusStorageMode, textS3Key)
    ? await readCorpusPayloadOrFallback({
        documentId: id,
        key: textS3Key,
        step,
        read: async () => await readCorpusText(textS3Key),
        fallback: async () =>
          await readStoredVersionText({ legislationDb, id }),
      })
    : fulltext;

/**
 * Consolidations a read has parsed, shared across requests. See
 * `createCorpusAstCache` for why a cached payload cannot outlive its row.
 */
const versionAstCache = createCorpusAstCache({
  maxHeapBytes: LIMITS.legislationAstCacheMaxHeapBytes,
  read: async (storedKey) => await readSizedCorpusAst(storedKey),
});

export type ReadVersionAstOptions = {
  row: LegislationVersionAstRow;
  legislationDb: LegislationReadDb;
  /** Names the reading endpoint in a payload-unavailable capture. */
  step: string;
  purpose?: "reader" | "derived-ai";
};

/**
 * One version's parsed AST, from object storage when the corpus keeps it
 * there and from the Postgres copy otherwise. An object-storage value is
 * shared with other requests and frozen.
 *
 * Corpus payloads are whole zstd objects, so a block range cannot be read on
 * its own: a caller that needs one reads the version once and slices the
 * result. Never call this inside a database transaction, because object
 * storage is a network hop that must not hold one open.
 */
export const readVersionAst = async ({
  row,
  legislationDb,
  step,
  purpose = "reader",
}: ReadVersionAstOptions): Promise<DocumentAst | EmptyAst | null> => {
  const { astS3Key } = row;

  return versionPayloadFromObjectStorage(corpusStorageMode, astS3Key)
    ? await readCorpusPayloadOrFallback({
        documentId: row.id,
        key: astS3Key,
        step,
        read: async () => await versionAstCache.read(astS3Key),
        fallback: async () =>
          parsePersistedCorpusAst(
            await readStoredVersionAst({ legislationDb, id: row.id, purpose }),
          ),
      })
    : parsePersistedCorpusAst(row.documentAst);
};

/** One version's parsed blocks; see {@link readVersionAst}. */
export const readVersionBlocks = async (
  options: ReadVersionAstOptions,
): Promise<readonly Block[]> => {
  const ast = await readVersionAst(options);
  return ast !== null && "blocks" in ast ? ast.blocks : [];
};
