import { describe, expect, test } from "bun:test";

import { adapterEditionOf } from "@/api/lib/legal-search/adapter-manifest";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { stuckSyncIssue } from "@/api/scripts/adapter-stuck";

describe("stuck sync detection", () => {
  test("a live source silent past the threshold is stuck", () => {
    expect(
      stuckSyncIssue({
        edition: adapterEditionOf(ADAPTER_KEYS.CZ_NS),
        enabled: true,
        hoursSinceSync: 48,
      }),
    ).toBe("Stuck: no sync in 48h");
  });

  // A fixed snapshot read to its end asks nothing again; its silence is the
  // finished state, so it is never reported as stuck.
  test("a snapshot source is never stuck however long it is silent", () => {
    expect(adapterEditionOf(ADAPTER_KEYS.PL_NSA)?.type).toBe("snapshot");
    expect(
      stuckSyncIssue({
        edition: adapterEditionOf(ADAPTER_KEYS.PL_NSA),
        enabled: true,
        hoursSinceSync: 24 * 365,
      }),
    ).toBeNull();
  });

  test("an unknown adapter key is judged as a live source", () => {
    expect(adapterEditionOf("retired-adapter")).toBeNull();
    expect(
      stuckSyncIssue({ edition: null, enabled: true, hoursSinceSync: 13 }),
    ).toBe("Stuck: no sync in 13h");
  });

  test("a disabled source or one never synced is not stuck", () => {
    const edition = adapterEditionOf(ADAPTER_KEYS.CZ_NS);
    expect(
      stuckSyncIssue({ edition, enabled: false, hoursSinceSync: 48 }),
    ).toBeNull();
    expect(
      stuckSyncIssue({ edition, enabled: true, hoursSinceSync: null }),
    ).toBeNull();
  });
});
