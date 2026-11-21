import { describe, expect, it } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { foldSearchMatchText } from "@stll/text-normalize";

import { filterFieldsByLabel } from "@/components/workspaces/view-toolbar-filters.logic";

const SEARCH_TEXT_MAX_CHARACTERS = 24;
const GENERATED_FILTER_FIELDS_MAX_COUNT = 40;

const searchText = fc
  .array(
    fc.constantFrom(
      "A",
      "a",
      "Č",
      "č",
      "é",
      "e\u0301",
      "[",
      "]",
      " ",
      "\t",
      "😀",
      "\ud800",
      "\udc00",
    ),
    { maxLength: SEARCH_TEXT_MAX_CHARACTERS },
  )
  .map((characters) => characters.join(""));

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

describe("filter field labels", () => {
  it("trims the query and folds case and accents", () => {
    const fields = [{ label: "Café status" }, { label: "Case number" }];

    expect(filterFieldsByLabel(fields, " CASE ")).toEqual([
      { label: "Case number" },
    ]);
    expect(filterFieldsByLabel(fields, "cafe")).toEqual([
      { label: "Café status" },
    ]);
    expect(filterFieldsByLabel([{ label: "Ügyfél" }], "ugyfel")).toEqual([
      { label: "Ügyfél" },
    ]);
  });

  it("returns every field in input order for an empty or whitespace query", () => {
    const fields = [{ label: "Second" }, { label: "First" }];

    expect(filterFieldsByLabel(fields, "")).toEqual(fields);
    expect(filterFieldsByLabel(fields, "   ")).toEqual(fields);
  });

  it("matches malformed fields by replacement scalar without matching emoji", () => {
    const fields = [{ label: "\ud800" }, { label: "😀" }];

    expect(filterFieldsByLabel(fields, "\udc00")).toEqual(fields.slice(0, 1));
    expect(filterFieldsByLabel(fields, "\ufffd")).toEqual(fields.slice(0, 1));
  });
});

it("field filtering keeps exactly the fields whose label matches", () => {
  assertProperty(
    "field filtering keeps exactly the fields whose label matches",
    fc.property(
      fc.array(fc.record({ label: searchText }), {
        maxLength: GENERATED_FILTER_FIELDS_MAX_COUNT,
      }),
      searchText,
      (fields, query) => {
        const expected = fields.filter((field) =>
          matchesFolded(field.label, query),
        );

        expect(filterFieldsByLabel(fields, query)).toEqual(expected);
      },
    ),
  );
});
