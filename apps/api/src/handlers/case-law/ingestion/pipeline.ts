import { Result } from "better-result";
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
 * Insert a single decision and its citations into the database.
 * Skips duplicates based on sourceHash.
 */
const processDecision = async (
  result: IngestionResult,
  sourceId: string,
  scopedDb: ScopedDb,
): Promise<ProcessResult> => {
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

    const [decision] = await tx
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

  while (pagesProcessed < MAX_SYNC_PAGES) {
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
      const outcome = await processDecision(result, source.id, scopedDb);

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
