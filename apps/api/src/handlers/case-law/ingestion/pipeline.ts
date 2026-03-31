import { Result, panic } from "better-result";
import { eq } from "drizzle-orm";

import type { ScopedDb } from "@/api/db";
import {
  caseLawCitations,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import {
  ADAPTER_TIMEOUT,
  MAX_SYNC_PAGES,
} from "@/api/handlers/case-law/consts";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import { getAdapter } from "@/api/handlers/case-law/ingestion/adapters";
import {
  extractCitations,
  isSelfCitation,
} from "@/api/handlers/case-law/ingestion/citation-extractor";
import { segmentDecision } from "@/api/handlers/case-law/ingestion/segmenter";
import { indexDecision } from "@/api/handlers/case-law/search-index";
import { captureError } from "@/api/lib/analytics";
import { errorTag } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";

type PipelineInput = {
  source: typeof caseLawSources.$inferSelect;
  scopedDb: ScopedDb;
};

type PipelineResult = {
  inserted: number;
  skipped: number;
  searchVectorFailures: number;
  nextCursor: string | null;
};

type ProcessResult = {
  inserted: boolean;
  searchVectorFailed: boolean;
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
// Constructed at runtime to avoid no-control-regex lint rule.
// Matches null bytes, BOM, C0 control chars (except HT/LF/CR),
// zero-width chars, word joiner, and interlinear annotations.
const DANGEROUS_CHARS = new RegExp(
  "[" +
    "\x00" + // null byte
    "\uFEFF\uFFFE" + // BOM variants
    "\u0000-\u0008" + // C0 before HT
    "\u000B\u000C" + // VT, FF
    "\u000E-\u001F" + // C0 after CR
    "\u200B-\u200D" + // zero-width chars
    "\u2060" + // word joiner
    "\uFFF9-\uFFFB" + // interlinear annotations
    "]",
  "g",
);

const sanitizeResult = (r: IngestionResult): IngestionResult => {
  const strip = (s: string | undefined): string | undefined =>
    s?.replace(DANGEROUS_CHARS, "");

  // Recursively strip null bytes from metadata values
  const sanitizeMetadata = (
    obj: Record<string, unknown>,
  ): Record<string, unknown> => {
    // oxlint-disable-next-line no-untyped-updates/no-untyped-updates -- sanitizer accumulator, not a DB update
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string") {
        out[k] = v.replace(DANGEROUS_CHARS, "");
      } else if (Array.isArray(v)) {
        out[k] = v.map((item: unknown) =>
          typeof item === "string" ? item.replace(DANGEROUS_CHARS, "") : item,
        );
      } else {
        out[k] = v;
      }
    }
    return out;
  };

  // Recursively sanitize all strings in documentAst.
  // JSON.stringify escapes control chars to \uXXXX sequences
  // that the regex wouldn't match, so we walk the tree.
  const deepSanitizeImpl = (val: unknown): unknown => {
    if (typeof val === "string") {
      return val.replace(DANGEROUS_CHARS, "");
    }
    if (Array.isArray(val)) {
      return val.map(deepSanitizeImpl);
    }
    if (val !== null && typeof val === "object") {
      // oxlint-disable-next-line no-untyped-updates/no-untyped-updates -- sanitizer accumulator
      const out: Record<string, unknown> = {};
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- val is a non-null object
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        out[k] = deepSanitizeImpl(v);
      }
      return out;
    }
    return val;
  };

  // SAFETY: deepSanitize only replaces string leaves;
  // the structural shape is preserved.
  const deepSanitize = <T>(val: T): T => deepSanitizeImpl(val) as T; // oxlint-disable-line typescript/no-unsafe-type-assertion

  const sanitizedAst = deepSanitize(r.documentAst);

  return {
    ...r,
    caseNumber: r.caseNumber.replace(DANGEROUS_CHARS, ""),
    fulltext: strip(r.fulltext),
    ecli: strip(r.ecli),
    decisionType: strip(r.decisionType),
    sourceUrl: strip(r.sourceUrl),
    documentUrl: strip(r.documentUrl),
    metadata: sanitizeMetadata(r.metadata),
    documentAst: sanitizedAst,
  };
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
      columns: { id: true, sourceHash: true },
    }),
  );

  if (existing?.sourceHash === result.rawHash) {
    return { inserted: false, searchVectorFailed: false };
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
          sourceHash: result.rawHash,
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

  return { inserted: true, searchVectorFailed };
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
  let pagesProcessed = 0;

  const maxPages = adapter.maxSyncPages ?? MAX_SYNC_PAGES;

  while (pagesProcessed < maxPages) {
    const pageTimeout = adapter.pageTimeoutMs ?? ADAPTER_TIMEOUT.PAGE;
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
        if (outcome.searchVectorFailed) {
          searchVectorFailures++;
        }
      } catch (error) {
        logger.error("case_law.ingestion.decision_failed", {
          adapterKey: adapter.key,
          caseNumber: result.caseNumber,
          cursor: cursor ?? "",
          "error.type": errorTag(error),
        });
        captureError(error, {
          adapterKey: adapter.key,
          caseNumber: result.caseNumber,
          cursor: cursor ?? "",
        });
        skipped++;
      }
    }

    cursor = page.nextCursor;
    pagesProcessed++;

    if (!page.nextCursor) {
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
    nextCursor: cursor,
  };
};
