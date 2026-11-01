import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { foldSearchMatchText } from "@stll/text-normalize";

import { filterClauseLinkCandidates } from "./link-clause-dialog.logic";

const PROPERTY_MAX_TEXT_PARTS = 24;
const PROPERTY_MAX_CLAUSES = 12;
const searchTextArbitrary = fc
  .array(
    fc.constantFrom(
      "a",
      "C",
      "é",
      "e\u0301",
      "Č",
      "c\u030C",
      "ß",
      "ς",
      "😀",
      "\ud800",
      "\udc00",
      "\ufffd",
      "+",
      "[",
      " ",
      "\t",
    ),
    { maxLength: PROPERTY_MAX_TEXT_PARTS },
  )
  .map((parts) => parts.join(""));

/**
 * The search contract: a field matches when it contains the trimmed query once
 * both are folded for search (case, accents, ligatures, Arabic variants).
 */
const matchesFolded = (field: string | null | undefined, query: string) => {
  const needle = foldSearchMatchText(query.trim().toWellFormed());
  return (
    needle === "" ||
    (field !== null &&
      field !== undefined &&
      foldSearchMatchText(field.toWellFormed()).includes(needle))
  );
};

const clauses = [
  { id: "1", categoryId: "terms", title: "Delivery + payment" },
  { id: "2", categoryId: "terms", title: "Delivery schedule" },
  { id: "3", categoryId: null, title: "Delivery without category" },
] as const;

describe("clause link filtering", () => {
  test("matches a title substring regardless of case and preserves order", () => {
    expect(
      filterClauseLinkCandidates({
        clauses,
        selectedCategory: "",
        search: "DELIVERY +",
      }),
    ).toEqual([clauses[0]]);
    expect(
      filterClauseLinkCandidates({
        clauses,
        selectedCategory: "terms",
        search: "delivery",
      }),
    ).toEqual([clauses[0], clauses[1]]);
  });

  test("keeps a blank or whitespace search unfiltered", () => {
    expect(
      filterClauseLinkCandidates({ clauses, selectedCategory: "", search: "" }),
    ).toEqual([...clauses]);
    expect(
      filterClauseLinkCandidates({
        clauses,
        selectedCategory: "",
        search: " ",
      }),
    ).toEqual([clauses[0], clauses[1], clauses[2]]);
  });

  test("ignores accents on both sides", () => {
    const accented = [{ categoryId: null, title: "Gewährleistung für Mängel" }];
    expect(
      filterClauseLinkCandidates({
        clauses: accented,
        selectedCategory: "",
        search: "mangel",
      }),
    ).toEqual(accented);
    expect(
      filterClauseLinkCandidates({
        clauses: [{ categoryId: null, title: "Gewahrleistung" }],
        selectedCategory: "",
        search: "GEWÄHR",
      }),
    ).toHaveLength(1);
  });

  test("matches well-formed replacement characters without matching half an astral character", () => {
    const malformedClause = [{ categoryId: null, title: "before\ud800after" }];
    const astralClause = [{ categoryId: null, title: "😀" }];
    expect(
      filterClauseLinkCandidates({
        clauses: malformedClause,
        selectedCategory: "",
        search: "\ufffd",
      }),
    ).toEqual(malformedClause);
    expect(
      filterClauseLinkCandidates({
        clauses: astralClause,
        selectedCategory: "",
        search: "\ud83d",
      }),
    ).toEqual([]);
    expect(
      filterClauseLinkCandidates({
        clauses: astralClause,
        selectedCategory: "",
        search: "\ude00",
      }),
    ).toEqual([]);
  });

  test("clause filtering keeps exactly the folded title matches for generated Unicode inputs", () => {
    assertProperty(
      "clause filtering keeps exactly the folded title matches for generated Unicode inputs",
      fc.property(
        fc.array(
          fc.record({
            categoryId: fc.oneof(fc.constant(null), searchTextArbitrary),
            title: searchTextArbitrary,
          }),
          { maxLength: PROPERTY_MAX_CLAUSES },
        ),
        searchTextArbitrary,
        searchTextArbitrary,
        (generatedClauses, selectedCategory, search) => {
          const expected = generatedClauses.filter((clause) => {
            if (selectedCategory && clause.categoryId !== selectedCategory) {
              return false;
            }
            return matchesFolded(clause.title, search);
          });
          expect(
            filterClauseLinkCandidates({
              clauses: generatedClauses,
              selectedCategory,
              search,
            }),
          ).toEqual(expected);
        },
      ),
    );
  });
});
