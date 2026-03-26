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
import { extractCitations } from "@/api/handlers/case-law/ingestion/citation-extractor";
import { segmentDecision } from "@/api/handlers/case-law/ingestion/segmenter";
import { indexDecision } from "@/api/handlers/case-law/search-index";
import { captureError } from "@/api/lib/posthog";

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
const sanitizeResult = (r: IngestionResult): IngestionResult => {
  const strip = (s: string | undefined): string | undefined =>
    s?.replaceAll("\x00", "");

  // Recursively strip null bytes from metadata values
  const sanitizeMetadata = (
    obj: Record<string, unknown>,
  ): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string") {
        out[k] = v.replaceAll("\x00", "");
      } else if (Array.isArray(v)) {
        out[k] = v.map((item) =>
          typeof item === "string" ? item.replaceAll("\x00", "") : item,
        );
      } else {
        out[k] = v;
      }
    }
    return out;
  };

  return {
    ...r,
    caseNumber: r.caseNumber.replaceAll("\x00", ""),
    fulltext: strip(r.fulltext),
    ecli: strip(r.ecli),
    decisionType: strip(r.decisionType),
    sourceUrl: strip(r.sourceUrl),
    documentUrl: strip(r.documentUrl),
    metadata: sanitizeMetadata(r.metadata),
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
    throw new Error(`Unknown adapter: ${source.adapterKey}`);
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
        // Log the full error and skip this decision instead of
        // aborting the page (which would leave the cursor stuck).
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        const cause =
          error instanceof Error && error.cause instanceof Error
            ? error.cause.message
            : undefined;
        // eslint-disable-next-line no-console -- adapter diagnostic
        console.error(
          `[${adapter.key}] Failed to process decision ${result.caseNumber}: ${errorMessage}${cause ? ` (cause: ${cause})` : ""}`,
        );
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
