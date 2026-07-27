import { Result, panic } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import { collapseSpacedLetters } from "@stll/text-normalize";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawCitations,
  caseLawDecisions,
  caseLawIngestionFailures,
  type caseLawSources,
} from "@/api/db/schema";
import { corpusStorageMode } from "@/api/env-base";
import {
  ADAPTER_TIMEOUT,
  MAX_SYNC_PAGES,
} from "@/api/handlers/case-law/consts";
import type { WriteCorpusResult } from "@/api/handlers/case-law/corpus-storage";
import {
  corpusContentHash,
  corpusKeys,
  deleteCorpusDocument,
  writeCorpusDocument,
} from "@/api/handlers/case-law/corpus-storage";
import {
  caseLawDecisionSlugCollisionFilter,
  createAvailableCaseLawDecisionSlug,
  createCaseLawDecisionSlug,
} from "@/api/handlers/case-law/decisions/slug";
import {
  hasUsableAst,
  isDocumentAst,
} from "@/api/handlers/case-law/document-ast";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import { EMPTY_AST } from "@/api/handlers/case-law/ingestion/adapter";
import { getAdapter } from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import {
  extractCitations,
  isSelfCitation,
} from "@/api/handlers/case-law/ingestion/citation-extractor";
import { storedDecisionSignal } from "@/api/handlers/case-law/ingestion/parsers/validate-ast";
import { shouldSkipRefresh } from "@/api/handlers/case-law/ingestion/refresh-policy";
import {
  DANGEROUS_CHARS,
  sanitizeMetadata,
  stripDangerousChars,
} from "@/api/handlers/case-law/ingestion/sanitize";
import { segmentDecision } from "@/api/handlers/case-law/ingestion/segmenter";
import type { DecisionSection } from "@/api/handlers/case-law/types";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import {
  advanceCorpusIngestionCheckpoint,
  CORPUS_SOURCE_TYPE,
  INGESTION_CHECKPOINT_STATUS,
} from "@/api/lib/corpus-ingestion-checkpoint";
import type { CorpusStorageMode } from "@/api/lib/corpus-storage-mode";
import { TimeoutError } from "@/api/lib/errors/tagged-errors";
import { errorTag } from "@/api/lib/errors/utils";
import { LIMITS } from "@/api/lib/limits";
import { logger } from "@/api/lib/observability/logger";
import { getS3 } from "@/api/lib/s3";
import { isRecord } from "@/api/lib/type-guards";

type DbSlot = {
  acquire: (signal?: AbortSignal) => Promise<void>;
  release: () => void;
};

type PipelineInput = {
  source: typeof caseLawSources.$inferSelect;
  scopedDb: ScopedDb;
  /** Per-cycle abort signal. Fires when the adapter's time budget is exhausted. */
  signal?: AbortSignal;
  /**
   * Hard caps for bounded sample runs (staging smoke): stop after this
   * many pages / newly stored decisions without advancing the cursor
   * past unprocessed work. Dedup-skipped and failed decisions do not
   * count toward the cap, so a re-run with the same cap continues past
   * already-ingested work. Defaults to the adapter's own cycle limits.
   */
  maxPages?: number;
  maxDecisions?: number;
  /**
   * Optional concurrency limiter for DB-heavy operations.
   * When provided, the pipeline acquires a slot before
   * processing decisions (insert, index, citations) and
   * releases it before the next page fetch. This lets
   * external API fetches run in parallel across adapters
   * while capping concurrent DB pressure.
   */
  dbSlot?: DbSlot;
};

type PipelineResult = {
  inserted: number;
  skipped: number;
  searchVectorFailures: number;
  s3UploadFailures: number;
  pagesProcessed: number;
  nextCursor: string | null;
  /** Non-null if the adapter was halted early due to repeated failures. */
  haltReason: string | null;
};

const databaseTimeoutHaltReason = (error: TimeoutError): string =>
  `Database timeout; cursor held for retry: ${error.message.slice(0, 200)}`;

/**
 * Bound the outer message and the cause separately: a wrapped driver
 * error carries the full failed query in its outer message, which would
 * otherwise consume the whole budget and truncate the cause — the part
 * that says why the write failed.
 */
export const corpusWriteErrorDetail = (error: unknown): string => {
  if (!(error instanceof Error)) {
    return String(error).slice(0, 512);
  }
  const outer = error.message.slice(0, 200);
  return error.cause instanceof Error
    ? `${outer} (cause: ${error.cause.message.slice(0, 300)})`
    : outer;
};

type ProcessResult = {
  inserted: boolean;
  searchVectorFailed: boolean;
  s3UploadFailed: boolean;
};

/**
 * Sanitize text fields before DB insertion.
 * Postgres rejects null bytes (\x00) in text columns.
 * Applied once in the pipeline so individual adapters
 * don't need to handle this.
 */
/**
 * Regex matching characters that must be stripped from all
 * ingested text before DB insertion:
 *
 * - \x00        Null byte — Postgres rejects in text/jsonb
 * - \uFEFF      BOM (byte order mark) — invisible, breaks equality
 * - \uFFFE      Reversed BOM — same concern
 * - [\u0000-\u0008\u000B\u000C\u000E-\u001F]
 *               C0 control chars except HT (\t), LF (\n), CR (\r)
 *               which are valid whitespace. These can appear in
 *               OCR'd PDFs or broken encodings.
 * - \u200B      Zero-width space — invisible, breaks search
 * - \u200C      Zero-width non-joiner
 * - \u200D      Zero-width joiner
 * - \u2060      Word joiner
 * - \uFFF9-\uFFFB  Interlinear annotation anchors
 *
 * Applied once in the pipeline so adapters don't repeat this.
 */
// Spaced-letter collapse (letter-spaced court headings such as
// "r o z h o d o l :" -> "rozhodol:") is single-homed in
// @stll/text-normalize's collapseSpacedLetters, so index-time collapse
// here and the case-viewer's query-time collapse share one threshold.

export const sanitizeResult = (r: IngestionResult): IngestionResult => {
  // Strip dangerous chars and normalize non-breaking spaces.
  // \u00A0 (nbsp) comes from PDF text extraction (@libpdf/core)
  // and prevents the browser from wrapping at word boundaries.
  const strip = (s: string | undefined): string | undefined =>
    s ? stripDangerousChars(s) : undefined;

  // Strip header fragments that the Cheerio extractor sometimes
  // captures alongside the actual decision type value.
  const DECISION_TYPE_NOISE =
    /česk[áa]\s+republik[ay]|jm[ée]nem\s+republik[ay]/giu;

  const normalizeDecisionType = (
    raw: string | undefined,
  ): string | undefined => {
    if (!raw) {
      return undefined;
    }
    return (
      raw.replace(DECISION_TYPE_NOISE, "").trim().toLowerCase() || undefined
    );
  };

  // Recursively sanitize all strings in documentAst.
  // JSON.stringify escapes control chars to \uXXXX sequences
  // that the regex wouldn't match, so we walk the tree.
  const deepSanitizeImpl = (val: unknown, key?: string): unknown => {
    if (typeof val === "string") {
      const stripped = val
        .replace(DANGEROUS_CHARS, "")
        .replace(/\u00A0/gu, " ");
      // Collapse spaced-out letters in plainText only (used for
      // the DB full-text search index). Inline text is left
      // verbatim so the reader displays exactly what the court
      // wrote — letter-spacing and all. The frontend normalizer
      // performs the same collapse at query time with a position
      // map, keeping highlight offsets aligned.
      return key === "plainText" ? collapseSpacedLetters(stripped) : stripped;
    }
    if (Array.isArray(val)) {
      return val.map((item) => deepSanitizeImpl(item));
    }
    if (isRecord(val)) {
      // oxlint-disable-next-line no-untyped-updates/no-untyped-updates -- sanitizer accumulator
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val)) {
        out[k] = deepSanitizeImpl(v, k);
      }
      return out;
    }
    return val;
  };

  const sanitizeDocumentAst = (
    documentAst: IngestionResult["documentAst"],
  ): IngestionResult["documentAst"] => {
    const sanitized = deepSanitizeImpl(documentAst);
    return isDocumentAst(sanitized) ? sanitized : EMPTY_AST;
  };

  const sanitizedAst = sanitizeDocumentAst(r.documentAst);

  return {
    ...r,
    caseNumber: r.caseNumber.replace(DANGEROUS_CHARS, ""),
    fulltext: r.fulltext
      ? collapseSpacedLetters(strip(r.fulltext) ?? "")
      : undefined,
    ecli: strip(r.ecli),
    decisionType: normalizeDecisionType(strip(r.decisionType)),
    sourceUrl: strip(r.sourceUrl),
    documentUrl: strip(r.documentUrl),
    metadata: sanitizeMetadata(r.metadata),
    // Adapter-supplied sections come from court HTML like every other
    // field and must go through the same strip. The fallback path was
    // safe only incidentally: `segmentDecision` runs on the already
    // sanitized `fulltext`.
    sections: r.sections?.map((section) => ({
      ...section,
      title: section.title === null ? null : stripDangerousChars(section.title),
      text: collapseSpacedLetters(strip(section.text) ?? ""),
    })),
    documentAst: sanitizedAst,
    sourceRaw: strip(r.sourceRaw),
  };
};

/**
 * Upload sourceRaw to S3 under a content-addressable key.
 * Returns the S3 object key.
 */
const uploadSourceRaw = async (
  sourceId: SafeId<"caseLawSource">,
  data: Uint8Array | string,
  contentType: string,
): Promise<string> => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(data);
  const blobHash = hasher.digest("hex");
  const key = `case-law/raw/${sourceId}/${blobHash}`;
  await getS3().write(key, data, { type: contentType });
  return key;
};

type PreserveCorpusWriteRetryInput = {
  decisionId: SafeId<"caseLawDecision">;
  previousSourceHash: string | null;
  /** The sourceHash this run persisted; the reset only applies while the row still carries it. */
  expectedSourceHash: string | null;
  scopedDb: ScopedDb;
};

const preserveCorpusWriteRetry = async ({
  decisionId,
  previousSourceHash,
  expectedSourceHash,
  scopedDb,
}: PreserveCorpusWriteRetryInput): Promise<void> => {
  // If the corpus write fails after the DB text update, do not leave the
  // source hash at the incoming value. A matching source hash would make the
  // next ingestion pass skip this decision before it can retry object storage.
  // Clear corpus keys too so reads fall back to the fresh Postgres columns
  // instead of serving an older object payload.
  // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive
  await scopedDb((tx) => {
    // audit: skip — background corpus storage retry bookkeeping; derived state
    return (
      tx
        .update(caseLawDecisions)
        .set({
          sourceHash: previousSourceHash,
          textS3Key: null,
          normalizedS3Key: null,
          astS3Key: null,
          contentHash: null,
          indexedHash: null,
          indexedGeneration: null,
          indexedAt: null,
        })
        // Only undo this run's own write: a concurrent newer refresh owns
        // the row once it has advanced sourceHash.
        .where(
          and(
            eq(caseLawDecisions.id, decisionId),
            sql`${caseLawDecisions.sourceHash} IS NOT DISTINCT FROM ${expectedSourceHash}`,
          ),
        )
    );
  });
};

/**
 * Where this decision's canonical payload ends up.
 *
 * - `postgres-only` the row carries text/sections/AST and nothing mirrors
 *   it, so any corpus pointers left over from an earlier mode are stale.
 * - `postgres-mirrored` the row carries the payload and the post-commit
 *   write refreshes the corpus pointers under a compare-and-set.
 * - `object-storage` the payload is already in the corpus bucket, so the
 *   row stores the keys and leaves the columns NULL.
 * - `write-failed` the canonical write did not land, so no row may be
 *   written: the stale source hash is what makes the next cycle retry.
 */
type CorpusWritePlan =
  | { type: "postgres-only" }
  | { type: "postgres-mirrored" }
  | { type: "object-storage"; written: WriteCorpusResult }
  | { type: "write-failed" };

type CorpusWritePayload = {
  documentId: SafeId<"caseLawDecision">;
  jurisdiction: string;
  text: string | null;
  sections: DecisionSection[] | null;
  ast: IngestionResult["documentAst"];
};

type PlanCorpusWriteInput = CorpusWritePayload & {
  mode: CorpusStorageMode;
  /** Whether a row for this decision already existed before this run. */
  hadExistingRow: boolean;
};

/**
 * `writeCorpusDocument` issues its three PUTs in parallel, so a rejection
 * can still leave one or two objects behind. For a decision that had no
 * row, the retry mints a different id and keys its objects under that,
 * stranding these for good. Delete them best-effort; the keys are
 * content-addressed, so they are derivable from the payload without the
 * write having returned.
 *
 * New decisions only, for the same reason `canDiscardCorpusObjects` scopes
 * the post-transaction compensation: a refresh derives these keys from the
 * existing id and the payload hash, so whenever the text, sections, and AST
 * are unchanged (only metadata or the raw source moved) they are the very
 * objects the live row already references — and under canonical storage
 * that row's payload columns are NULL, so deleting them empties the
 * decision. An orphaned object is harmless; that is not.
 */
const discardPartialCorpusWrite = async (
  payload: CorpusWritePayload,
): Promise<void> => {
  const keys = corpusKeys({
    documentId: payload.documentId,
    jurisdiction: payload.jurisdiction,
    contentHash: corpusContentHash(payload),
  });
  const discarded = await Result.tryPromise(
    async () =>
      await deleteCorpusDocument({
        textKey: keys.textKey,
        sectionsKey: keys.sectionsKey,
        astKey: keys.astKey,
      }),
  );
  if (Result.isError(discarded)) {
    captureError(discarded.error, {
      decisionId: payload.documentId,
      step: "processDecision.canonicalCorpusWriteCleanup",
    });
  }
};

const planCorpusWrite = async ({
  mode,
  hadExistingRow,
  ...payload
}: PlanCorpusWriteInput): Promise<CorpusWritePlan> => {
  switch (mode) {
    case "off":
      return { type: "postgres-only" };
    case "dual-write":
      return { type: "postgres-mirrored" };
    case "canonical": {
      // Object storage first. It keeps the S3 round-trip out of the
      // transaction (the same reason `dual-write` writes after commit)
      // while guaranteeing no row can point at an object that is missing.
      const written = await Result.tryPromise(
        async () => await writeCorpusDocument(payload),
      );
      if (Result.isError(written)) {
        captureError(written.error, {
          decisionId: payload.documentId,
          step: "processDecision.canonicalCorpusWrite",
        });
        if (!hadExistingRow) {
          await discardPartialCorpusWrite(payload);
        }
        return { type: "write-failed" };
      }
      return { type: "object-storage", written: written.value };
    }
    default: {
      const unhandled: never = mode;
      return panic(`Unhandled corpus storage mode: ${String(unhandled)}`);
    }
  }
};

type CanDiscardCorpusObjectsInput = {
  /** Whether a row for this decision already existed before this run. */
  hadExistingRow: boolean;
  /** What the row write failed with. */
  error: unknown;
};

/**
 * Whether the objects a canonical write just placed in the bucket may be
 * deleted now that the row write has failed. Two things have to hold.
 *
 * The decision must have had no row yet. On a refresh the keys derive from
 * the existing id and the payload hash, so the stored row may already point
 * at these exact objects (a re-parse that reproduces the payload rewrites
 * identical bytes) and deleting them would empty a live decision.
 *
 * And the failure must be unambiguous. The transaction's wall-clock bound
 * abandons the statement instead of cancelling it, so a TimeoutError does
 * not prove the write did not land: it may still commit after the timer
 * fires. An orphaned object is harmless — content-addressed, unreachable,
 * and reclaimed by a later sweep — while a committed row pointing at
 * deleted payloads is not recoverable.
 */
const canDiscardCorpusObjects = ({
  hadExistingRow,
  error,
}: CanDiscardCorpusObjectsInput): boolean =>
  !hadExistingRow && !(error instanceof TimeoutError);

/**
 * A canonical write puts the objects in the bucket before the row exists, so
 * a failed row write can leave them unreferenced: the retry mints a new
 * decision id and keys its objects under that instead. Delete them
 * best-effort; a failure here is telemetry only, because the caller still
 * has to surface the original row-write error.
 */
const discardOrphanedCorpusObjects = async (
  written: WriteCorpusResult,
  decisionId: SafeId<"caseLawDecision">,
): Promise<void> => {
  const discarded = await Result.tryPromise(
    async () =>
      await deleteCorpusDocument({
        textKey: written.textKey,
        sectionsKey: written.sectionsKey,
        astKey: written.astKey,
      }),
  );
  if (Result.isError(discarded)) {
    captureError(discarded.error, {
      decisionId,
      step: "processDecision.canonicalCorpusCleanup",
    });
  }
};

/**
 * Insert a single decision and its citations into the database.
 * Skips duplicates based on sourceHash.
 */
export const processDecision = async (
  input: IngestionResult,
  sourceId: SafeId<"caseLawSource">,
  scopedDb: ScopedDb,
): Promise<ProcessResult> => {
  const result = sanitizeResult(input);

  const existing = await scopedDb((tx) =>
    tx.query.caseLawDecisions.findFirst({
      where: {
        sourceId: { eq: sourceId },
        caseNumber: result.caseNumber,
        language: result.language,
      },
      columns: {
        id: true,
        metadata: true,
        sourceHash: true,
        sourceRawS3Key: true,
        sourceRawContentType: true,
      },
    }),
  );

  if (
    existing &&
    shouldSkipRefresh({
      existingMetadata: existing.metadata,
      existingSourceHash: existing.sourceHash,
      incomingMetadata: result.metadata,
      incomingRawHash: result.rawHash,
    })
  ) {
    return {
      inserted: false,
      searchVectorFailed: false,
      s3UploadFailed: false,
    };
  }

  // Upload sourceRaw to S3 — best-effort; failure must not
  // prevent the decision from being inserted.
  const rawPayload = result.sourceRawBytes ?? result.sourceRaw;
  const rawContentType = result.sourceRawContentType ?? "text/plain";

  let sourceRawS3Key: string | null = null;
  let sourceRawContentType: string | null = null;
  let s3UploadFailed = false;
  if (rawPayload !== undefined) {
    try {
      sourceRawS3Key = await uploadSourceRaw(
        sourceId,
        rawPayload,
        rawContentType,
      );
      sourceRawContentType = rawContentType;
    } catch (error) {
      if (!existing) {
        // New decision: re-throw so the pipeline skips this decision
        // and retries next cycle. Inserting with sourceRawS3Key: null
        // would set sourceHash, causing the dedup check to skip it
        // permanently — the raw source would be lost forever.
        // Skip captureError here; the outer catch in
        // runIngestionPipeline will capture it once.
        throw error;
      }

      captureError(error, { sourceId, step: "uploadSourceRaw" });

      // Update: preserve existing S3 key and DO NOT advance sourceHash.
      // If we wrote the new hash with the old key, the hash mismatch
      // would never trigger again and the stale raw source could never
      // be corrected through normal ingestion.
      sourceRawS3Key = existing.sourceRawS3Key;
      sourceRawContentType = existing.sourceRawContentType;
      s3UploadFailed = true;
    }
  }

  // Structure-derived sections win: an adapter only supplies them when
  // its parser recovered the document's own headings, which is strictly
  // better than re-deriving boundaries from the flattened text.
  const sections =
    result.sections ??
    (result.fulltext ? segmentDecision(result.fulltext) : []);

  // Parsers report their own quality through `validateAndLog`, but a
  // source whose parser never runs reports nothing at all. Emit the
  // same signal here so every stored decision is accounted for, and
  // split the severity the same way: no text is an error, text without
  // structure is a warning.
  const astBlocks = hasUsableAst(result.documentAst)
    ? result.documentAst.blocks.length
    : 0;
  const signal = storedDecisionSignal({
    hasFulltext: Boolean(result.fulltext),
    astBlocks,
  });
  if (signal) {
    const subject = {
      sourceId,
      caseNumber: result.caseNumber,
      language: result.language,
      url: result.sourceUrl ?? result.documentUrl ?? "",
      fulltextLength: result.fulltext?.length ?? 0,
    };
    if (signal.level === "error") {
      logger.error(signal.event, subject);
    } else {
      logger.warn(signal.event, subject);
    }
  }

  const citations = extractCitations(
    sections.map((s) => ({ index: s.index, text: s.text })),
  ).filter(
    (c) =>
      !isSelfCitation(c.citationText, {
        caseNumber: result.caseNumber,
        ecli: result.ecli ?? null,
      }),
  );

  const languageGroupKey = result.ecli || `${sourceId}:${result.caseNumber}`;

  // Corpus objects are keyed on the decision id, so a canonical write needs
  // that id before the row exists. Minting it here is what the column
  // default (`pUuid`) would do at insert time anyway.
  const decisionId = existing?.id ?? createSafeId<"caseLawDecision">();

  const corpusPlan = await planCorpusWrite({
    mode: corpusStorageMode,
    hadExistingRow: Boolean(existing),
    documentId: decisionId,
    jurisdiction: result.country,
    text: result.fulltext ?? null,
    sections: sections.length > 0 ? sections : null,
    ast: result.documentAst,
  });

  if (corpusPlan.type === "write-failed") {
    // Persist nothing: a row would advance sourceHash and the next cycle
    // would dedup-skip the decision before it could retry the write. The
    // caller counts this as an S3 failure, which holds the page cursor.
    return { inserted: false, searchVectorFailed: false, s3UploadFailed: true };
  }

  const postgresPayload = {
    fulltext: result.fulltext,
    sections: sections.length > 0 ? sections : null,
    documentAst: result.documentAst,
  };

  const payloadColumns = (() => {
    switch (corpusPlan.type) {
      case "postgres-only":
        // This refresh supersedes whatever the corpus holds and nothing
        // will follow to rewrite the pointers, so a row carrying keys from
        // an earlier canonical/dual-write period would point at objects
        // that no longer match its columns. Clear them.
        return {
          ...postgresPayload,
          textS3Key: null,
          normalizedS3Key: null,
          astS3Key: null,
          contentHash: null,
        };
      case "postgres-mirrored":
        // The post-commit write refreshes the pointers under a CAS.
        return postgresPayload;
      case "object-storage":
        return {
          fulltext: null,
          sections: null,
          documentAst: null,
          textS3Key: corpusPlan.written.textKey,
          normalizedS3Key: corpusPlan.written.sectionsKey,
          astS3Key: corpusPlan.written.astKey,
          contentHash: corpusPlan.written.contentHash,
        };
      default: {
        const unhandled: never = corpusPlan;
        return panic(`Unhandled corpus write plan: ${String(unhandled)}`);
      }
    }
  })();

  const writeDecisionRow = async (): Promise<void> => {
    await scopedDb(async (tx) => {
      // audit: skip — background case-law ingestion pipeline; public case-law data, not user actions
      if (existing) {
        await tx
          .update(caseLawDecisions)
          .set({
            ecli: result.ecli,
            court: result.court,
            country: result.country,
            language: result.language,
            languageGroupKey,
            decisionDate: result.decisionDate,
            decisionType: result.decisionType,
            ...payloadColumns,
            sourceUrl: result.sourceUrl,
            documentUrl: result.documentUrl,
            metadata: result.metadata,
            sourceRaw: null,
            sourceRawS3Key,
            sourceRawContentType,
            parserVersion: result.parserVersion ?? 0,
            // When S3 upload failed, keep the old sourceHash so the
            // next ingestion cycle sees a hash mismatch and retries
            // the upload instead of permanently skipping the decision.
            sourceHash: s3UploadFailed ? existing.sourceHash : result.rawHash,
            // Clear indexedHash so the corpus indexer re-picks this row even
            // when only metadata changed (its staleness check compares
            // indexedHash to contentHash, which only tracks the payload).
            indexedHash: null,
            updatedAt: new Date(),
          })
          .where(eq(caseLawDecisions.id, existing.id));

        await tx
          .delete(caseLawCitations)
          .where(eq(caseLawCitations.citingDecisionId, existing.id));

        if (citations.length > 0) {
          await tx.insert(caseLawCitations).values(
            citations.map((c) => ({
              citingDecisionId: existing.id,
              citationText: c.citationText,
              sectionIndex: c.sectionIndex,
            })),
          );
        }

        return;
      }

      const baseSlug = createCaseLawDecisionSlug(result.caseNumber);
      const existingSlugRows = await tx
        .select({ slug: caseLawDecisions.slug })
        .from(caseLawDecisions)
        .where(
          caseLawDecisionSlugCollisionFilter({
            baseSlug,
            maxSuffix: LIMITS.caseLawSlugCollisionScanLimit + 1,
          }),
        )
        .limit(LIMITS.caseLawSlugCollisionScanLimit);
      const slug = createAvailableCaseLawDecisionSlug(
        baseSlug,
        existingSlugRows.map((row) => row.slug),
      );

      const [decisionRow] = await tx
        .insert(caseLawDecisions)
        .values({
          id: decisionId,
          sourceId,
          caseNumber: result.caseNumber,
          slug,
          ecli: result.ecli,
          court: result.court,
          country: result.country,
          language: result.language,
          languageGroupKey,
          decisionDate: result.decisionDate,
          decisionType: result.decisionType,
          ...payloadColumns,
          sourceUrl: result.sourceUrl,
          documentUrl: result.documentUrl,
          metadata: result.metadata,
          parserVersion: result.parserVersion ?? 0,
          sourceRaw: null,
          sourceRawS3Key,
          sourceRawContentType,
          sourceHash: result.rawHash,
        })
        .returning({ id: caseLawDecisions.id });

      if (!decisionRow) {
        panic("Failed to insert decision: no row returned");
      }

      if (citations.length > 0) {
        await tx.insert(caseLawCitations).values(
          citations.map((c) => ({
            citingDecisionId: decisionRow.id,
            citationText: c.citationText,
            sectionIndex: c.sectionIndex,
          })),
        );
      }
    });
  };

  // Pass the original error through: the pipeline's halt semantics inspect
  // its type (a TimeoutError holds the cursor), which a wrapper would hide.
  const rowWrite = await Result.tryPromise({
    try: writeDecisionRow,
    catch: (cause: unknown) => cause,
  });

  if (Result.isError(rowWrite)) {
    if (
      corpusPlan.type === "object-storage" &&
      canDiscardCorpusObjects({
        hadExistingRow: Boolean(existing),
        error: rowWrite.error,
      })
    ) {
      await discardOrphanedCorpusObjects(corpusPlan.written, decisionId);
    }
    throw rowWrite.error;
  }

  // Mirror text/sections/AST to object storage, then record the keys +
  // content hash. Done outside the DB transaction (S3 I/O must not hold a
  // transaction open). A failure leaves the row fully readable from its
  // Postgres columns and preserves the source-hash mismatch so normal
  // ingestion can retry the corpus write. `canonical` has already written
  // its objects above, before the row.
  if (corpusStorageMode === "dual-write") {
    // The sourceHash this call just persisted: corpus-key and retry
    // updates below only apply while the row still carries it, so a
    // slower run cannot overwrite a concurrent newer refresh.
    const persistedSourceHash = s3UploadFailed
      ? (existing?.sourceHash ?? null)
      : result.rawHash;
    try {
      const written = await writeCorpusDocument({
        documentId: decisionId,
        jurisdiction: result.country,
        text: result.fulltext ?? null,
        sections: sections.length > 0 ? sections : null,
        ast: result.documentAst,
      });
      // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive
      await scopedDb((tx) => {
        // audit: skip — background corpus storage; derived state, not user actions
        return tx
          .update(caseLawDecisions)
          .set({
            textS3Key: written.textKey,
            normalizedS3Key: written.sectionsKey,
            astS3Key: written.astKey,
            contentHash: written.contentHash,
          })
          .where(
            and(
              eq(caseLawDecisions.id, decisionId),
              sql`${caseLawDecisions.sourceHash} IS NOT DISTINCT FROM ${persistedSourceHash}`,
            ),
          );
      });
    } catch (error) {
      s3UploadFailed = true;
      // The halt reason only carries a failure count; without this line the
      // cause of a held cursor is invisible to an operator reading the log.
      logger.error("case_law.ingestion.corpus_write_failed", {
        decisionId,
        caseNumber: result.caseNumber,
        country: result.country,
        "error.type": errorTag(error),
        "error.detail": corpusWriteErrorDetail(error),
      });
      captureError(error, { decisionId, step: "processDecision.corpusWrite" });
      await preserveCorpusWriteRetry({
        decisionId,
        previousSourceHash: existing?.sourceHash ?? null,
        expectedSourceHash: persistedSourceHash,
        scopedDb,
      });
    }
  }

  // Search indexing (tsvector) is handled by a background
  // backfill loop so the slow to_tsvector + unaccent computation
  // doesn't block cursor advancement. New decisions become
  // searchable within ~30s of insertion.

  return { inserted: true, searchVectorFailed: false, s3UploadFailed };
};

/**
 * Run the ingestion pipeline for a configured source.
 *
 * Fetches pages from the source adapter, processes each
 * decision (segment, extract citations, dedup), and stores
 * results in the database.
 */
export const runIngestionPipeline = async ({
  source,
  scopedDb,
  signal,
  maxPages: maxPagesOverride,
  maxDecisions,
  dbSlot,
}: PipelineInput): Promise<PipelineResult> => {
  const adapter = getAdapter(source.adapterKey);

  if (!adapter) {
    panic(`Unknown adapter: ${source.adapterKey}`);
  }

  let cursor = source.syncCursor;
  let inserted = 0;
  let skipped = 0;
  let searchVectorFailures = 0;
  let s3UploadFailures = 0;
  let pagesProcessed = 0;
  /** Track recent cursors to detect parking (stagnation or ping-pong). */
  const recentCursors = new Set<string | null>();
  /**
   * Consecutive decision-level failures. Reset on each success.
   * If this exceeds the threshold, the adapter is halted for
   * this cycle to avoid hammering a broken court API.
   */
  let consecutiveFailures = 0;
  const MAX_CONSECUTIVE_FAILURES = 10;
  let haltReason: string | null = null;

  const maxPages = maxPagesOverride ?? adapter.maxSyncPages ?? MAX_SYNC_PAGES;

  // oxlint-disable-next-line no-unreachable-loop -- successful pages advance the cursor and pagesProcessed at the loop tail; break paths halt ingestion
  while (pagesProcessed < maxPages) {
    if (signal?.aborted) {
      haltReason = "Cycle timeout exceeded";
      logger.warn("case_law.ingestion.cycle_timeout", {
        adapterKey: adapter.key,
        cursor: cursor ?? "",
        pagesProcessed,
        inserted,
        skipped,
      });
      break;
    }

    const pageTimeout = adapter.pageTimeoutMs ?? ADAPTER_TIMEOUT.PAGE;
    const pageSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(pageTimeout)])
      : AbortSignal.timeout(pageTimeout);
    recentCursors.add(cursor);
    // oxlint-disable-next-line no-await-in-loop -- sequential paginated crawl (each page's cursor depends on the previous page)
    const pageResult = await adapter.fetchPage(
      cursor,
      source.config ?? {},
      pageSignal,
    );

    if (Result.isError(pageResult)) {
      captureError(pageResult.error, {
        adapterKey: adapter.key,
        cursor: cursor ?? "",
      });
      haltReason = `Page fetch failed: ${pageResult.error.message}`;
      logger.error("case_law.ingestion.adapter_halted", {
        adapterKey: adapter.key,
        cursor: cursor ?? "",
        reason: haltReason,
        inserted,
        skipped,
      });
      break;
    }

    const page = pageResult.value;

    // Acquire DB slot before processing decisions (DB-heavy:
    // insert, search index, citation extraction). Released
    // before the next page fetch so external API calls don't
    // hold the slot. try-finally ensures no slot leak on
    // unexpected exceptions.
    //
    // A page with no decisions never touches the slot: it has no DB
    // work, and acquiring anyway let a cycle-timeout abort land in
    // the gap between the fetch returning and the acquire — breaking
    // out before the cursor advance below ever ran, silently
    // discarding the forward progress the fetch had already made and
    // pinning the adapter to the same cursor on every later cycle.
    let pageHoldsDbSlot = false;
    if (dbSlot && page.decisions.length > 0) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- sequential per-page DB-slot acquisition bounds concurrent DB pressure
        await dbSlot.acquire(signal);
        pageHoldsDbSlot = true;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          haltReason = "Cycle timeout exceeded";
          break;
        }
        throw error;
      }
    }
    const pageT0 = performance.now();
    const insertedBefore = inserted;
    const skippedBefore = skipped;
    const s3FailuresBefore = s3UploadFailures;
    try {
      for (const result of page.decisions) {
        if (maxDecisions !== undefined && inserted >= maxDecisions) {
          // Halting (instead of breaking quietly) keeps the cursor at
          // this page so the unprocessed remainder is not skipped.
          haltReason = `Decision cap (${maxDecisions}) reached`;
          break;
        }
        try {
          // oxlint-disable-next-line no-await-in-loop -- sequential decision inserts: consecutive-failure halting and per-page counters depend on ordering
          const outcome = await processDecision(result, source.id, scopedDb);

          if (outcome.inserted) {
            inserted++;
          } else {
            skipped++;
          }
          consecutiveFailures = 0;
          if (outcome.searchVectorFailed) {
            searchVectorFailures++;
          }
          if (outcome.s3UploadFailed) {
            s3UploadFailures++;
          }
        } catch (error) {
          consecutiveFailures++;
          const tag = errorTag(error);
          const message =
            error instanceof Error ? error.message : String(error);

          logger.error("case_law.ingestion.decision_failed", {
            adapterKey: adapter.key,
            caseNumber: result.caseNumber,
            cursor: cursor ?? "",
            "error.type": tag,
            // "message" is stripped by the logger sanitizer; use
            // "error.detail" so the SQL/HTTP/SDK reason reaches
            // CloudWatch. Case-law data is public, no PII concern.
            "error.detail": message.slice(0, 512),
            consecutiveFailures,
          });
          captureError(error, {
            adapterKey: adapter.key,
            caseNumber: result.caseNumber,
            cursor: cursor ?? "",
          });

          if (error instanceof TimeoutError) {
            haltReason = databaseTimeoutHaltReason(error);
            break;
          }

          // Persist failure for later analysis
          try {
            // oxlint-disable-next-line no-await-in-loop -- failure logged inline within the sequential decision loop
            await logIngestionFailure(scopedDb, {
              sourceId: source.id,
              caseNumber: result.caseNumber,
              language: result.language,
              errorType: tag.slice(0, 128),
              errorMessage: message.slice(0, 2048),
              cursor,
            });
          } catch (failureLogError) {
            captureError(failureLogError, {
              sourceId: source.id,
              caseNumber: result.caseNumber,
            });

            if (failureLogError instanceof TimeoutError) {
              haltReason = databaseTimeoutHaltReason(failureLogError);
              break;
            }
          }

          skipped++;

          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            haltReason =
              `${MAX_CONSECUTIVE_FAILURES} consecutive failures; ` +
              `last: [${tag}] ${message.slice(0, 200)}`;
            break;
          }
        }
      }

      const pageInserted = inserted - insertedBefore;
      const pageSkipped = skipped - skippedBefore;
      const pageS3Failures = s3UploadFailures - s3FailuresBefore;
      if (pageS3Failures > 0 && haltReason === null) {
        // Hold the cursor on a page with failed corpus writes: cursor
        // sources do not re-emit consumed pages, so advancing would leave
        // the preserved source-hash retry unreachable until the source
        // changes again.
        haltReason = `${pageS3Failures} corpus write failure(s); cursor held for retry`;
      }
      logger.info("case_law.ingestion.pipeline_page_done", {
        adapterKey: adapter.key,
        cursor: cursor ?? "",
        nextCursor: page.nextCursor ?? "",
        page: pagesProcessed + 1,
        decisions: page.decisions.length,
        inserted: pageInserted,
        skipped: pageSkipped,
        durationMs: Math.round(performance.now() - pageT0),
        halted: haltReason !== null,
      });

      if (haltReason) {
        logger.error("case_law.ingestion.adapter_halted", {
          adapterKey: adapter.key,
          cursor: cursor ?? "",
          reason: haltReason,
          inserted,
          skipped,
        });
        break;
      }

      cursor = page.nextCursor;
      pagesProcessed++;
    } finally {
      if (dbSlot && pageHoldsDbSlot) {
        dbSlot.release();
      }
    }

    // Stop when the adapter signals exhaustion: null cursor
    // or a cursor we've already visited (stagnation / ping-pong
    // between two parked positions).
    if (!page.nextCursor || recentCursors.has(page.nextCursor)) {
      break;
    }

    if (adapter.minRequestIntervalMs > 0) {
      // oxlint-disable-next-line no-await-in-loop -- polite crawl delay between page fetches
      await Bun.sleep(adapter.minRequestIntervalMs);
    }
  }

  const checkpoint = await advanceCorpusIngestionCheckpoint({
    expectedCursor: source.syncCursor,
    nextCursor: cursor,
    scopedDb,
    source: { id: source.id, type: CORPUS_SOURCE_TYPE.CASE_LAW },
  });
  if (checkpoint.status === INGESTION_CHECKPOINT_STATUS.MISSING) {
    return panic("Case-law ingestion source disappeared before checkpoint");
  }
  if (checkpoint.status === INGESTION_CHECKPOINT_STATUS.SUPERSEDED) {
    logger.warn("case_law.ingestion.checkpoint_superseded", {
      adapterKey: source.adapterKey,
      sourceId: source.id,
    });
  }
  cursor = checkpoint.cursor;

  return {
    inserted,
    skipped,
    searchVectorFailures,
    s3UploadFailures,
    pagesProcessed,
    nextCursor: cursor,
    haltReason,
  };
};

const logIngestionFailure = async (
  scopedDb: ScopedDb,
  failure: typeof caseLawIngestionFailures.$inferInsert,
) => {
  // audit: skip — background case-law ingestion pipeline; public case-law data, not user actions
  // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive that the require-audit-on-mutation rule scans for inside this arrow's body range
  await scopedDb((tx) => {
    // audit: skip — background case-law ingestion pipeline; public case-law data, not user actions
    return tx.insert(caseLawIngestionFailures).values(failure);
  });
};
