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
import { createIngestionDb } from "@/api/db/scoped";
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

  let filled = 0;
  let unavailable = 0;
  let failed = 0;

  for (const decision of pending) {
    // eslint-disable-next-line typescript/no-unnecessary-condition -- AbortSignal can flip between scheduler awaits.
    if (signal.aborted || !decision.documentUrl) {
      break;
    }

    try {
      // oxlint-disable-next-line no-await-in-loop -- rate-limited court downloads run one at a time by design
      const pdfBytes = await fetchPdfBytes(decision.documentUrl, signal);
      const document = pdfBytes
        ? // oxlint-disable-next-line no-await-in-loop -- parse depends on the fetch above
          await parsePendingDocument(decision, pdfBytes)
        : undefined;

      if (!document) {
        // oxlint-disable-next-line no-await-in-loop -- sequential per decision
        await markDocumentUnavailable(decision.id, scopedDb);
        unavailable++;
        continue;
      }

      // oxlint-disable-next-line no-await-in-loop -- sequential per decision
      await storeBackfilledDocument(decision.id, document, scopedDb);
      filled++;
    } catch (error) {
      // Leave fulltext NULL so a transient failure is retried, unlike
      // an unparseable document which is marked and moved past.
      failed++;
      logger.warn("case_law.sk_documents.failed", {
        caseNumber: decision.caseNumber,
        url: decision.documentUrl,
        errorType: errorTag(error),
      });
    }

    // eslint-disable-next-line typescript/no-unnecessary-condition -- AbortSignal can flip between scheduler awaits.
    if (!signal.aborted) {
      // oxlint-disable-next-line no-await-in-loop -- deliberate crawl delay between downloads
      await Bun.sleep(FETCH_DELAY_MS);
    }
  }

  logger.info("case_law.sk_documents.swept", {
    attempted: pending.length,
    filled,
    unavailable,
    failed,
  });
};
