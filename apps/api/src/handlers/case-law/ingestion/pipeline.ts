import { Result, panic } from "better-result";
import { and, eq, isNull, lt, notInArray, or, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  CASE_LAW_CORPUS_MIRROR_STATUS,
  caseLawCitations,
  caseLawDecisions,
  caseLawIngestionFailures,
  caseLawSources,
} from "@/api/db/schema";
import { corpusStorageMode } from "@/api/env-base";
import {
  classifyCitation,
  proceduralKeysFromMetadata,
} from "@/api/handlers/case-law/citation-kind";
import type { ProceduralKeys } from "@/api/handlers/case-law/citation-kind";
import {
  ADAPTER_TIMEOUT,
  MAX_SYNC_PAGES,
} from "@/api/handlers/case-law/consts";
import {
  CASE_LAW_DECISION_SLUG_ALLOCATION_ATTEMPTS,
  createCaseLawDecisionSlugCandidate,
  createCaseLawDecisionSlug,
} from "@/api/handlers/case-law/decisions/slug";
import { hasUsableAst } from "@/api/handlers/case-law/document-ast";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import { getAdapter } from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import {
  bareCitationKey,
  extractCitations,
  isSelfCitation,
} from "@/api/handlers/case-law/ingestion/citation-extractor";
import { publisherCitationGap } from "@/api/handlers/case-law/ingestion/citation-recall";
import { recordSliceCoverage } from "@/api/handlers/case-law/ingestion/coverage-ledger";
import { shouldSkipRefresh } from "@/api/handlers/case-law/ingestion/refresh-policy";
import { segmentDecision } from "@/api/handlers/case-law/ingestion/segmenter";
import { extractContext } from "@/api/handlers/case-law/polarity/context";
import { pgPayloadCarriesDocument } from "@/api/handlers/case-law/stored-payload";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import {
  advanceCorpusIngestionCheckpoint,
  CORPUS_SOURCE_TYPE,
  INGESTION_CHECKPOINT_STATUS,
} from "@/api/lib/corpus-ingestion-checkpoint";
import type { CorpusStorageMode } from "@/api/lib/corpus-storage-mode";
import {
  ConcurrentModificationError,
  TimeoutError,
} from "@/api/lib/errors/tagged-errors";
import { errorTag } from "@/api/lib/errors/utils";
import type {
  CorpusPayload,
  WriteCorpusResult,
} from "@/api/lib/legal-search/corpus-storage";
import {
  corpusContentHash,
  corpusKeys,
  deleteCorpusDocument,
  EMPTY_CORPUS_CONTENT_HASHES,
  writeCorpusDocument,
} from "@/api/lib/legal-search/corpus-storage";
import type { DecisionSection } from "@/api/lib/legal-search/document-types";
import { sanitizeResult } from "@/api/lib/legal-search/ingestion-normalization";
import { storedDecisionSignal } from "@/api/lib/legal-search/parsers/validate-ast";
import { logger } from "@/api/lib/observability/logger";
import { isPgConstraintError, PG_ERROR } from "@/api/lib/pg-error";
import { getS3 } from "@/api/lib/s3";

export { sanitizeResult };

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

const CONTENTION_RECONCILIATION = {
  INITIAL: "initial",
  RETRY: "retry",
} as const;

type ContentionReconciliation =
  (typeof CONTENTION_RECONCILIATION)[keyof typeof CONTENTION_RECONCILIATION];

type ProcessDecisionAttemptOptions = {
  input: IngestionResult;
  sourceId: SafeId<"caseLawSource">;
  scopedDb: ScopedDb;
  observedAt: Date;
  observationOrder: bigint;
  contentionReconciliation: ContentionReconciliation;
};

type ProcessDecisionOptions = Omit<
  ProcessDecisionAttemptOptions,
  "contentionReconciliation"
>;

type SourceObservation = {
  order: bigint;
};

const storedObservationPrecedes = ({ order }: SourceObservation) =>
  or(
    isNull(caseLawDecisions.sourceObservationOrder),
    lt(caseLawDecisions.sourceObservationOrder, order),
  );

const allocateSourceObservationOrder = async (
  sourceId: SafeId<"caseLawSource">,
  scopedDb: ScopedDb,
): Promise<bigint> =>
  await scopedDb(async (tx) => {
    // audit: skip — background ingestion ordering state for public source data
    const allocated = (
      await tx
        .update(caseLawSources)
        .set({
          observationOrder: sql`${caseLawSources.observationOrder} + 1`,
          updatedAt: sql`${caseLawSources.updatedAt}`,
        })
        .where(eq(caseLawSources.id, sourceId))
        .returning({ order: caseLawSources.observationOrder })
    ).at(0);
    if (!allocated) {
      panic("Case-law source disappeared while allocating observation order");
    }
    return allocated.order;
  });

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

/**
 * Canonical join key for citation resolution, or null when the text does not
 * canonicalize. Null keeps a row out of the resolver's join instead of
 * matching every other unkeyed row on an empty string.
 */
const citationKeyOf = (text: string): string | null =>
  bareCitationKey(text) || null;

/**
 * Row values for one extracted citation, including what the citation is
 * doing: invoking authority, or naming the case's own procedural history.
 * Classified here rather than in the extractor because the decision needs
 * the surrounding text, which the pipeline already holds.
 */
const citationRow = (
  citingDecisionId: SafeId<"caseLawDecision">,
  citation: { citationText: string; sectionIndex: number | null },
  sections: { index: number; text: string }[],
  proceduralKeys: ProceduralKeys,
) => {
  const citationKey = citationKeyOf(citation.citationText);
  return {
    citingDecisionId,
    citationText: citation.citationText,
    citationKey,
    kind: classifyCitation({
      citationText: citation.citationText,
      citationKey,
      proceduralKeys,
      context: extractContext(
        sections,
        citation.citationText,
        citation.sectionIndex,
      ),
    }),
    sectionIndex: citation.sectionIndex,
  };
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
  | { type: "preserve-stored" }
  | { type: "write-failed" };

type CorpusWritePayload = CorpusPayload & {
  documentId: SafeId<"caseLawDecision">;
  jurisdiction: string;
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
 * post-transaction cleanup: a refresh derives these keys from the
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

/**
 * SQL for "this row holds a document", in the columns or in the corpus
 * objects its hash names. The row write below carries this in its WHERE,
 * where it is evaluated with the write and cannot go stale.
 */
const rowHoldsDocument = sql<boolean>`(
  ${pgPayloadCarriesDocument}
  or (
    ${caseLawDecisions.contentHash} is not null
    and ${notInArray(caseLawDecisions.contentHash, [...EMPTY_CORPUS_CONTENT_HASHES])}
  )
)`;

/**
 * The same question, asked ahead of the write. Answered as a boolean
 * rather than by pulling the payload across: the text can be megabytes
 * and this runs inside the crawl.
 *
 * This answer is advisory: it decides whether to spend a corpus write
 * and whether to report an empty decision, neither of which can be made
 * conditional inside the row update. The guarantee that a document is
 * not overwritten lives in that update's WHERE clause, so a backfill
 * committing between this read and the write loses nothing.
 */
const hasStoredDocument = async (
  decisionId: SafeId<"caseLawDecision">,
  scopedDb: ScopedDb,
): Promise<boolean> => {
  const [row] = await scopedDb((tx) =>
    tx
      .select({ holdsDocument: rowHoldsDocument })
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.id, decisionId))
      .limit(1),
  );

  return row?.holdsDocument === true;
};

type PendingMirrorPayload = Pick<
  CorpusWritePayload,
  "ast" | "sections" | "text"
>;

const loadPendingMirrorPayload = async (
  decisionId: SafeId<"caseLawDecision">,
  scopedDb: ScopedDb,
): Promise<PendingMirrorPayload> => {
  const row = await scopedDb((tx) =>
    tx.query.caseLawDecisions.findFirst({
      where: { id: { eq: decisionId } },
      columns: {
        documentAst: true,
        fulltext: true,
        sections: true,
      },
    }),
  );
  if (!row) {
    panic("Pending case-law corpus mirror disappeared");
  }
  return {
    ast: row.documentAst,
    sections: row.sections,
    text: row.fulltext,
  };
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
  written: Parameters<typeof deleteCorpusDocument>[0],
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
const processDecisionAttempt = async ({
  input,
  sourceId,
  scopedDb,
  observedAt,
  observationOrder,
  contentionReconciliation,
}: ProcessDecisionAttemptOptions): Promise<ProcessResult> => {
  const result = sanitizeResult(input);

  // Match on the publisher's id where the adapter supplies one, and only
  // fall back to the case number where it does not. The two are the halves
  // of the uniqueness key, so the lookup has to split the same way the
  // index does or it would find a row the insert cannot replace.
  const existing = await scopedDb((tx) =>
    tx.query.caseLawDecisions.findFirst({
      where: result.sourceDocumentId
        ? {
            sourceId: { eq: sourceId },
            sourceDocumentId: result.sourceDocumentId,
            sheetNumber: result.sheetNumber,
          }
        : {
            sourceId: { eq: sourceId },
            caseNumber: result.caseNumber,
            language: result.language,
          },
      columns: {
        id: true,
        metadata: true,
        sourceHash: true,
        sourceObservedAt: true,
        sourceObservationHash: true,
        corpusMirrorStatus: true,
        sourceRawS3Key: true,
        sourceRawContentType: true,
      },
    }),
  );

  if (
    existing &&
    existing.corpusMirrorStatus === CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED &&
    shouldSkipRefresh({
      existingMetadata: existing.metadata,
      existingSourceHash: existing.sourceHash,
      incomingMetadata: result.metadata,
      incomingRawHash: result.rawHash,
    })
  ) {
    const watermarkAdvanced = await scopedDb(
      // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive
      async (tx) => {
        // audit: skip — background case-law ingestion ordering metadata; public case-law data, not user actions
        return (
          await tx
            .update(caseLawDecisions)
            .set({
              sourceObservedAt: observedAt,
              sourceObservationOrder: observationOrder,
              sourceObservationHash: result.rawHash,
              // Drizzle applies the schema's on-update value unless this column is
              // explicit. A watermark-only replay is not a content modification.
              updatedAt: sql`${caseLawDecisions.updatedAt}`,
            })
            .where(
              and(
                eq(caseLawDecisions.id, existing.id),
                storedObservationPrecedes({ order: observationOrder }),
                sql`${caseLawDecisions.sourceHash} IS NOT DISTINCT FROM ${existing.sourceHash}`,
                sql`${caseLawDecisions.metadata} IS NOT DISTINCT FROM ${JSON.stringify(existing.metadata)}::jsonb`,
              ),
            )
            .returning({ id: caseLawDecisions.id })
        ).at(0);
      },
    );
    if (!watermarkAdvanced) {
      const current = await scopedDb((tx) =>
        tx.query.caseLawDecisions.findFirst({
          where: { id: { eq: existing.id } },
          columns: { sourceObservationOrder: true },
        }),
      );
      if (
        !current ||
        (current.sourceObservationOrder !== null &&
          current.sourceObservationOrder >= observationOrder)
      ) {
        return {
          inserted: false,
          searchVectorFailed: false,
          s3UploadFailed: false,
        };
      }
      if (contentionReconciliation === CONTENTION_RECONCILIATION.RETRY) {
        throw new ConcurrentModificationError({
          message: "Case-law decision refresh did not converge",
        });
      }
      return await processDecisionAttempt({
        input,
        sourceId,
        scopedDb,
        observedAt,
        observationOrder,
        contentionReconciliation: CONTENTION_RECONCILIATION.RETRY,
      });
    }
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

  // A metadata-first source keeps refreshing a decision it has no
  // document for: the list endpoint's fields change, the hash moves, and
  // the adapter returns the same empty AST it returned at first sight.
  // Applying that over a decision whose document has since arrived — by
  // hydration or backfill — would put the empty AST back, and under
  // corpus storage would rewrite the objects empty and move the row's
  // keys onto them, which is precisely the state the repair pass exists
  // to undo. Nothing the refresh carries is a document, so nothing it
  // carries may replace one: the metadata is updated and the payload,
  // its object-storage pointers and the citations drawn from it are left
  // as they are.
  const incomingCarriesDocument = Boolean(
    result.fulltext || hasUsableAst(result.documentAst),
  );
  const preserveStoredDocument =
    existing !== undefined &&
    !incomingCarriesDocument &&
    (await hasStoredDocument(existing.id, scopedDb));
  const pendingMirrorPayload =
    existing?.corpusMirrorStatus === CASE_LAW_CORPUS_MIRROR_STATUS.PENDING &&
    !incomingCarriesDocument
      ? await loadPendingMirrorPayload(existing.id, scopedDb)
      : null;

  // Parsers report their own quality through `validateAndLog`, but a
  // source whose parser never runs reports nothing at all. Emit the
  // same signal here so every stored decision is accounted for, and
  // split the severity the same way: no text is an error, text without
  // structure is a warning. A refresh that preserves the stored document
  // reports nothing: it did not store an empty decision, it left a full
  // one alone, and these errors are what an operator sweeps for.
  const astBlocks = hasUsableAst(result.documentAst)
    ? result.documentAst.blocks.length
    : 0;
  const signal = preserveStoredDocument
    ? undefined
    : storedDecisionSignal({
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

  // The publisher's own statement of the case's procedural history, where
  // it supplies one; classification consults it before any heuristic.
  const proceduralKeys = proceduralKeysFromMetadata(
    result.metadata,
    (caseNumber) => bareCitationKey(caseNumber),
  );

  const citations = extractCitations(
    sections.map((s) => ({ index: s.index, text: s.text })),
  ).filter(
    (c) =>
      !isSelfCitation(c.citationText, {
        caseNumber: result.caseNumber,
        ecli: result.ecli ?? null,
      }),
  );

  // Where the publisher supplies its own cited-decisions list, it is the
  // one ground truth extraction can be measured against without measuring
  // it against itself. Computed here, emitted only after the row write
  // commits (a replayed decision must not re-count) — and emitted for
  // zero-gap decisions too, or aggregated events could not produce a
  // recall denominator.
  // Measured only when the incoming payload carries a document: an empty
  // payload has nothing for extraction to find, so every publisher
  // citation would read as missed — on document-preserving refreshes and
  // equally when a concurrent backfill wins the row between the read and
  // the transaction. Emitted here rather than after the write because an
  // ambiguous timeout can commit the row yet throw, and the replay
  // dedup-skips before re-measuring; the source hash is the identity a
  // consumer deduplicates retries on.
  if (
    incomingCarriesDocument &&
    !preserveStoredDocument &&
    result.publisherCitedCases &&
    result.publisherCitedCases.length > 0
  ) {
    const recall = publisherCitationGap({
      extracted: citations.map((c) => c.citationText),
      publisherCited: result.publisherCitedCases,
    });
    const level = recall.missed.length > 0 ? "warn" : "info";
    logger[level]("case_law.ingestion.citation_recall", {
      caseNumber: result.caseNumber,
      language: result.language,
      url: result.sourceUrl ?? "",
      sourceHash: result.rawHash,
      publisherCitedCount: recall.publisherCitedCount,
      missedCount: recall.missed.length,
      missed: recall.missed.slice(0, 10).join("; "),
    });
  }

  const languageGroupKey = result.ecli || `${sourceId}:${result.caseNumber}`;

  // Corpus objects are keyed on the decision id, so a canonical write needs
  // that id before the row exists. Minting it here is what the column
  // default (`pUuid`) would do at insert time anyway.
  const decisionId = existing?.id ?? createSafeId<"caseLawDecision">();

  const corpusPayload: CorpusWritePayload =
    pendingMirrorPayload === null
      ? {
          documentId: decisionId,
          jurisdiction: result.country,
          text: result.fulltext ?? null,
          sections: sections.length > 0 ? sections : null,
          ast: result.documentAst,
        }
      : {
          documentId: decisionId,
          jurisdiction: result.country,
          ...pendingMirrorPayload,
        };
  const mirrorCarriesDocument = Boolean(
    corpusPayload.text || hasUsableAst(corpusPayload.ast),
  );

  const corpusPlan: CorpusWritePlan =
    preserveStoredDocument && pendingMirrorPayload === null
      ? { type: "preserve-stored" }
      : await planCorpusWrite({
          mode: corpusStorageMode,
          hadExistingRow: Boolean(existing),
          ...corpusPayload,
        });

  if (corpusPlan.type === "write-failed") {
    // Persist nothing: a row would advance sourceHash and the next cycle
    // would dedup-skip the decision before it could retry the write. The
    // caller counts this as an S3 failure, which holds the page cursor.
    return { inserted: false, searchVectorFailed: false, s3UploadFailed: true };
  }

  const postgresPayload = {
    fulltext: corpusPayload.text,
    sections: corpusPayload.sections,
    documentAst: corpusPayload.ast,
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
          corpusMirrorStatus: CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED,
        };
      case "postgres-mirrored":
        // Persist retry intent with the Postgres payload. Clearing every old
        // pointer makes the pending branch structurally unable to serve a
        // stale mirror while an unchanged replay repairs it.
        return {
          ...postgresPayload,
          textS3Key: null,
          normalizedS3Key: null,
          astS3Key: null,
          contentHash: null,
          corpusMirrorStatus: CASE_LAW_CORPUS_MIRROR_STATUS.PENDING,
        };
      case "preserve-stored":
        // Every payload column, and every pointer into object storage,
        // stays exactly as stored. Leaving them out of the update is
        // what preserves them.
        return {};
      case "object-storage":
        return {
          fulltext: null,
          sections: null,
          documentAst: null,
          textS3Key: corpusPlan.written.textKey,
          normalizedS3Key: corpusPlan.written.sectionsKey,
          astS3Key: corpusPlan.written.astKey,
          contentHash: corpusPlan.written.contentHash,
          corpusMirrorStatus: CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED,
        };
      default: {
        const unhandled: never = corpusPlan;
        return panic(`Unhandled corpus write plan: ${String(unhandled)}`);
      }
    }
  })();

  const writeDecisionRow = async (slug?: string): Promise<boolean> =>
    await scopedDb(async (tx) => {
      // audit: skip — background case-law ingestion pipeline; public case-law data, not user actions
      if (existing) {
        // A refresh with no document of its own may not overwrite one,
        // and whether the row has one can change between the check above
        // and this write. So the payload columns move to their own
        // statement, carrying the condition in the WHERE where it is
        // evaluated with the write: a backfill that commits in between
        // takes the update out of scope instead of losing to it. The
        // metadata is unconditional either way, so a refresh that
        // declines to touch the payload still lands and still advances
        // the source hash.
        const payloadNeedsGuard =
          !incomingCarriesDocument &&
          pendingMirrorPayload === null &&
          Object.keys(payloadColumns).length > 0;

        const updated = await tx
          .update(caseLawDecisions)
          .set({
            ecli: result.ecli,
            court: result.court,
            country: result.country,
            language: result.language,
            languageGroupKey,
            decisionDate: result.decisionDate,
            decisionType: result.decisionType,
            ...(payloadNeedsGuard ? {} : payloadColumns),
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
            sourceObservedAt: observedAt,
            sourceObservationOrder: observationOrder,
            sourceObservationHash: result.rawHash,
            // Clear indexedHash so the corpus indexer re-picks this row even
            // when only metadata changed (its staleness check compares
            // indexedHash to contentHash, which only tracks the payload).
            indexedHash: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(caseLawDecisions.id, existing.id),
              storedObservationPrecedes({ order: observationOrder }),
            ),
          )
          .returning({ id: caseLawDecisions.id });

        if (updated.length === 0) {
          return false;
        }

        if (payloadNeedsGuard) {
          await tx
            .update(caseLawDecisions)
            .set(payloadColumns)
            .where(
              and(
                eq(caseLawDecisions.id, existing.id),
                sql`not ${rowHoldsDocument}`,
              ),
            );
        }

        // Citations are read out of the document, so a refresh that
        // carries no document has nothing to say about them either.
        if (!incomingCarriesDocument) {
          return true;
        }

        await tx
          .delete(caseLawCitations)
          .where(eq(caseLawCitations.citingDecisionId, existing.id));

        if (citations.length > 0) {
          await tx
            .insert(caseLawCitations)
            .values(
              citations.map((c) =>
                citationRow(existing.id, c, sections, proceduralKeys),
              ),
            );
        }

        return true;
      }

      if (slug === undefined) {
        panic("Missing slug for a new case-law decision");
      }

      const [decisionRow] = await tx
        .insert(caseLawDecisions)
        .values({
          id: decisionId,
          sourceId,
          caseNumber: result.caseNumber,
          sourceDocumentId: result.sourceDocumentId,
          citationKey: citationKeyOf(result.caseNumber),
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
          sourceObservedAt: observedAt,
          sourceObservationOrder: observationOrder,
          sourceObservationHash: result.rawHash,
        })
        .returning({ id: caseLawDecisions.id });

      if (!decisionRow) {
        panic("Failed to insert decision: no row returned");
      }

      if (citations.length > 0) {
        await tx
          .insert(caseLawCitations)
          .values(
            citations.map((c) =>
              citationRow(decisionRow.id, c, sections, proceduralKeys),
            ),
          );
      }
      return true;
    });

  // Pass the original error through: the pipeline's halt semantics inspect
  // its type (a TimeoutError holds the cursor), which a wrapper would hide.
  const slugIdentity = result.sourceDocumentId
    ? `${sourceId}\u0000document\u0000${result.sourceDocumentId}`
    : `${sourceId}\u0000case\u0000${result.caseNumber}\u0000${result.language}`;
  const baseSlug = createCaseLawDecisionSlug(result.caseNumber);

  let rowWrite = await Result.tryPromise({
    try: async () => await writeDecisionRow(existing ? undefined : baseSlug),
    catch: (cause: unknown) => cause,
  });

  for (const attempt of CASE_LAW_DECISION_SLUG_ALLOCATION_ATTEMPTS) {
    if (attempt === 0) {
      continue;
    }
    if (Result.isOk(rowWrite)) {
      break;
    }
    if (
      !isPgConstraintError(
        rowWrite.error,
        PG_ERROR.UNIQUE_VIOLATION,
        "case_law_decisions_slug_uidx",
      )
    ) {
      break;
    }
    const slug = createCaseLawDecisionSlugCandidate({
      baseSlug,
      identity: slugIdentity,
      attempt,
    });
    // oxlint-disable-next-line no-await-in-loop -- a failed unique-index insert aborts its transaction; each deterministic candidate needs a fresh transaction
    rowWrite = await Result.tryPromise({
      try: async () => await writeDecisionRow(slug),
      catch: (cause: unknown) => cause,
    });
  }

  if (Result.isError(rowWrite)) {
    const isConcurrentIdentityInsert =
      isPgConstraintError(
        rowWrite.error,
        PG_ERROR.UNIQUE_VIOLATION,
        "case_law_decisions_source_document_idx",
      ) ||
      isPgConstraintError(
        rowWrite.error,
        PG_ERROR.UNIQUE_VIOLATION,
        "case_law_decisions_source_case_lang_null_idx",
      );
    if (isConcurrentIdentityInsert) {
      if (corpusPlan.type === "object-storage") {
        await discardOrphanedCorpusObjects(corpusPlan.written, decisionId);
      }
      if (contentionReconciliation === CONTENTION_RECONCILIATION.RETRY) {
        throw new ConcurrentModificationError({
          message: "Case-law decision identity did not converge",
        });
      }
      return await processDecisionAttempt({
        input,
        sourceId,
        scopedDb,
        observedAt,
        observationOrder,
        contentionReconciliation: CONTENTION_RECONCILIATION.RETRY,
      });
    }
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

  if (!rowWrite.value) {
    return {
      inserted: false,
      searchVectorFailed: false,
      s3UploadFailed: false,
    };
  }

  // Mirror text/sections/AST to object storage, then record the keys +
  // content hash. Done outside the DB transaction (S3 I/O must not hold a
  // transaction open). The row enters `pending` with no object pointers in
  // the same transaction as its Postgres payload; a failure therefore stays
  // readable and an unchanged replay cannot deduplicate before repairing the
  // mirror. `canonical` has already written its objects above, before the
  // row. Keyed off the plan rather than the mode, so a refresh preserving a
  // stored document does not mirror the nothing it arrived with over the
  // objects that hold it.
  if (corpusPlan.type === "postgres-mirrored") {
    // The sourceHash this call just persisted: corpus-key and retry
    // updates below only apply while the row still carries it, so a
    // slower run cannot overwrite a concurrent newer refresh.
    const persistedSourceHash = s3UploadFailed
      ? (existing?.sourceHash ?? null)
      : result.rawHash;
    try {
      const written = await writeCorpusDocument(corpusPayload);
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
            corpusMirrorStatus: CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED,
          })
          .where(
            and(
              eq(caseLawDecisions.id, decisionId),
              sql`${caseLawDecisions.sourceHash} IS NOT DISTINCT FROM ${persistedSourceHash}`,
              eq(caseLawDecisions.sourceObservationOrder, observationOrder),
              // An empty mirror must not re-point the keys over a row that
              // gained a document between the stored-document check and this
              // update: hydration does not advance the source hash, so the
              // CAS above cannot see it. A mirror that carries the document
              // is exempt — it is the newer payload by definition.
              mirrorCarriesDocument
                ? undefined
                : sql`NOT ${pgPayloadCarriesDocument}`,
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
    }
  }

  // Search indexing (tsvector) is handled by a background
  // backfill loop so the slow to_tsvector + unaccent computation
  // doesn't block cursor advancement. New decisions become
  // searchable within ~30s of insertion.

  return { inserted: true, searchVectorFailed: false, s3UploadFailed };
};

export const processDecision = async (
  options: ProcessDecisionOptions,
): Promise<ProcessResult> =>
  await processDecisionAttempt({
    ...options,
    contentionReconciliation: CONTENTION_RECONCILIATION.INITIAL,
  });

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
  let checkpointObservationOrder = source.checkpointObservationOrder;

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
    // Allocate from the source row before the request: PostgreSQL serializes
    // overlapping workers without relying on replica wall clocks.
    let observationOrder: bigint;
    try {
      // oxlint-disable-next-line no-await-in-loop -- each page needs one durable order token before its dependent fetch
      observationOrder = await allocateSourceObservationOrder(
        source.id,
        scopedDb,
      );
      checkpointObservationOrder = observationOrder;
    } catch (error) {
      if (error instanceof TimeoutError) {
        haltReason = databaseTimeoutHaltReason(error);
        break;
      }
      throw error;
    }
    const observedAt = new Date();
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
          const outcome = await processDecision({
            input: result,
            sourceId: source.id,
            scopedDb,
            observedAt,
            observationOrder,
          });

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
      // Record what the source said this slice holds against what the
      // crawl produced. Written before the cursor advances, so a slice is
      // never passed without leaving a row behind to reconcile against.
      if (page.coverage) {
        // oxlint-disable-next-line no-await-in-loop -- the row must land before this page's cursor advances, so it cannot be deferred past the loop
        await recordSliceCoverage(scopedDb, {
          sourceId: source.id,
          coverage: page.coverage,
        });
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
    source: {
      id: source.id,
      observationOrder: checkpointObservationOrder,
      type: CORPUS_SOURCE_TYPE.CASE_LAW,
    },
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
