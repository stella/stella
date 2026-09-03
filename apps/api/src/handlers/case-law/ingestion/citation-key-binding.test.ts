import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import nodePath from "node:path";

import {
  bareCitationKey,
  citationKeyOf,
} from "@/api/handlers/case-law/ingestion/citation-extractor";

/**
 * `citation_key` is written from two places — the ingestion pipeline and the
 * one-off backfill — and they once disagreed about what to store for a text
 * that does not canonicalize: one wrote NULL, the other the empty string. Two
 * rows carrying '' join each other on the resolver's equality predicate, so
 * that disagreement was not a cosmetic one; it drew edges between unrelated
 * cases.
 *
 * The disagreement is now impossible three ways over, and this file pins all
 * three: the value comes from one exported helper, no other module derives one
 * inline, and the database refuses the loser (asserted in
 * `citation-resolution.db.test.ts`, which is where a constraint can be
 * exercised).
 */

const API_SRC = nodePath.resolve(import.meta.dir, "../../..");

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = nodePath.join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(full);
    }
    return entry.isFile() && entry.name.endsWith(".ts") ? [full] : [];
  });

/**
 * Every non-test module under the API source tree, read once. The whole tree
 * rather than the case-law slice: a writer that appears somewhere unexpected
 * is exactly what this is looking for, and scoping the scan to where the
 * writers are today would make it blind to the one that moves.
 */
const NON_TEST_SOURCES = sourceFiles(API_SRC)
  .filter((file) => !file.endsWith(".test.ts"))
  .map((file) => ({
    module: nodePath.relative(API_SRC, file),
    contents: readFileSync(file, "utf-8"),
  }));

const modulesCalling = (needle: string): string[] =>
  NON_TEST_SOURCES.filter(({ contents }) => contents.includes(needle))
    .map(({ module }) => module)
    .toSorted();

test("the value that reaches a citation_key column comes from one helper", () => {
  // A module added to this list is a module that decided for itself what an
  // uncanonicalizable text stores, which is the decision that drifted.
  expect(modulesCalling("citationKeyOf(")).toEqual([
    "handlers/case-law/ingestion/pipeline.ts",
    "scripts/backfill-citation-keys.ts",
  ]);
});

test("nothing derives a key from the raw canonicalizer", () => {
  // `bareCitationKey` is the canonicalization, not the column value: it
  // returns '' for a text that does not canonicalize. Callers that compare
  // keys may use it; a caller that stores one must not.
  expect(modulesCalling("bareCitationKey(")).toEqual([
    "handlers/case-law/decisions/search.ts",
    "handlers/case-law/ingestion/citation-extractor.ts",
    "handlers/case-law/ingestion/citation-recall.ts",
    "handlers/case-law/ingestion/pipeline.ts",
  ]);
});

test("both writers agree that an uncanonicalizable text has no key", () => {
  // The exact disagreement, stated as the property it violated. Whitespace is
  // what a sanitized citation text collapses to when it carried nothing else.
  for (const text of ["", "   ", " "]) {
    expect(bareCitationKey(text)).toBe("");
    expect(citationKeyOf(text)).toBeNull();
  }
});

test("a text that does canonicalize keeps its key unchanged", () => {
  // The wrapper only replaces the empty result; it must not otherwise differ
  // from the canonicalizer, or the two sides of the join would drift apart.
  for (const text of [
    "sp. zn. 21 Cdo 5/2019",
    "č. j. 9 As 12/2015",
    "sygn. akt II CSK 123/20",
  ]) {
    expect(citationKeyOf(text)).toBe(bareCitationKey(text));
  }
});
