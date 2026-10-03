/**
 * The document fetch of every adapter whose manifest declares a
 * `deferred` document stage. Total over that key set, so declaring a
 * source deferred does not compile until it supplies the fetch the
 * read-through and the drain run.
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
import type { SkDocumentFetch } from "@/api/lib/legal-search/sk-document-backfill";

export const DEFERRED_DOCUMENT_FETCHERS = {
  [ADAPTER_KEYS.SK_COURTS]: skCourtsDocumentFetch,
} as const satisfies Record<DeferredDocumentAdapterKey, SkDocumentFetch>;

/** One drain per deferred-stage adapter, in manifest order. */
export const listDeferredDocumentDrains = () =>
  DEFERRED_DOCUMENT_ADAPTER_KEYS.map((adapterKey) => ({
    adapterKey,
    fetchDocument: DEFERRED_DOCUMENT_FETCHERS[adapterKey],
  }));
