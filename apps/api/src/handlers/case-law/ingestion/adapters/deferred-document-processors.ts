/**
 * Complete document processors for adapters whose manifests declare a
 * `deferred` document stage. Each owns validation, parsing, telemetry and
 * persistence, so both the read-through and drain use the source's policy.
 *
 * Kept apart from `adapter-registry.ts` so the public read path reaches
 * only the deferred adapters, not every adapter module.
 */

import { skCourtsDocumentFetch } from "@/api/handlers/case-law/ingestion/adapters/sk-courts";
import {
  DEFERRED_DOCUMENT_ADAPTER_KEYS,
  type DeferredDocumentAdapterKey,
} from "@/api/lib/legal-search/adapter-manifest";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import {
  type DecisionDocumentOutcome,
  type FetchDecisionDocumentOptions,
  fetchDecisionDocument,
} from "@/api/lib/legal-search/sk-document-backfill";

type DeferredDocumentProcessor = (
  options: Omit<FetchDecisionDocumentOptions, "fetchDocument">,
) => Promise<DecisionDocumentOutcome>;

export const DEFERRED_DOCUMENT_PROCESSORS = {
  [ADAPTER_KEYS.SK_COURTS]: async (options) =>
    await fetchDecisionDocument({
      ...options,
      fetchDocument: skCourtsDocumentFetch,
    }),
} as const satisfies Record<
  DeferredDocumentAdapterKey,
  DeferredDocumentProcessor
>;

/** One drain per deferred-stage adapter, in manifest order. */
export const listDeferredDocumentDrains = () =>
  DEFERRED_DOCUMENT_ADAPTER_KEYS.map((adapterKey) => ({
    adapterKey,
    processDocument: DEFERRED_DOCUMENT_PROCESSORS[adapterKey],
  }));
