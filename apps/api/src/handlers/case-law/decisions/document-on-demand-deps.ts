/**
 * Database wiring for the read-through document fetch.
 *
 * Split from `document-on-demand.ts` so that module — and the tests
 * that drive its concurrency bounds — stay free of the connection
 * pools this one reaches. Only the read handler imports it, and the
 * handle itself is resolved on first use rather than at import.
 */

import {
  recordDocumentPacingOutcome,
  type OnDemandDocumentDeps,
} from "@/api/handlers/case-law/decisions/document-on-demand";
import { DEFERRED_DOCUMENT_PROCESSORS } from "@/api/handlers/case-law/ingestion/adapters/deferred-document-processors";
import { withImmediatePublisherSlot } from "@/api/handlers/case-law/ingestion/adapters/publisher-policy";
import { getCaseLawIngestionDb } from "@/api/lib/case-law-ingestion-db";
import {
  DOCUMENT_FETCH_BUDGET_MS,
  recordDocumentFetchRequest,
} from "@/api/lib/legal-search/sk-document-backfill";
import { withTimeout } from "@/api/lib/with-timeout";

export const onDemandDocumentDeps: OnDemandDocumentDeps = {
  recordRequest: async (decisionId) =>
    // Bounded on its own: the read budget abandons rather than cancels,
    // and an abandoned recording must not sit on a stalled pool forever.
    await withTimeout(
      async () =>
        await recordDocumentFetchRequest(decisionId, getCaseLawIngestionDb()),
      { label: "caseLaw.recordDocumentFetchRequest", timeoutMs: 15_000 },
    ),
  recordPacingOutcome: recordDocumentPacingOutcome,
  withFetchBudget: async (adapterKey, operation) =>
    await withImmediatePublisherSlot({ adapterKey, operation }),
  fetchDocument: async (decision, adapterKey) =>
    await DEFERRED_DOCUMENT_PROCESSORS[adapterKey]({
      decisionId: decision.id,
      scopedDb: getCaseLawIngestionDb(),
      // The unit races its own wall-clock budget; the signal aborts the download.
      signal: AbortSignal.timeout(DOCUMENT_FETCH_BUDGET_MS),
    }),
};
