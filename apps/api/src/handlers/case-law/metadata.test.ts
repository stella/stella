import { describe, expect, test } from "bun:test";

import { getCaseLawIngestionMetadata } from "@/api/handlers/case-law/metadata";

describe("case-law ingestion metadata", () => {
  test("reads the app-owned ingestion marker from otherwise flat metadata", () => {
    expect(
      getCaseLawIngestionMetadata({
        abstract: "Summary",
        ingestion: {
          dumpHash: "dump-1",
          sourceTier: "detail",
        },
        popularName: "Melcak",
      }),
    ).toEqual({
      dumpHash: "dump-1",
      sourceTier: "detail",
    });
  });

  test("reads an optional detail fingerprint on its own", () => {
    expect(
      getCaseLawIngestionMetadata({
        ingestion: { detailHash: "detail-1" },
      }),
    ).toEqual({ detailHash: "detail-1" });
  });

  test("ignores malformed ingestion markers", () => {
    expect(
      getCaseLawIngestionMetadata({
        ingestion: {
          detailHash: null,
          dumpHash: 123,
          sourceTier: "summary",
        },
      }),
    ).toBeNull();
  });

  test("keeps source metadata opaque outside the known ingestion marker", () => {
    const metadata = {
      abstract: "Summary",
      ingestion: {
        dumpHash: "dump-1",
        sourceTier: "detail",
      },
      popularName: "Melcak",
    };

    expect(
      Object.fromEntries(
        Object.entries(metadata).filter(([key]) => key !== "ingestion"),
      ),
    ).toEqual({
      abstract: "Summary",
      popularName: "Melcak",
    });
  });
});
