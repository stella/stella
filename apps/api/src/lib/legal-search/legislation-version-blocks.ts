import { panic, Result, TaggedError } from "better-result";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { PublicCountrySurface } from "@stll/api-contract/public-country-capability";
import { mapWithConcurrency } from "@stll/concurrency";
import type { Block, DocumentAst } from "@stll/legal-ast/document-ast";

import type { ScopedDb } from "@/api/db/safe-db";
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
  readCorpusForRecovery,
  readCorpusPayloadOrFallback,
} from "@/api/lib/legal-search/corpus-storage";
import type { EmptyAst } from "@/api/lib/legal-search/document-types";
import {
  canonicalLegislationAstSource,
  canonicalLegislationTextSource,
} from "@/api/lib/legal-search/legislation-canonical-source";
import {
  derivedAiLegislationVersion,
  redistributableLegislationVersionFor,
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
 * The columns `readVersionAst` reads, for a caller's own select. The `CASE`
 * is `canonicalLegislationAstSource` in SQL; the page-read test holds the two
 * to the same answer for every mode and key state.
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
 * rule as {@link versionAstColumnsFor}, as `canonicalLegislationTextSource`:
 * `fulltext` runs to megabytes for a large code, so only a row object storage
 * does not serve carries it.
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
  /** The surface this read serves; its country list decides publication. */
  surface: PublicCountrySurface;
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
  surface,
}: Pick<StoredVersionReadOptions, "id" | "purpose" | "surface">) =>
  and(
    eq(legislationDocuments.id, id),
    redistributableLegislationVersionFor(surface),
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
  surface: PublicCountrySurface;
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
  surface,
}: ReadVersionTextOptions): Promise<string | null> => {
  const source = canonicalLegislationTextSource(
    { textS3Key },
    corpusStorageMode,
  );
  switch (source.type) {
    case "database":
      return fulltext;
    case "object_storage":
      return await readCorpusPayloadOrFallback({
        documentId: id,
        key: source.key,
        step,
        read: async () => await readCorpusText(source.key),
        fallback: async () =>
          await readStoredVersionText({ legislationDb, id, surface }),
      });
    default: {
      source satisfies never;
      return panic("Unhandled legislation payload source");
    }
  }
};

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
  surface: PublicCountrySurface;
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
const readVersionAstPayload = async ({
  row,
  legislationDb,
  step,
  purpose = "reader",
  surface,
}: ReadVersionAstOptions): Promise<DocumentAst | EmptyAst | null> => {
  const source = canonicalLegislationAstSource(row, corpusStorageMode);
  switch (source.type) {
    case "database":
      return parsePersistedCorpusAst(row.documentAst);
    case "object_storage":
      return await readCorpusPayloadOrFallback({
        documentId: row.id,
        key: source.key,
        step,
        read: async () => await versionAstCache.read(source.key),
        fallback: async () =>
          parsePersistedCorpusAst(
            await readStoredVersionAst({
              legislationDb,
              id: row.id,
              purpose,
              surface,
            }),
          ),
      });
    default: {
      source satisfies never;
      return panic("Unhandled legislation payload source");
    }
  }
};

/** Invalid stored structure leaves the version's independent text readable. */
export const readVersionAst = async (options: ReadVersionAstOptions) =>
  (
    await readCorpusForRecovery({
      documentId: options.row.id,
      read: async () => await readVersionAstPayload(options),
    })
  ).unwrapOr(null);

/** One version's parsed blocks; see {@link readVersionAst}. */
export const readVersionBlocks = async (
  options: ReadVersionAstOptions,
): Promise<readonly Block[]> => {
  const ast = await readVersionAst(options);
  return ast !== null && "blocks" in ast ? ast.blocks : [];
};

// A comparison batch retains at most 512 MiB of decoded payloads; the AST
// cache's own heap budget cannot bound values retained by a caller.
const VERSION_CHANGE_BATCH_MAX_DECODED_BYTES = 512 * 1024 * 1024;
export const VERSION_CHANGE_COMPARISON_BATCH_MAX = 2;
const VERSION_CHANGE_PAYLOAD_BATCH_MAX =
  VERSION_CHANGE_COMPARISON_BATCH_MAX * 2;

class VersionChangePayloadTooLargeError extends TaggedError(
  "VersionChangePayloadTooLargeError",
)<{
  message: string;
  documentId: SafeId<"legislationDocument">;
}> {}
const VERSION_CHANGE_OBJECT_CONCURRENCY = 2;

export type VersionChangePayload =
  | { type: "blocks"; blocks: readonly Block[]; payloadRevision: bigint }
  | { type: "no-blocks"; payloadRevision: bigint }
  | { type: "unreadable"; payloadRevision: bigint };

type ReadVersionChangePayloadsOptions = {
  db: ScopedDb;
  ids: readonly SafeId<"legislationDocument">[];
  mode?: CorpusStorageMode;
  readObjectAst?: typeof versionAstCache.read;
};

/**
 * A bounded comparison batch reads each canonical payload once. Object reads
 * run after the SQL transaction closes. An unavailable object rejects the batch,
 * leaving its summaries stale for retry instead of recording empty comparisons.
 */
export const readVersionChangePayloads = async ({
  db,
  ids,
  mode = corpusStorageMode,
  readObjectAst = versionAstCache.read,
}: ReadVersionChangePayloadsOptions) => {
  if (
    VERSION_CHANGE_PAYLOAD_BATCH_MAX < 2 ||
    ids.length > VERSION_CHANGE_PAYLOAD_BATCH_MAX ||
    ids.length * LIMITS.corpusPayloadMaxDecompressedBytes >
      VERSION_CHANGE_BATCH_MAX_DECODED_BYTES
  ) {
    return panic("Version comparison payload batch exceeds its bound");
  }
  if (ids.length === 0) {
    return new Map<SafeId<"legislationDocument">, VersionChangePayload>();
  }
  const projection = versionAstColumnsFor(mode);
  const payloadBytes = sql`COALESCE(octet_length(${projection.documentAst}::text), 0)`;
  const rows = await db(
    async (tx) =>
      await tx
        .select({
          ...projection,
          documentAst: sql<unknown>`CASE WHEN ${payloadBytes} <= ${LIMITS.corpusPayloadMaxDecompressedBytes} THEN ${projection.documentAst} END`,
          oversized: sql<boolean>`${payloadBytes} > ${LIMITS.corpusPayloadMaxDecompressedBytes}`,
          payloadRevision: legislationDocuments.payloadRevision,
        })
        .from(legislationDocuments)
        .where(inArray(legislationDocuments.id, [...ids]))
        .limit(ids.length),
  );
  const payloads = await mapWithConcurrency({
    items: rows,
    limit: VERSION_CHANGE_OBJECT_CONCURRENCY,
    operation: async (
      row,
    ): Promise<
      readonly [SafeId<"legislationDocument">, VersionChangePayload]
    > => {
      if (row.oversized) {
        throw new VersionChangePayloadTooLargeError({
          message: "Version AST exceeds the corpus payload byte bound",
          documentId: row.id,
        });
      }
      const { payloadRevision } = row;
      const source = canonicalLegislationAstSource(row, mode);
      const ast = await (async () => {
        switch (source.type) {
          case "object_storage":
            return Result.ok(await readObjectAst(source.key));
          case "database":
            return Result.try(() => parsePersistedCorpusAst(row.documentAst));
          default:
            source satisfies never;
            return panic("Unhandled version comparison payload source");
        }
      })();
      if (ast.isErr()) {
        return [row.id, { type: "unreadable", payloadRevision }];
      }
      const blocks =
        ast.value !== null && "blocks" in ast.value ? ast.value.blocks : [];
      return [
        row.id,
        blocks.length === 0
          ? { type: "no-blocks", payloadRevision }
          : { type: "blocks", blocks, payloadRevision },
      ];
    },
  });
  return new Map(payloads);
};
