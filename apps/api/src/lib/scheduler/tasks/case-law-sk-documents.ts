/**
 * Drain the Slovak court decisions waiting on their PDF.
 *
 * `sk-courts` stores metadata during the crawl and leaves the document
 * for this task, so the backlog grows with every page ingested. That
 * makes it a loop rather than a one-shot script: a decision without
 * fulltext is invisible to search and to the reader, and nobody would
 * remember to re-run a script for every day's ingestion.
 *
 * Each run is bounded by the scheduler's abort signal and a batch cap,
 * and paces itself between downloads: the court's site is the reason
 * these fetches were taken off the crawl in the first place.
 */

import { rlsDb } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { createIngestionDb } from "@/api/db/scoped";
import type { PendingDocument } from "@/api/handlers/case-law/ingestion/sk-document-backfill";
import {
  fetchPdfBytes,
  loadPendingDocuments,
  markDocumentUnavailable,
  parsePendingDocument,
  storeBackfilledDocument,
} from "@/api/handlers/case-law/ingestion/sk-document-backfill";
import { errorTag } from "@/api/lib/errors/utils";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const BACKFILL_SK_DOCUMENTS_TASK =
  "caseLaw.backfillSkDocuments" as const;

/** Decisions attempted per run. */
const BATCH_SIZE = 40;
/** Delay between PDF downloads, matching the adapter's crawl manners. */
const FETCH_DELAY_MS = 500;

/**
 * Fetch, parse and store one decision's document. All the awaiting
 * happens here rather than in the sweep loop below, which keeps the
 * loop to a single sequential step.
 */
const processPending = async (
  decision: PendingDocument,
  scopedDb: ScopedDb,
  signal: AbortSignal,
): Promise<"filled" | "unavailable"> => {
  const pdfBytes = decision.documentUrl
    ? await fetchPdfBytes(decision.documentUrl, signal)
    : undefined;
  const document = pdfBytes
    ? await parsePendingDocument(decision, pdfBytes)
    : undefined;

  if (!document) {
    await markDocumentUnavailable(decision.id, scopedDb);
    return "unavailable";
  }

  await storeBackfilledDocument(decision.id, document, scopedDb);
  // Pace the next download; the court's site is the reason these
  // fetches were taken off the crawl.
  await Bun.sleep(FETCH_DELAY_MS);
  return "filled";
};

export const backfillSkDocuments: SchedulerTask = async ({
  logger,
  signal,
}) => {
  const scopedDb = createIngestionDb(rlsDb);
  const pending = await loadPendingDocuments(scopedDb, BATCH_SIZE);

  if (pending.length === 0) {
    logger.debug("case_law.sk_documents.idle");
    return;
  }

  const counts = { filled: 0, unavailable: 0, failed: 0 };

  for (const decision of pending) {
    if (signal.aborted) {
      break;
    }

    try {
      // oxlint-disable-next-line no-await-in-loop -- rate-limited court downloads run one at a time by design
      counts[await processPending(decision, scopedDb, signal)]++;
    } catch (error) {
      // Leave fulltext NULL so a transient failure is retried, unlike
      // an unparseable document which is marked and moved past.
      counts.failed++;
      logger.warn("case_law.sk_documents.failed", {
        caseNumber: decision.caseNumber,
        url: decision.documentUrl ?? "",
        errorType: errorTag(error),
      });
    }
  }

  logger.info("case_law.sk_documents.swept", {
    attempted: pending.length,
    ...counts,
  });
};
