import { describe, expect, test } from "bun:test";

import {
  addRefineTerm,
  canonicalRefinements,
  normalizeRefineTerm,
  queryWithRefinements,
  refineTermsOfQuery,
  removeRefineTerm,
  withoutRefineTerms,
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

  test("drops an unmatched quote in the query before appending", () => {
    // The stray quote would otherwise pair with the one opened here, so the
    // chip would name "b c" and the phrase actually asked for could never be
    // taken back out. Both engines already read it as loose terms.
    const refined = addRefineTerm('a "b c', "d e");

    expect(refined).toBe('a b c "d e"');
    expect(refineTermsOfQuery(refined)).toEqual(["d e"]);
    expect(removeRefineTerm(refined, "d e")).toBe("a b c");
  });

  test("leaves a balanced query's own phrases alone when refining", () => {
    const refined = addRefineTerm('a "b c"', "d e");

    expect(refined).toBe('a "b c" "d e"');
    expect(refineTermsOfQuery(refined)).toEqual(["b c", "d e"]);
  });

  test("strips quotes out of the entry so the span cannot close early", () => {
    const refined = addRefineTerm("promlčení", 'dobrá "víra"');

    expect(quotedSpanCount(refined ?? "")).toBe(1);
    expect(refineTermsOfQuery(refined)).toEqual(["dobrá víra"]);
  });
});

describe("combining independently represented refinements", () => {
  test("keeps a quoted reader query out of the refinement list", () => {
    const query = '"good faith"';

    expect(refineTermsOfQuery(undefined)).toEqual([]);
    expect(queryWithRefinements(query, undefined)).toBe(query);
  });

  test("adds toolbar refinements without changing reader-entered text", () => {
    const query = 'tenant "good faith"';
    const within = addRefineTerm(undefined, "notice period");

    expect(queryWithRefinements(query, within)).toBe(
      'tenant "good faith" "notice period"',
    );
    expect(refineTermsOfQuery(within)).toEqual(["notice period"]);
    expect(query).toBe('tenant "good faith"');
  });
});

describe("canonicalizing refinements at the route boundary", () => {
  test("drops loose terms a hand-edited URL could hide from the toolbar", () => {
    expect(canonicalRefinements("hidden terms")).toBeUndefined();
  });

  test("keeps unique balanced phrases in their canonical form", () => {
    expect(
      canonicalRefinements('loose " notice   period " "notice period"'),
    ).toBe('"notice period"');
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

describe("clearing every refinement at once", () => {
  test("keeps the words the reader typed and drops the phrases", () => {
    expect(withoutRefineTerms('nájem bytu "dobré mravy" "promlčení"')).toBe(
      "nájem bytu",
    );
  });

  test("clears the query when the phrases were all it asked for", () => {
    expect(withoutRefineTerms('"dobré mravy"')).toBeUndefined();
  });

  test("leaves a query with no phrases untouched", () => {
    expect(withoutRefineTerms("nájem bytu")).toBe("nájem bytu");
    expect(withoutRefineTerms(undefined)).toBeUndefined();
  });

  test("leaves nothing the chip row would still show", () => {
    expect(refineTermsOfQuery(withoutRefineTerms('a "b" c "d"'))).toEqual([]);
  });
});
