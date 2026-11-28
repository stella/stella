import type { DeferredDocumentAdapterKey } from "@stll/case-law-ingestion-core/adapter-manifest";
import { ADAPTER_KEYS } from "@stll/case-law-ingestion-core/ingestion-constants";

/** Ownership contract for every adapter that defers document persistence. */
export const DEFERRED_DOCUMENT_WRITER_CAPABILITIES = {
  [ADAPTER_KEYS.SK_COURTS]: {
    ownership: "decision-merge-fence",
    writer: "fetchDecisionDocument",
  },
} as const satisfies Record<
  DeferredDocumentAdapterKey,
  {
    ownership: "decision-merge-fence";
    writer: "fetchDecisionDocument";
  }
>;
