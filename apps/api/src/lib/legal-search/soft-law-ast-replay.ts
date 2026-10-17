import { Result, TaggedError } from "better-result";
import { and, eq, gt, sql } from "drizzle-orm";

import { sha256Hex } from "@stll/sha256/bun";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  softLawDocuments,
  softLawDocumentVersions,
  softLawDocumentLocators,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

import { RAW_SOURCE_FAMILY, rawSourcePrefix } from "./raw-source-family";
import { buildSoftLawAst, SOFT_LAW_AST_BUILDER_VERSION } from "./soft-law-ast";
import {
  SOFT_LAW_AUTHORITIES,
  SOFT_LAW_RAW_BYTE_LIMIT,
  SOFT_LAW_RAW_PART_LIMIT,
} from "./soft-law-types";
import type {
  SoftLawAuthority,
  SoftLawDocumentInput,
  SoftLawRawObject,
} from "./soft-law-types";

export class SoftLawAstReplayError extends TaggedError(
  "SoftLawAstReplayError",
)<{
  message: string;
  cause?: unknown;
}> {}

const REPLAY_BATCH_LIMIT = 20;

type ReadSoftLawRaw = (options: {
  key: string;
  maxBytes: number;
  signal: AbortSignal;
}) => Promise<Uint8Array | null>;

const readStoredRaw: ReadSoftLawRaw = async (options) => {
  const { readS3ObjectBoundedIfPresent } = await import("@/api/lib/s3");
  return await readS3ObjectBoundedIfPresent(options);
};

type LoadSoftLawAstRawOptions = {
  sourceId: SafeId<"softLawSource">;
  rawObjects: readonly SoftLawRawObject[];
  signal: AbortSignal;
  readRaw?: ReadSoftLawRaw;
};

/** Replay only content-addressed originals belonging to the selected source. */
export const loadSoftLawAstRaw = async ({
  sourceId,
  rawObjects,
  signal,
  readRaw = readStoredRaw,
}: LoadSoftLawAstRawOptions): Promise<
  Result<SoftLawDocumentInput["raw"], SoftLawAstReplayError>
> => {
  if (rawObjects.length === 0 || rawObjects.length > SOFT_LAW_RAW_PART_LIMIT) {
    return Result.err(
      new SoftLawAstReplayError({
        message: "Stored original parts are missing or exceed the replay limit",
      }),
    );
  }
  const raw: SoftLawDocumentInput["raw"][number][] = [];
  let remaining = SOFT_LAW_RAW_BYTE_LIMIT;
  const prefix = rawSourcePrefix({
    family: RAW_SOURCE_FAMILY.SOFT_LAW,
    sourceId,
  });
  for (const part of rawObjects) {
    signal.throwIfAborted();
    const digest = part.key.slice(prefix.length);
    if (!part.key.startsWith(prefix) || !/^[a-f0-9]{64}$/u.test(digest)) {
      return Result.err(
        new SoftLawAstReplayError({
          message: "Stored original does not belong to this source",
        }),
      );
    }
    // Retained parts share one byte budget; each read reduces the next ceiling.
    const maxBytes = remaining;
    const loaded = await Result.tryPromise(
      async () =>
        await readRaw({
          key: part.key,
          maxBytes,
          signal,
        }),
    );
    if (loaded.status === "error") {
      return Result.err(
        new SoftLawAstReplayError({
          message: "Could not load retained guidance originals",
          cause: loaded.error.cause,
        }),
      );
    }
    const bytes = loaded.value;
    if (
      bytes === null ||
      bytes.byteLength > remaining ||
      sha256Hex(bytes) !== digest
    ) {
      return Result.err(
        new SoftLawAstReplayError({
          message:
            "Stored original is missing, oversized, or has a different digest",
        }),
      );
    }
    remaining -= bytes.byteLength;
    raw.push({
      role: part.role,
      bytes,
      contentType: part.contentType,
      ...(part.purpose ? { purpose: part.purpose } : {}),
    });
  }
  return Result.ok(raw);
};

const isSoftLawAuthority = (authority: string): authority is SoftLawAuthority =>
  Object.hasOwn(SOFT_LAW_AUTHORITIES, authority);

type ReplaySoftLawAstBatchOptions = {
  scopedDb: ScopedDb;
  sourceId: SafeId<"softLawSource">;
  after: SafeId<"softLawDocumentVersion"> | null;
  signal: AbortSignal;
  readRaw?: ReadSoftLawRaw;
};

/** One bounded page; return the last completed id so a failed page can safely replay. */
export const replaySoftLawAstBatch = async ({
  scopedDb,
  sourceId,
  after,
  signal,
  readRaw,
}: ReplaySoftLawAstBatchOptions) => {
  const rows = await scopedDb(
    async (tx) =>
      await tx
        .select({
          version: softLawDocumentVersions,
          authority: softLawDocuments.authority,
          sourceUrl: sql<
            string | null
          >`(SELECT min(${softLawDocumentLocators.url}) FROM ${softLawDocumentLocators} WHERE ${softLawDocumentLocators.documentId} = ${softLawDocuments.id})`,
        })
        .from(softLawDocumentVersions)
        .innerJoin(
          softLawDocuments,
          eq(softLawDocumentVersions.documentId, softLawDocuments.id),
        )
        .where(
          and(
            eq(softLawDocuments.sourceId, sourceId),
            after === null ? undefined : gt(softLawDocumentVersions.id, after),
            sql`(${softLawDocumentVersions.astBuilderVersion} IS NULL OR ${softLawDocumentVersions.astBuilderVersion} < ${SOFT_LAW_AST_BUILDER_VERSION})`,
          ),
        )
        .orderBy(softLawDocumentVersions.id)
        .limit(REPLAY_BATCH_LIMIT),
  );
  let rebuilt = 0;
  for (const { version, authority, sourceUrl } of rows) {
    signal.throwIfAborted();
    if (!isSoftLawAuthority(authority) || sourceUrl === null) {
      return Result.err(
        new SoftLawAstReplayError({
          message: "Stored guidance authority or publisher locator is missing",
        }),
      );
    }
    const loaded = await loadSoftLawAstRaw({
      sourceId,
      rawObjects: version.rawObjects,
      signal,
      ...(readRaw ? { readRaw } : {}),
    });
    if (loaded.status === "error") {
      return loaded;
    }
    const common = {
      metadata: version.metadata,
      raw: loaded.value,
      sourceDates: version.sourceDates,
    };
    const input: SoftLawDocumentInput =
      version.extractionQuality === "extraction_failed"
        ? {
            ...common,
            extractionQuality: "extraction_failed",
            text: null,
            extractionFailure:
              version.extractionFailure ?? "Stored extraction failed",
          }
        : {
            ...common,
            extractionQuality: version.extractionQuality,
            text: version.extractedText,
          };
    const ast = await buildSoftLawAst({
      authority,
      documentId: version.documentId,
      sourceUrl: version.documentAst?.source.webUrl ?? sourceUrl,
      input,
    });
    // db-await-in-loop: Each replay uses a short compare-and-set transaction after its bounded raw reads and parsing; no external work holds a row lock.
    const updated = await scopedDb(
      async (tx) =>
        // audit: skip - rebuilds derived public-corpus text from immutable retained originals
        await tx
          .update(softLawDocumentVersions)
          .set({
            documentAst: ast.type === "readable" ? ast.documentAst : null,
            astBuilderVersion: ast.astBuilderVersion,
          })
          .where(
            and(
              eq(softLawDocumentVersions.id, version.id),
              eq(softLawDocumentVersions.contentHash, version.contentHash),
              sql`${softLawDocumentVersions.astBuilderVersion} IS NOT DISTINCT FROM ${version.astBuilderVersion}`,
            ),
          )
          .returning({ id: softLawDocumentVersions.id }),
    );
    rebuilt += updated.length;
  }
  return Result.ok({
    rebuilt,
    nextCursor:
      rows.length === REPLAY_BATCH_LIMIT
        ? (rows.at(-1)?.version.id ?? null)
        : null,
  });
};
