import { describe, expect, test } from "bun:test";

import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { sourceRegistryMembership } from "@/api/lib/legal-search/source-registry-membership";

describe("sourceRegistryMembership", () => {
  test("every registry key resolves to itself, in both directions", () => {
    const keys = Object.values(ADAPTER_KEYS);

    // Compares the produced memberships, not a filter over the input: a
    // resolver that returned the wrong key for some entry would pass a
    // filter-and-count check and fail this one.
    expect(keys.map((key) => sourceRegistryMembership(key))).toEqual(
      keys.map((key) => ({ type: "registered", adapterKey: key })),
    );
    expect(keys.length).toBeGreaterThan(0);
  });

  test("a key that is not in the registry is unrecognized, not defaulted", () => {
    // The shapes that actually occur: a retired adapter, a seeded fixture
    // source, and a per-test synthetic key. None of them may resolve to a
    // registered adapter, and none of them is an error the read can throw on.
    for (const key of [
      "cz-ostrava",
      "cz_ns",
      `replay-${Bun.randomUUIDv7()}`,
      "",
    ]) {
      expect(sourceRegistryMembership(key)).toEqual({ type: "unrecognized" });
    }
  });

  test("a registered result carries the key it matched", () => {
    expect(sourceRegistryMembership(ADAPTER_KEYS.CZ_NS)).toEqual({
      type: "registered",
      adapterKey: ADAPTER_KEYS.CZ_NS,
    });
  });
});
