import { describe, expect, test } from "bun:test";

import { encodePlNsaCursor } from "@/api/handlers/case-law/ingestion/adapters/pl-nsa-cursor";
import { PL_NSA_SNAPSHOT } from "@/api/handlers/case-law/ingestion/adapters/pl-nsa-dataset";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import {
  SOURCE_SYNC_PROGRESS,
  sourceSyncProgress,
  stuckSyncIssue,
} from "@/api/scripts/adapter-stuck";

describe("stuck sync detection", () => {
  test("a live source silent past the threshold is stuck", () => {
    expect(
      stuckSyncIssue({
        progress: SOURCE_SYNC_PROGRESS.ONGOING,
        enabled: true,
        hoursSinceSync: 48,
      }),
    ).toBe("Stuck: no sync in 48h");
  });

  // A fixed snapshot read to its end asks nothing again; its silence is the
  // finished state, so it is never reported as stuck.
  test("a completed snapshot source is not stuck however long it is silent", () => {
    expect(
      stuckSyncIssue({
        progress: sourceSyncProgress({
          adapterKey: ADAPTER_KEYS.PL_NSA,
          syncCursor: encodePlNsaCursor(
            { shard: PL_NSA_SNAPSHOT.shards.length, row: 0 },
            PL_NSA_SNAPSHOT,
          ),
        }),
        enabled: true,
        hoursSinceSync: 24 * 365,
      }),
    ).toBeNull();
  });

  test.each([
    null,
    "invalid",
    encodePlNsaCursor({ shard: 0, row: 1 }, PL_NSA_SNAPSHOT),
    encodePlNsaCursor(
      { shard: PL_NSA_SNAPSHOT.shards.length + 1, row: 0 },
      PL_NSA_SNAPSHOT,
    ),
    encodePlNsaCursor(
      { shard: PL_NSA_SNAPSHOT.shards.length, row: 1 },
      PL_NSA_SNAPSHOT,
    ),
  ])(
    "an unfinished or invalid snapshot cursor %s remains alertable",
    (syncCursor) => {
      expect(
        stuckSyncIssue({
          progress: sourceSyncProgress({
            adapterKey: ADAPTER_KEYS.PL_NSA,
            syncCursor,
          }),
          enabled: true,
          hoursSinceSync: 13,
        }),
      ).toBe("Stuck: no sync in 13h");
    },
  );

  test("an unknown adapter key is judged as a live source", () => {
    expect(
      stuckSyncIssue({
        progress: sourceSyncProgress({
          adapterKey: "retired-adapter",
          syncCursor: null,
        }),
        enabled: true,
        hoursSinceSync: 13,
      }),
    ).toBe("Stuck: no sync in 13h");
  });

  test("a disabled source or one never synced is not stuck", () => {
    const progress = SOURCE_SYNC_PROGRESS.ONGOING;
    expect(
      stuckSyncIssue({ progress, enabled: false, hoursSinceSync: 48 }),
    ).toBeNull();
    expect(
      stuckSyncIssue({ progress, enabled: true, hoursSinceSync: null }),
    ).toBeNull();
  });
});
