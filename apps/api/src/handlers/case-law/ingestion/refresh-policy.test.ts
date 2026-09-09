import { describe, expect, test } from "bun:test";

import { shouldSkipRefresh } from "@/api/handlers/case-law/ingestion/refresh-policy";

type IngestionMetadataOptions = {
  detailHash?: string | undefined;
  dumpHash?: string | undefined;
  sourceTier: "dump" | "detail";
};

const ingestionMetadata = ({
  detailHash,
  dumpHash = "dump-hash",
  sourceTier,
}: IngestionMetadataOptions): Record<string, unknown> => ({
  ingestion: {
    sourceTier,
    dumpHash,
    ...(detailHash === undefined ? {} : { detailHash }),
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
        existingMetadata: ingestionMetadata({ sourceTier: "dump" }),
        existingSourceHash: "same-hash",
        incomingMetadata: ingestionMetadata({
          detailHash: "detail-hash",
          sourceTier: "detail",
        }),
        incomingRawHash: "same-hash",
      }),
    ).toBe(false);
  });

  test("refreshes detail content when its fingerprint changes", () => {
    expect(
      shouldSkipRefresh({
        existingMetadata: ingestionMetadata({
          detailHash: "old-detail-hash",
          sourceTier: "detail",
        }),
        existingSourceHash: "same-hash",
        incomingMetadata: ingestionMetadata({
          detailHash: "new-detail-hash",
          sourceTier: "detail",
        }),
        incomingRawHash: "same-hash",
      }),
    ).toBe(false);
  });

  test("refreshes detail content when the stored fingerprint is missing", () => {
    expect(
      shouldSkipRefresh({
        existingMetadata: ingestionMetadata({ sourceTier: "detail" }),
        existingSourceHash: "same-hash",
        incomingMetadata: ingestionMetadata({
          detailHash: "detail-hash",
          sourceTier: "detail",
        }),
        incomingRawHash: "same-hash",
      }),
    ).toBe(false);
  });

  test("skips detail content whose fingerprint is unchanged", () => {
    expect(
      shouldSkipRefresh({
        existingMetadata: ingestionMetadata({
          detailHash: "detail-hash",
          sourceTier: "detail",
        }),
        existingSourceHash: "same-hash",
        incomingMetadata: ingestionMetadata({
          detailHash: "detail-hash",
          sourceTier: "detail",
        }),
        incomingRawHash: "same-hash",
      }),
    ).toBe(true);
  });

  test("allows unchanged content to upgrade to verbatim raw storage", () => {
    expect(
      shouldSkipRefresh({
        existingMetadata: {},
        existingSourceRawContentType: "application/xhtml+xml",
        existingSourceHash: "same-hash",
        incomingMetadata: {},
        incomingRawHash: "same-hash",
        incomingSourceRawContentType:
          "application/xhtml+xml; stella-storage=verbatim",
        incomingUsesSourceRawBytes: true,
      }),
    ).toBe(false);
  });

  test("skips unchanged content after the raw storage upgrade", () => {
    const verbatimContentType =
      "application/xhtml+xml; stella-storage=verbatim";
    expect(
      shouldSkipRefresh({
        existingMetadata: {},
        existingSourceRawContentType: verbatimContentType,
        existingSourceHash: "same-hash",
        incomingMetadata: {},
        incomingRawHash: "same-hash",
        incomingSourceRawContentType: verbatimContentType,
        incomingUsesSourceRawBytes: true,
      }),
    ).toBe(true);
  });

  test("skips a transient downgrade from detail-rich to dump-only content", () => {
    expect(
      shouldSkipRefresh({
        existingMetadata: ingestionMetadata({
          detailHash: "detail-hash",
          sourceTier: "detail",
        }),
        existingSourceHash: "dump-hash",
        incomingMetadata: ingestionMetadata({ sourceTier: "dump" }),
        incomingRawHash: "dump-hash",
      }),
    ).toBe(true);
  });

  test("allows a lower-tier refresh when the dump payload changed", () => {
    expect(
      shouldSkipRefresh({
        existingMetadata: ingestionMetadata({
          detailHash: "detail-hash",
          dumpHash: "old-dump-hash",
          sourceTier: "detail",
        }),
        existingSourceHash: "detail-hash",
        incomingMetadata: ingestionMetadata({
          dumpHash: "new-dump-hash",
          sourceTier: "dump",
        }),
        incomingRawHash: "dump-hash",
      }),
    ).toBe(false);
  });

  test("allows a downgrade-shaped refresh when an S3 retry is pending", () => {
    expect(
      shouldSkipRefresh({
        existingMetadata: ingestionMetadata({
          detailHash: "detail-hash",
          sourceTier: "detail",
        }),
        existingSourceHash: "stale-hash",
        incomingMetadata: ingestionMetadata({ sourceTier: "dump" }),
        incomingRawHash: "dump-hash",
      }),
    ).toBe(false);
  });
});
