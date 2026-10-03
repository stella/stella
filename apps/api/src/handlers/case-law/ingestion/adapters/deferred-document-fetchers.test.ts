import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  listAdapters,
  listDeferredDocumentDrains,
} from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import { DEFERRED_DOCUMENT_FETCHERS } from "@/api/handlers/case-law/ingestion/adapters/deferred-document-fetchers";
import {
  DEFERRED_DOCUMENT_ADAPTER_KEYS,
  isDeferredDocumentAdapterKey,
} from "@/api/lib/legal-search/adapter-manifest";

describe("deferred-document adapters", () => {
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

  test("every deferred key is a registered adapter with its own fetcher", () => {
    const registered = new Set(listAdapters().map(({ key }) => key));
    expect(DEFERRED_DOCUMENT_ADAPTER_KEYS.length).toBeGreaterThan(0);
    expect(Object.keys(DEFERRED_DOCUMENT_FETCHERS).toSorted()).toEqual(
      [...DEFERRED_DOCUMENT_ADAPTER_KEYS].toSorted(),
    );
    for (const { adapterKey, fetchDocument } of listDeferredDocumentDrains()) {
      expect(registered.has(adapterKey)).toBe(true);
      expect(fetchDocument).toBe(DEFERRED_DOCUMENT_FETCHERS[adapterKey]);
    }
  });
});
