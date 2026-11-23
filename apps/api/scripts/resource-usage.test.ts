import { describe, expect, test } from "bun:test";

import {
  BATCH_MEMORY,
  batchMemoryVerdict,
  maxRssBytesToMb,
  RSS_NEAR_CAP_RATIO,
  RSS_PLAN_DRIFT_RATIO,
} from "./resource-usage";
import { TEST_BATCH_RSS_HEADROOM_RATIO } from "./test-batch-plan";

describe("maxRssBytesToMb", () => {
  test("treats Bun subprocess maxRSS as bytes on Linux too", () => {
    // The Bun 1.4 Linux CI reading that the old platform branch reported as
    // 403,796 MB was a normal 394 MB byte count.
    expect(maxRssBytesToMb(413_487_104)).toBe(394);
  });
});

describe("batchMemoryVerdict", () => {
  const BUDGET_MB = 2560;
  const NEAR_CAP_MB = BUDGET_MB * RSS_NEAR_CAP_RATIO;
  const DRIFT_MB = BUDGET_MB * RSS_PLAN_DRIFT_RATIO;
  const SHARED = ["src/a.db.test.ts", "src/b.db.test.ts"];
  const verdict = (peakMb: number, testFiles: readonly string[] = SHARED) =>
    batchMemoryVerdict({
      label: "db batch 27/35",
      peakMb,
      budgetMb: BUDGET_MB,
      testFiles,
    });

  const expectedType = (peakMb: number, fileCount: number) => {
    if (peakMb > BUDGET_MB) {
      return BATCH_MEMORY.over;
    }
    if (peakMb >= NEAR_CAP_MB) {
      return BATCH_MEMORY.nearCap;
    }
    if (fileCount > 1 && peakMb >= DRIFT_MB) {
      return BATCH_MEMORY.planDrift;
    }
    return BATCH_MEMORY.within;
  };

  test("drift sits between the planned headroom and the near-cap warning", () => {
    expect(TEST_BATCH_RSS_HEADROOM_RATIO).toBeLessThan(RSS_PLAN_DRIFT_RATIO);
    expect(RSS_PLAN_DRIFT_RATIO).toBeLessThan(RSS_NEAR_CAP_RATIO);
  });

  test("classifies every peak by the cap, near-cap and drift ratios", () => {
    for (const testFiles of [["src/solo.db.test.ts"], SHARED]) {
      for (let peakMb = 0; peakMb <= BUDGET_MB + 64; peakMb += 1) {
        expect({
          peakMb,
          files: testFiles.length,
          type: verdict(peakMb, testFiles).type,
        }).toEqual({
          peakMb,
          files: testFiles.length,
          type: expectedType(peakMb, testFiles.length),
        });
      }
    }
  });

  test("the drift warning is a GitHub annotation pointing at the table refresh", () => {
    const result = verdict(2100);
    if (result.type !== BATCH_MEMORY.planDrift) {
      throw new Error(`expected plan drift, got ${result.type}`);
    }
    expect(result.annotation).toBe(
      "::warning title=API test batch above its memory plan::db batch 27/35 " +
        "peaked at 2100 MB of its 2560 MB budget (82%); refresh " +
        "apps/api/scripts/test-peak-rss.json (docs/test-memory.md); files: " +
        "src/a.db.test.ts, src/b.db.test.ts",
    );
  });

  test("a batch exactly at its budget still passes, with a warning", () => {
    expect(verdict(BUDGET_MB).type).toBe(BATCH_MEMORY.nearCap);
    expect(verdict(BUDGET_MB + 1).type).toBe(BATCH_MEMORY.over);
  });

  test("the near-cap warning is a GitHub annotation naming the batch and files", () => {
    const result = verdict(2400);
    if (result.type !== BATCH_MEMORY.nearCap) {
      throw new Error(`expected near-cap, got ${result.type}`);
    }
    expect(result.annotation).toBe(
      "::warning title=API test batch near its memory cap::db batch 27/35 " +
        "peaked at 2400 MB of its 2560 MB budget (94%); files: " +
        "src/a.db.test.ts, src/b.db.test.ts",
    );
    expect(result.annotation).not.toContain("\n");
  });

  test("an over-budget batch fails with the remediation message", () => {
    const result = verdict(2561);
    if (result.type !== BATCH_MEMORY.over) {
      throw new Error(`expected over, got ${result.type}`);
    }
    expect(result.message).toContain("exceeded the 2560 MB peak-RSS budget");
  });
});
