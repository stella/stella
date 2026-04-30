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

  test("ignores malformed ingestion markers", () => {
    expect(
      getCaseLawIngestionMetadata({
        ingestion: {
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
