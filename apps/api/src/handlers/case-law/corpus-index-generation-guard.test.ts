import { describe, expect, mock, test } from "bun:test";

import type { ScopedDb } from "@/api/db/safe-db";
import { createCaseLawIncrementalBackfill } from "@/api/handlers/case-law/corpus-index";

const scopedDb: ScopedDb = async () => {
  throw new Error("unexpected database access");
};

describe("case-law incremental generation guard", () => {
  test("makes an older writer fail closed once a newer rebuild exists", async () => {
    const backfill = mock(async () => 1);
    const guarded = createCaseLawIncrementalBackfill({
      backfill,
      newestRebuildGeneration: async () => "case_law_v3",
    });

    const outcome = await guarded(scopedDb, 50, "case_law_v2").then(
      () => null,
      (error: unknown) => error,
    );

    expect(outcome).toBeInstanceOf(Error);
    expect(backfill).not.toHaveBeenCalled();
  });

  test("allows the current rebuild generation and the initial generation", async () => {
    const backfill = mock(async () => 7);
    const newestRebuildGeneration = mock(async () => null as string | null);
    const guarded = createCaseLawIncrementalBackfill({
      backfill,
      newestRebuildGeneration,
    });

    expect(await guarded(scopedDb, 50, "case_law_v1")).toBe(7);
    newestRebuildGeneration.mockImplementation(async () => "case_law_v2");
    expect(await guarded(scopedDb, 50, "case_law_v2")).toBe(7);
    expect(backfill).toHaveBeenCalledTimes(2);
  });
});
