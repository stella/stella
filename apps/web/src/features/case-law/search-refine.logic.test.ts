import { describe, expect, test } from "bun:test";

import {
  addRefineTerm,
  normalizeRefineTerm,
  refineTermsOfQuery,
  removeRefineTerm,
} from "@/features/case-law/search-refine.logic";

/**
 * The grammar property the refine box depends on: every token of `q` is
 * required, and a straight-quoted span is one token. These re-derive it from
 * the string alone, which is all the transformation may assume.
 */
const quotedSpanCount = (query: string): number =>
  (query.match(/"[^"]*"/gu) ?? []).length;

describe("refining a query", () => {
  test("adds the entry as one quoted span beside what was already asked", () => {
    const refined = addRefineTerm("nájem bytu", "výpovědní důvod");

    expect(refined).toBe('nájem bytu "výpovědní důvod"');
    expect(quotedSpanCount(refined ?? "")).toBe(1);
  });

  test("refines an empty query into the phrase alone", () => {
    expect(addRefineTerm(undefined, "dobré mravy")).toBe('"dobré mravy"');
  });

  test("keeps every earlier refinement required when another is added", () => {
    const once = addRefineTerm("promlčení", "dobrá víra");
    const twice = addRefineTerm(once, "náhrada škody");

    expect(refineTermsOfQuery(twice)).toEqual(["dobrá víra", "náhrada škody"]);
    expect(twice).toContain("promlčení");
  });

  test("does not ask for the same phrase twice", () => {
    const once = addRefineTerm("promlčení", "dobrá víra");

    expect(addRefineTerm(once, "  dobrá   víra ")).toBe(once);
  });

  test("ignores an entry with nothing to search for", () => {
    expect(addRefineTerm("promlčení", '  " "  ')).toBe("promlčení");
    expect(normalizeRefineTerm('""')).toBeNull();
  });

  test("strips quotes out of the entry so the span cannot close early", () => {
    const refined = addRefineTerm("promlčení", 'dobrá "víra"');

    expect(quotedSpanCount(refined ?? "")).toBe(1);
    expect(refineTermsOfQuery(refined)).toEqual(["dobrá víra"]);
  });
});

describe("reading the refinements back out of a query", () => {
  test("reports each quoted span once, in the order it appears", () => {
    expect(refineTermsOfQuery('a "jedna" b "dvě" c "jedna"')).toEqual([
      "jedna",
      "dvě",
    ]);
  });

  test("reports nothing for an unbalanced quote, which the engines read as loose terms", () => {
    expect(refineTermsOfQuery('nájem "bytu')).toEqual([]);
  });

  test("reports nothing for a query with no quotes at all", () => {
    expect(refineTermsOfQuery("nájem bytu")).toEqual([]);
  });
});

describe("removing a refinement", () => {
  test("leaves the rest of the query intact", () => {
    expect(
      removeRefineTerm('nájem bytu "výpovědní důvod"', "výpovědní důvod"),
    ).toBe("nájem bytu");
  });

  test("clears the query when the phrase was all it asked for", () => {
    expect(removeRefineTerm('"dobré mravy"', "dobré mravy")).toBeUndefined();
  });

  test("removes every copy of the phrase", () => {
    expect(removeRefineTerm('"x" nájem "x"', "x")).toBe("nájem");
  });

  test("leaves a phrase it was not asked about alone", () => {
    const query = '"jedna" "dvě"';

    expect(removeRefineTerm(query, "tři")).toBe(query);
    expect(refineTermsOfQuery(removeRefineTerm(query, "jedna"))).toEqual([
      "dvě",
    ]);
  });

  test("round-trips: adding then removing restores the original query", () => {
    const original = "nájem bytu";

    expect(
      removeRefineTerm(addRefineTerm(original, "dobrá víra"), "dobrá víra"),
    ).toBe(original);
  });
});
