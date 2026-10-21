import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

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

const clauses = [
  { id: "1", categoryId: "terms", title: "Delivery + payment" },
  { id: "2", categoryId: "terms", title: "Delivery schedule" },
  { id: "3", categoryId: null, title: "Delivery without category" },
] as const;

describe("clause link filtering", () => {
  test("uses the raw case-insensitive title substring and preserves order", () => {
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

  test("keeps blank search unfiltered and treats whitespace as a literal", () => {
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

  test("does not add accent folding", () => {
    expect(
      filterClauseLinkCandidates({
        clauses: [{ categoryId: null, title: "Café" }],
        selectedCategory: "",
        search: "cafe",
      }),
    ).toEqual([]);
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

  test("clause filtering matches the previous substring predicate for generated Unicode inputs", () => {
    assertProperty(
      "clause filtering matches the previous substring predicate for generated Unicode inputs",
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
            if (
              search &&
              !clause.title
                .toLowerCase()
                .toWellFormed()
                .includes(search.toLowerCase().toWellFormed())
            ) {
              return false;
            }
            return true;
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
