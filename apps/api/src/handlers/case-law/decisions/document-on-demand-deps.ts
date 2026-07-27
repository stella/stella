/**
 * Database wiring for the read-through document fetch.
 *
 * Split from `document-on-demand.ts` so that module — and the tests
 * that drive its concurrency bounds — stay free of the connection
 * pools this one reaches. Only the read handler imports it, and the
 * handle itself is resolved on first use rather than at import.
 */

import type { OnDemandDocumentDeps } from "@/api/handlers/case-law/decisions/document-on-demand";
import {
  DOCUMENT_FETCH_BUDGET_MS,
  fetchDecisionDocument,
  recordDocumentFetchRequest,
} from "@/api/handlers/case-law/ingestion/sk-document-backfill";
import { getCaseLawIngestionDb } from "@/api/lib/case-law-ingestion-db";
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
  fetchDocument: async (decision) =>
    await fetchDecisionDocument({
      decision,
      scopedDb: getCaseLawIngestionDb(),
      // The unit races its own wall-clock budget; the signal aborts the
      // download inside it, which is the part that can be cancelled.
      signal: AbortSignal.timeout(DOCUMENT_FETCH_BUDGET_MS),
    }),
};
