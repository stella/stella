import { Result, panic } from "better-result";
import { eq } from "drizzle-orm";

import type { ScopedDb } from "@/api/db";
import {
  caseLawCitations,
  caseLawDecisions,
  caseLawIngestionFailures,
  caseLawSources,
} from "@/api/db/schema";
import {
  ADAPTER_TIMEOUT,
  MAX_SYNC_PAGES,
} from "@/api/handlers/case-law/consts";
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
import { indexDecision } from "@/api/handlers/case-law/search-index";
import { captureError } from "@/api/lib/analytics";
import { errorTag } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import { s3 } from "@/api/lib/s3";
import { isRecord } from "@/api/lib/type-guards";

type PipelineInput = {
  source: typeof caseLawSources.$inferSelect;
  scopedDb: ScopedDb;
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
  text.replace(/ {2,}/g, " ");

const collapseSpacedLetters = (text: string): string =>
  collapseMultiSpaces(
    text.replace(SPACED_WORD, (match) => match.replace(/ /g, "")),
  );

export const sanitizeResult = (r: IngestionResult): IngestionResult => {
  // Strip dangerous chars and normalize non-breaking spaces.
  // \u00A0 (nbsp) comes from PDF text extraction (@libpdf/core)
  // and prevents the browser from wrapping at word boundaries.
  const strip = (s: string | undefined): string | undefined =>
    s ? stripDangerousChars(s) : undefined;

  // Recursively sanitize all strings in documentAst.
  // JSON.stringify escapes control chars to \uXXXX sequences
  // that the regex wouldn't match, so we walk the tree.
  const deepSanitizeImpl = (val: unknown, key?: string): unknown => {
    if (typeof val === "string") {
      const stripped = val.replace(DANGEROUS_CHARS, "").replace(/\u00A0/g, " ");
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
    decisionType: strip(r.decisionType),
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
  sourceId: string,
  data: Uint8Array | string,
  contentType: string,
): Promise<string> => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(data);
  const blobHash = hasher.digest("hex");
  const key = `case-law/raw/${sourceId}/${blobHash}`;
  await s3.write(key, data, { type: contentType });
  return key;
};

/**
 * Insert a single decision and its citations into the database.
 * Skips duplicates based on sourceHash.
 */
const processDecision = async (
  input: IngestionResult,
  sourceId: string,
  scopedDb: ScopedDb,
): Promise<ProcessResult> => {
  const result = sanitizeResult(input);

  const existing = await scopedDb((tx) =>
    tx.query.caseLawDecisions.findFirst({
      where: {
        sourceId,
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

  let decisionId: string | undefined;

  await scopedDb(async (tx) => {
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

      decisionId = existing.id;
      return;
    }

    const [decisionRow] = await tx
      .insert(caseLawDecisions)
      .values({
        sourceId,
        caseNumber: result.caseNumber,
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
        documentAst: result.documentAst ?? null,
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

    decisionId = decisionRow.id;
  });

  // Index into search table after transaction commits
  let searchVectorFailed = false;
  if (decisionId) {
    try {
      await indexDecision(decisionId, scopedDb);
    } catch (error) {
      captureError(error, { decisionId, sourceId });
      searchVectorFailed = true;
    }
  }

  return { inserted: true, searchVectorFailed, s3UploadFailed };
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

  const maxPages = adapter.maxSyncPages ?? MAX_SYNC_PAGES;

  while (pagesProcessed < maxPages) {
    const pageTimeout = adapter.pageTimeoutMs ?? ADAPTER_TIMEOUT.PAGE;
    recentCursors.add(cursor);
    const pageResult = await adapter.fetchPage(
      cursor,
      source.config ?? {},
      AbortSignal.timeout(pageTimeout),
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

    for (const result of page.decisions) {
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
        const message = error instanceof Error ? error.message : String(error);

        logger.error("case_law.ingestion.decision_failed", {
          adapterKey: adapter.key,
          caseNumber: result.caseNumber,
          cursor: cursor ?? "",
          "error.type": tag,
          consecutiveFailures,
        });
        captureError(error, {
          adapterKey: adapter.key,
          caseNumber: result.caseNumber,
          cursor: cursor ?? "",
        });

        // Persist failure for later analysis
        try {
          await scopedDb((tx) =>
            tx.insert(caseLawIngestionFailures).values({
              sourceId: source.id,
              caseNumber: result.caseNumber,
              language: result.language,
              errorType: tag.slice(0, 128),
              errorMessage: message.slice(0, 2048),
              cursor,
            }),
          );
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
  await scopedDb((tx) =>
    tx
      .update(caseLawSources)
      .set({ syncCursor: cursor, lastSyncAt: new Date() })
      .where(eq(caseLawSources.id, source.id)),
  );

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
