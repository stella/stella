import { eq } from "drizzle-orm";

import { db } from "@/api/db";
import {
  caseLawCitations,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { MAX_SYNC_PAGES } from "@/api/handlers/case-law/consts";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import { getAdapter } from "@/api/handlers/case-law/ingestion/adapters";
import { extractCitations } from "@/api/handlers/case-law/ingestion/citation-extractor";
import { segmentDecision } from "@/api/handlers/case-law/ingestion/segmenter";
import { updateDecisionSearchVector } from "@/api/handlers/case-law/search-vector";

type PipelineInput = {
  source: typeof caseLawSources.$inferSelect;
};

type PipelineResult = {
  inserted: number;
  skipped: number;
  searchVectorFailures: number;
  nextCursor: string | null;
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

type ProcessResult = {
  inserted: boolean;
  searchVectorFailed: boolean;
};

/**
 * Insert a single decision and its citations into the database.
 * Skips duplicates based on sourceHash.
 */
const processDecision = async (
  result: IngestionResult,
  sourceId: string,
): Promise<ProcessResult> => {
  const existing = await db.query.caseLawDecisions.findFirst({
    where: {
      sourceId,
      caseNumber: result.caseNumber,
    },
    columns: { id: true, sourceHash: true },
  });

  if (existing?.sourceHash === result.rawHash) {
    return { inserted: false, searchVectorFailed: false };
  }

  const sections = result.fulltext ? segmentDecision(result.fulltext) : [];

  const citations = extractCitations(
    sections.map((s) => ({ index: s.index, text: s.text })),
  );

  let decisionId: string | undefined;

  await db.transaction(async (tx) => {
    if (existing) {
      await tx
        .update(caseLawDecisions)
        .set({
          ecli: result.ecli,
          court: result.court,
          country: result.country,
          language: result.language,
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

    const [decision] = await tx
      .insert(caseLawDecisions)
      .values({
        sourceId,
        caseNumber: result.caseNumber,
        ecli: result.ecli,
        court: result.court,
        country: result.country,
        language: result.language,
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

    if (citations.length > 0) {
      await tx.insert(caseLawCitations).values(
        citations.map((c) => ({
          citingDecisionId: decision.id,
          citationText: c.citationText,
          sectionIndex: c.sectionIndex,
        })),
      );
    }

    decisionId = decision.id;
  });

  // Update search vector after transaction commits
  let searchVectorFailed = false;
  if (decisionId) {
    try {
      await updateDecisionSearchVector(
        decisionId,
        result.caseNumber,
        result.court,
        result.fulltext ?? null,
        sections.length > 0 ? sections : null,
      );
    } catch (err) {
      console.error(`Failed to update search vector for ${decisionId}:`, err);
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

  while (pagesProcessed < MAX_SYNC_PAGES) {
    const page = await adapter.fetchPage(
      cursor,
      source.config ?? {},
      AbortSignal.timeout(30_000),
    );

    for (const result of page.decisions) {
      const outcome = await processDecision(result, source.id);

      if (outcome.inserted) {
        inserted++;
      } else {
        skipped++;
      }
      if (outcome.searchVectorFailed) {
        searchVectorFailures++;
      }
    }

    cursor = page.nextCursor;
    pagesProcessed++;

    if (!page.nextCursor) {
      break;
    }

    if (adapter.minRequestIntervalMs > 0) {
      await sleep(adapter.minRequestIntervalMs);
    }
  }

  // Persist sync cursor and timestamp
  await db
    .update(caseLawSources)
    .set({ syncCursor: cursor, lastSyncAt: new Date() })
    .where(eq(caseLawSources.id, source.id));

  return {
    inserted,
    skipped,
    searchVectorFailures,
    nextCursor: cursor,
  };
};
