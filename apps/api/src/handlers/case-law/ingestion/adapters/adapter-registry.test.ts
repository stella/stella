import { Panic } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  listAdapterKeys as listEagerAdapterKeys,
  listAdapters,
} from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import {
  ADAPTER_MODULES,
  listAdapterKeys as listLazyAdapterKeys,
  loadAdapterByKey,
} from "@/api/handlers/case-law/ingestion/adapters/adapter-registry-lazy";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";

describe("case-law adapter registries", () => {
  test("eager and lazy registries expose the same closed adapter set", () => {
    expect([...listEagerAdapterKeys()].toSorted()).toEqual(
      [...listLazyAdapterKeys()].toSorted(),
    );
    expect(
      listAdapters()
        .map((adapter) => adapter.key)
        .toSorted(),
    ).toEqual([...listLazyAdapterKeys()].toSorted());
  });

  test("lazy loading returns the adapter selected by the closed key", async () => {
    const keys = listLazyAdapterKeys();
    const adapters = await Promise.all(keys.map(loadAdapterByKey));
    expect(adapters.map((adapter) => adapter?.key)).toEqual([...keys]);
    expect(loadAdapterByKey("not-an-adapter")).resolves.toBeUndefined();
  });

  test("lazy loading rejects a module registered under the wrong key", async () => {
    const originalLoader = ADAPTER_MODULES[ADAPTER_KEYS.CZ_NS];
    Object.defineProperty(ADAPTER_MODULES, ADAPTER_KEYS.CZ_NS, {
      configurable: true,
      value: ADAPTER_MODULES[ADAPTER_KEYS.CZ_NSS],
    });

    try {
      const rejection: unknown = await loadAdapterByKey(
        ADAPTER_KEYS.CZ_NS,
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(rejection).toBeInstanceOf(Panic);
      expect(rejection).toMatchObject({
        message: "Adapter registry key mismatch for cz-ns",
      });
    } finally {
      Object.defineProperty(ADAPTER_MODULES, ADAPTER_KEYS.CZ_NS, {
        configurable: true,
        value: originalLoader,
      });
    }
  });
});
