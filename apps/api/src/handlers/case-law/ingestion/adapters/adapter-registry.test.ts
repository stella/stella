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
import {
  ADAPTER_KEYS,
  type AdapterKey,
} from "@/api/lib/legal-search/ingestion-constants";

/**
 * The adapters allowed to answer `reconciliation` with `unsupported`, as an
 * exact list rather than a ceiling.
 *
 * Exact in both directions on purpose. A name appearing here that nobody put
 * there means a new adapter shipped without the capability, and a name here
 * that no longer declares `unsupported` means the capability landed and the
 * exemption outlived it. Neither may pass quietly, so the test compares sets
 * and prints the remedy for whichever side moved.
 */
const RECONCILIATION_UNSUPPORTED_ADAPTERS = [ADAPTER_KEYS.AT_COURTS] as const;

describe("case-law adapter capabilities", () => {
  test("every registered adapter exposes a total count", () => {
    // The type makes an omission uncompilable; this is the registry-level
    // half, so an adapter reaching the registry through a widened type still
    // has to carry a callable.
    const missing = listAdapters().flatMap((adapter) =>
      typeof adapter.getTotalCount === "function"
        ? []
        : [
            `${adapter.key} declares no getTotalCount; every adapter must implement it`,
          ],
    );
    expect(missing).toEqual([]);
  });

  test("only the pinned adapters answer reconciliation with unsupported", () => {
    const declaredUnsupported = listAdapters().flatMap((adapter) =>
      adapter.reconciliation.type === "unsupported" ? [adapter.key] : [],
    );
    const pinned: readonly AdapterKey[] = RECONCILIATION_UNSUPPORTED_ADAPTERS;

    const unexpected = declaredUnsupported.flatMap((key) =>
      pinned.includes(key)
        ? []
        : [
            `${key} declares reconciliation unsupported; a new adapter must implement the capability, not join this list`,
          ],
    );
    expect(unexpected).toEqual([]);

    const stale = pinned.flatMap((key) =>
      declaredUnsupported.includes(key)
        ? []
        : [
            `${key} now implements reconciliation; remove ${key} from this list and delete ReconciliationUnsupported if the list is empty`,
          ],
    );
    expect(stale).toEqual([]);
  });

  test("every reconcilable adapter states a walkable slice order", () => {
    for (const adapter of listAdapters()) {
      const { reconciliation } = adapter;
      if (reconciliation.type === "unsupported") {
        expect(reconciliation.reason.length).toBeGreaterThan(0);
        continue;
      }
      // Exercised, not merely present: a capability whose first slice does not
      // sort before its tip has no walk order for the ledger to compare on.
      expect(reconciliation.firstSlice.length).toBeGreaterThan(0);
      expect(
        reconciliation.previousSlice(reconciliation.firstSlice),
      ).toBeNull();
      expect(reconciliation.tipWindowDays).toBeGreaterThan(0);
      expect(
        reconciliation.sliceOf(new Date()) >= reconciliation.firstSlice,
      ).toBe(true);
    }
  });
});

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
