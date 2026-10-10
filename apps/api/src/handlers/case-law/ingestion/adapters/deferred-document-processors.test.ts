import { panic, Result, TaggedError } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  listAdapters,
  listDeferredDocumentDrains,
} from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import { DEFERRED_DOCUMENT_PROCESSORS } from "@/api/handlers/case-law/ingestion/adapters/deferred-document-processors";
import { toSafeId } from "@/api/lib/branded-types";
import {
  DEFERRED_DOCUMENT_ADAPTER_KEYS,
  isDeferredDocumentAdapterKey,
} from "@/api/lib/legal-search/adapter-manifest";

class ProcessorDatabaseProbeError extends TaggedError(
  "ProcessorDatabaseProbeError",
)<{
  message: string;
}> {}

describe("deferred-document adapters", () => {
  test("every registry processor enters the durable document operation before fetching", async () => {
    for (const {
      adapterKey,
      processDocument,
    } of listDeferredDocumentDrains()) {
      const observedSources = new Set<string>();
      const failure = new ProcessorDatabaseProbeError({
        message: "Document database unavailable",
      });
      const result = await Result.tryPromise({
        try: async () =>
          await processDocument({
            decisionId: toSafeId<"caseLawDecision">("processor-probe"),
            onDocumentObservation: ({ source }) => {
              observedSources.add(source);
            },
            scopedDb: async () => {
              throw failure;
            },
            signal: new AbortController().signal,
          }),
        catch: (error) => error,
      });
      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error).toBe(failure);
      }
      expect([...observedSources]).toEqual([adapterKey]);
    }
  });

  test("the read-through and drain sets follow every registered adapter's document stage", () => {
    const drains = listDeferredDocumentDrains();
    const drainsOf = (key: string) =>
      drains.filter(({ adapterKey }) => adapterKey === key);

    for (const adapter of listAdapters()) {
      switch (adapter.documentStage) {
        case "deferred":
          expect(isDeferredDocumentAdapterKey(adapter.key)).toBe(true);
          expect(drainsOf(adapter.key)).toHaveLength(1);
          break;
        case "inline":
          expect(isDeferredDocumentAdapterKey(adapter.key)).toBe(false);
          expect(drainsOf(adapter.key)).toHaveLength(0);
          break;
        default: {
          adapter.documentStage satisfies never;
          panic("Unexpected adapter document stage");
        }
      }
    }
  });

  test("every deferred key is a registered adapter with its own complete processor", () => {
    const registered = new Set(listAdapters().map(({ key }) => key));
    expect(DEFERRED_DOCUMENT_ADAPTER_KEYS.length).toBeGreaterThan(0);
    expect(Object.keys(DEFERRED_DOCUMENT_PROCESSORS).toSorted()).toEqual(
      [...DEFERRED_DOCUMENT_ADAPTER_KEYS].toSorted(),
    );
    for (const {
      adapterKey,
      processDocument,
    } of listDeferredDocumentDrains()) {
      expect(registered.has(adapterKey)).toBe(true);
      expect(processDocument).toBe(DEFERRED_DOCUMENT_PROCESSORS[adapterKey]);
    }
  });
});
