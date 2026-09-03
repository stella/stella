import { expect, test } from "bun:test";
import nodePath from "node:path";

import { searchLegislationHandler } from "@/api/handlers/legislation/search";
import { encodeCorpusSearchCursor } from "@/api/lib/legal-search/corpus-search-cursor";
import type { LegislationReadDb } from "@/api/lib/legislation-public-read-db";

const DOCUMENT_ID = "6b1d2f34-58aa-4d1c-9d0f-2c3b4a5e6f70";

/**
 * A database that refuses to be read. Both search paths begin by reading
 * through one, so a call here would mean the cursor got past the boundary.
 */
const unreachableDb = () => {
  let reads = 0;
  const db: LegislationReadDb = async () => {
    reads += 1;
    // Never resolves to a transaction, because no test below lets it be
    // called: the assertion is that the boundary answered first.
    throw new Error("a search path read the database");
  };
  return { db, reads: () => reads };
};

const CASE_LAW_CURSOR = encodeCorpusSearchCursor({
  dictionary: { contentHash: "a".repeat(64), type: "dictionary" },
  id: DOCUMENT_ID,
  score: 0.5,
  windowStart: 0,
});

// The legislation corpus is never expanded, so a cursor naming a dictionary
// came from an expanded case-law search: its score, id and window bound a
// ranking of other documents entirely. The database would throw if either
// search path started, so the refusal is proven to cost nothing as well as to
// happen.
test("a cursor naming a dictionary is refused, and reads nothing", async () => {
  const { db, reads } = unreachableDb();

  const result = await searchLegislationHandler(
    { cursor: CASE_LAW_CURSOR, query: "nájemné" },
    db,
  );

  expect(result).not.toHaveProperty("hits");
  expect(result).toMatchObject({
    code: 400,
    response: { message: "Invalid cursor" },
  });
  expect(reads()).toBe(0);
});

// What makes the test above cover the corpus-index path and the pg-fts path
// alike: the identity is checked before the provider is consulted, so neither
// path can be the one that accepts a case-law cursor. A guard that moved below
// the branch would have to be proven twice, once per provider, and the
// provider is not switchable from a test.
test("the identity is checked before either search path is chosen", async () => {
  const source = await Bun.file(
    nodePath.resolve(import.meta.dir, "search.ts"),
  ).text();
  const guard = source.indexOf("isStaleCorpusSearchCursor(");
  const providerBranch = source.indexOf("envBase.LEGAL_SEARCH_PROVIDER");

  expect(guard).toBeGreaterThan(-1);
  expect(providerBranch).toBeGreaterThan(-1);
  expect(guard).toBeLessThan(providerBranch);
});
