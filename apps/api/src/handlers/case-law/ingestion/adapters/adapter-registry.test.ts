import { describe, expect, test } from "bun:test";

import {
  listAdapterKeys as listEagerAdapterKeys,
  listAdapters,
} from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import {
  listAdapterKeys as listLazyAdapterKeys,
  loadAdapterByKey,
} from "@/api/handlers/case-law/ingestion/adapters/adapter-registry-lazy";

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
});
