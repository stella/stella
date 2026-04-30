import { describe, expect, test } from "bun:test";

import { normalizeClauseMetadata } from "@/api/handlers/clauses/metadata";

describe("clause metadata", () => {
  test("wraps arbitrary clause metadata in a versioned custom envelope", () => {
    expect(normalizeClauseMetadata({ reviewer: "Ada", score: 3 })).toEqual({
      version: 1,
      custom: {
        reviewer: "Ada",
        score: 3,
      },
    });
  });

  test("keeps existing versioned metadata stable", () => {
    expect(
      normalizeClauseMetadata({
        version: 1,
        custom: { source: "import" },
      }),
    ).toEqual({
      version: 1,
      custom: { source: "import" },
    });
  });

  test("preserves legacy top-level keys on versioned metadata", () => {
    expect(
      normalizeClauseMetadata({
        version: 1,
        custom: { source: "import" },
        reviewer: "Ada",
      }),
    ).toEqual({
      version: 1,
      custom: {
        reviewer: "Ada",
        source: "import",
      },
    });
  });
});
