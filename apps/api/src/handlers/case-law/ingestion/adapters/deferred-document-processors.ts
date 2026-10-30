/**
 * Complete document processors for adapters whose manifests declare a
 * `deferred` document stage. Each owns validation, parsing, telemetry and
 * persistence, so both the read-through and drain use the source's policy.
 *
 * Kept apart from `adapter-registry.ts` so the public read path reaches
 * only the deferred adapters, not every adapter module.
 */

import { skCourtsDocumentFetch } from "@/api/handlers/case-law/ingestion/adapters/sk-courts";
import { startProjectedRetentionCheck } from "@/api/handlers/case-law/ingestion/retention/retention-check";
import { projectSkCourtsDocument } from "@/api/handlers/case-law/ingestion/retention/sources/sk-courts-document";
import { detached } from "@/api/lib/analytics/capture";
import {
  DEFERRED_DOCUMENT_ADAPTER_KEYS,
  type DeferredDocumentAdapterKey,
} from "@/api/lib/legal-search/adapter-manifest";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import {
  type DecisionDocumentOutcome,
  fetchDecisionDocument,
  type FetchDecisionDocumentOptions,
  type SkDocumentRetentionCheck,
} from "@/api/lib/legal-search/sk-document-backfill";
import { withExceptionScope } from "@/api/lib/observability/exception-scope";

/**
 * The drain stores Slovak documents outside the pipeline, so it starts the
 * pipeline's retention check itself, against the PDF it downloaded, and
 * goes on without waiting for it.
 */
const skCourtsDocumentRetention: SkDocumentRetentionCheck = ({
  blocks,
  decision,
  pdfBytes,
}) => {
  detached(
    startProjectedRetentionCheck({
      adapterKey: ADAPTER_KEYS.SK_COURTS,
      subject: {
        caseNumber: decision.caseNumber,
        language: "sk",
        url: decision.documentUrl ?? undefined,
      },
      project: async () => await projectSkCourtsDocument(pdfBytes),
      blocks,
    }),
    "case-law.sk-document-retention-check",
  );
};

type DeferredDocumentProcessor = (
  options: Omit<
    FetchDecisionDocumentOptions,
    "fetchDocument" | "checkRetention"
  >,
) => Promise<DecisionDocumentOutcome>;

export const DEFERRED_DOCUMENT_PROCESSORS = {
  [ADAPTER_KEYS.SK_COURTS]: async (options) =>
    await withExceptionScope(
      { type: "ingestion", adapterKey: ADAPTER_KEYS.SK_COURTS },
      async () =>
        await fetchDecisionDocument({
          ...options,
          fetchDocument: skCourtsDocumentFetch,
          checkRetention: skCourtsDocumentRetention,
        }),
    ),
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
