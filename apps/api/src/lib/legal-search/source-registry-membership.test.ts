import { describe, expect, test } from "bun:test";

import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { sourceRegistryMembership } from "@/api/lib/legal-search/source-registry-membership";

describe("sourceRegistryMembership", () => {
  test("every registry key resolves as registered, in both directions", () => {
    const keys = Object.values(ADAPTER_KEYS);
    const registered = keys.filter(
      (key) => sourceRegistryMembership(key).type === "registered",
    );

    // Both directions: every registry key is recognized, and the count matches,
    // so a key silently dropped from the registry cannot leave this passing.
    expect(registered).toEqual(keys);
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
