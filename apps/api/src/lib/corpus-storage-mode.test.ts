import { describe, expect, test } from "bun:test";

import {
  corpusStorageInvariantViolation,
  resolveCorpusStorageMode,
} from "@/api/lib/corpus-storage-mode";

describe("resolveCorpusStorageMode", () => {
  test("derives the mode from the legacy boolean when unset", () => {
    expect(
      resolveCorpusStorageMode({ mode: undefined, legacyEnabled: true }),
    ).toBe("dual-write");
    expect(
      resolveCorpusStorageMode({ mode: undefined, legacyEnabled: false }),
    ).toBe("off");
  });

  test("an explicit mode wins over the legacy boolean, in both directions", () => {
    expect(
      resolveCorpusStorageMode({ mode: "canonical", legacyEnabled: false }),
    ).toBe("canonical");
    expect(resolveCorpusStorageMode({ mode: "off", legacyEnabled: true })).toBe(
      "off",
    );
  });
});

describe("corpusStorageInvariantViolation", () => {
  const deployed = {
    corpusBucket: "corpus",
    isDev: false,
    projectionOwner: "embedded",
  } as const;

  test("canonical without the corpus-index provider is rejected", () => {
    expect(
      corpusStorageInvariantViolation({
        ...deployed,
        mode: "canonical",
        searchProvider: "pg-fts",
      }),
    ).toContain("LEGAL_SEARCH_PROVIDER=corpus-index");

    expect(
      corpusStorageInvariantViolation({
        ...deployed,
        mode: "canonical",
        searchProvider: "corpus-index",
      }),
    ).toBeNull();
  });

  test("dual-write is allowed to serve from pg-fts", () => {
    expect(
      corpusStorageInvariantViolation({
        ...deployed,
        mode: "dual-write",
        projectionOwner: undefined,
        searchProvider: "pg-fts",
      }),
    ).toBeNull();
  });

  test("canonical requires an explicit projection owner", () => {
    expect(
      corpusStorageInvariantViolation({
        ...deployed,
        mode: "canonical",
        projectionOwner: undefined,
        searchProvider: "corpus-index",
      }),
    ).toContain("CORPUS_PROJECTION_OWNER");
  });

  test("canonical needs the corpus bucket exactly as dual-write does", () => {
    for (const mode of ["dual-write", "canonical"] as const) {
      expect(
        corpusStorageInvariantViolation({
          ...deployed,
          mode,
          searchProvider: "corpus-index",
          corpusBucket: undefined,
        }),
      ).toContain("LEGAL_CORPUS_S3_BUCKET");

      // Dev falls back to the default document bucket.
      expect(
        corpusStorageInvariantViolation({
          ...deployed,
          mode,
          searchProvider: "corpus-index",
          corpusBucket: undefined,
          isDev: true,
        }),
      ).toBeNull();
    }
  });

  test("off imposes no corpus requirements at all", () => {
    expect(
      corpusStorageInvariantViolation({
        mode: "off",
        projectionOwner: undefined,
        searchProvider: "pg-fts",
        corpusBucket: undefined,
        isDev: false,
      }),
    ).toBeNull();
  });
});
