import { Result, panic } from "better-result";
import { and, eq, like, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db";
import {
  caseLawCitations,
  caseLawDecisions,
  caseLawIngestionFailures,
  caseLawSources,
} from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import {
  ADAPTER_TIMEOUT,
  MAX_SYNC_PAGES,
} from "@/api/handlers/case-law/consts";
import { writeCorpusDocument } from "@/api/handlers/case-law/corpus-storage";
import {
  createAvailableCaseLawDecisionSlug,
  createCaseLawDecisionSlug,
  createCaseLawDecisionSlugCollisionScanPrefix,
} from "@/api/handlers/case-law/decisions/slug";
import { isDocumentAst } from "@/api/handlers/case-law/document-ast";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import { EMPTY_AST } from "@/api/handlers/case-law/ingestion/adapter";
import { getAdapter } from "@/api/handlers/case-law/ingestion/adapters";
import {
  extractCitations,
  isSelfCitation,
} from "@/api/handlers/case-law/ingestion/citation-extractor";
import { shouldSkipRefresh } from "@/api/handlers/case-law/ingestion/refresh-policy";
import {
  DANGEROUS_CHARS,
  sanitizeMetadata,
  stripDangerousChars,
} from "@/api/handlers/case-law/ingestion/sanitize";
import { segmentDecision } from "@/api/handlers/case-law/ingestion/segmenter";
import { captureError } from "@/api/lib/analytics";
import type { SafeId } from "@/api/lib/branded-types";
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
/**
 * Collapse spaced-out letters used for emphasis in court PDFs.
 *
 * Slovak and Czech courts format words with letter-spacing:
 *   `r o z h o d o l :` → `rozhodol:`
 *   `o d ô v o d n e n i e :` → `odôvodnenie:`
 *   `z a m i e t a` → `zamieta`
 *
 * These break full-text search ("rozhodol" won't match
 * "r o z h o d o l"). We collapse sequences of single Unicode
 * letters separated by single spaces, optionally followed by
 * punctuation. Multi-spaces between collapsed words are then
 * normalized to single space.
 *
 * Safe: won't touch normal text, digits, IČO numbers, or
 * case references (anchored by whitespace/string boundaries).
 */
const SPACED_WORD = /(?<=\s|^)(\p{L} (?:\p{L} )*\p{L})( ?[,:;.!?])?(?=\s|$)/gu;

/**
 * Collapse multiple spaces to single. Applied to all
 * ingested text to normalize PDF justified spacing where
 * words are padded with extra spaces for alignment.
 */
const collapseMultiSpaces = (text: string): string =>
  text.replace(/ {2,}/gu, " ");

const collapseSpacedLetters = (text: string): string =>
  collapseMultiSpaces(
    text.replace(SPACED_WORD, (match) => match.replace(/ /gu, "")),
  );

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

  const sections = result.fulltext ? segmentDecision(result.fulltext) : [];

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

  const decisionId = await scopedDb(async (tx) => {
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
          fulltext: result.fulltext,
          sections: sections.length > 0 ? sections : null,
          sourceUrl: result.sourceUrl,
          documentUrl: result.documentUrl,
          metadata: result.metadata,
          documentAst: result.documentAst,
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

      return existing.id;
    }

    const baseSlug = createCaseLawDecisionSlug(result.caseNumber);
    const slugScanPrefix = createCaseLawDecisionSlugCollisionScanPrefix({
      baseSlug,
      maxSuffix: LIMITS.caseLawSlugCollisionScanLimit + 1,
    });
    const existingSlugRows = await tx
      .select({ slug: caseLawDecisions.slug })
      .from(caseLawDecisions)
      .where(like(caseLawDecisions.slug, `${slugScanPrefix}%`))
      .limit(LIMITS.caseLawSlugCollisionScanLimit);
    const slug = createAvailableCaseLawDecisionSlug(
      baseSlug,
      existingSlugRows.map((row) => row.slug),
    );

    const [decisionRow] = await tx
      .insert(caseLawDecisions)
      .values({
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
        fulltext: result.fulltext,
        sections: sections.length > 0 ? sections : null,
        sourceUrl: result.sourceUrl,
        documentUrl: result.documentUrl,
        metadata: result.metadata,
        documentAst: result.documentAst,
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

    return decisionRow.id;
  });

  // Persist canonical text/sections/AST to object storage when enabled, then
  // record the keys + content hash. Done outside the DB transaction (S3 I/O
  // must not hold a transaction open). A failure leaves the row fully readable
  // from its Postgres columns and preserves the source-hash mismatch so normal
  // ingestion can retry the corpus write.
  if (envBase.CORPUS_STORAGE_ENABLED) {
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
    if (dbSlot) {
      try {
        await dbSlot.acquire(signal);
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

          // Persist failure for later analysis
          try {
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
      if (dbSlot) {
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
      await Bun.sleep(adapter.minRequestIntervalMs);
    }
  }

  // Persist sync cursor and timestamp
  // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive that the require-audit-on-mutation rule scans for inside this arrow's body range
  await scopedDb((tx) => {
    // audit: skip — background case-law ingestion pipeline; public case-law data, not user actions
    return tx
      .update(caseLawSources)
      .set({ syncCursor: cursor, lastSyncAt: new Date() })
      .where(eq(caseLawSources.id, source.id));
  });

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
