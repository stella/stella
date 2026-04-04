import { describe, expect, test } from "bun:test";

import { shouldSkipRefresh } from "@/api/handlers/case-law/ingestion/refresh-policy";

const ingestionMetadata = (
  sourceTier: "dump" | "detail",
  dumpHash = "dump-hash",
): Record<string, unknown> => ({
  ingestion: {
    sourceTier,
    dumpHash,
  },
});

describe("shouldSkipRefresh", () => {
  test("skips exact duplicates without ingestion markers", () => {
    expect(
      shouldSkipRefresh({
        existingMetadata: {},
        existingSourceHash: "same-hash",
        incomingMetadata: {},
        incomingRawHash: "same-hash",
      }),
    ).toBe(true);
  });

  test("allows a dump-only decision to upgrade to detail-rich content", () => {
    expect(
      shouldSkipRefresh({
        existingMetadata: ingestionMetadata("dump"),
        existingSourceHash: "same-hash",
        incomingMetadata: ingestionMetadata("detail"),
        incomingRawHash: "same-hash",
      }),
    ).toBe(false);
  });

  test("skips a transient downgrade from detail-rich to dump-only content", () => {
    expect(
      shouldSkipRefresh({
        existingMetadata: ingestionMetadata("detail"),
        existingSourceHash: "dump-hash",
        incomingMetadata: ingestionMetadata("dump"),
        incomingRawHash: "dump-hash",
      }),
    ).toBe(true);
  });

  test("allows a lower-tier refresh when the dump payload changed", () => {
    expect(
      shouldSkipRefresh({
        existingMetadata: ingestionMetadata("detail", "old-dump-hash"),
        existingSourceHash: "detail-hash",
        incomingMetadata: ingestionMetadata("dump", "new-dump-hash"),
        incomingRawHash: "dump-hash",
      }),
    ).toBe(false);
  });

  test("allows a downgrade-shaped refresh when an S3 retry is pending", () => {
    expect(
      shouldSkipRefresh({
        existingMetadata: ingestionMetadata("detail"),
        existingSourceHash: "stale-hash",
        incomingMetadata: ingestionMetadata("dump"),
        incomingRawHash: "dump-hash",
      }),
    ).toBe(false);
  });
});
