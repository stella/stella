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

export const onDemandDocumentDeps: OnDemandDocumentDeps = {
  recordRequest: async (decisionId) =>
    await recordDocumentFetchRequest(decisionId, getCaseLawIngestionDb()),
  fetchDocument: async (decision) =>
    await fetchDecisionDocument({
      decision,
      scopedDb: getCaseLawIngestionDb(),
      // The unit races its own wall-clock budget; the signal aborts the
      // download inside it, which is the part that can be cancelled.
      signal: AbortSignal.timeout(DOCUMENT_FETCH_BUDGET_MS),
    }),
};
