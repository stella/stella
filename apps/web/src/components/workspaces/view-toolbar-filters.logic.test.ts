import { describe, expect, it } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

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

const containsPreviousScalarSearchKey = (content: string, query: string) => {
  const contentScalars = Array.from(content.toWellFormed());
  const queryScalars = Array.from(query.toWellFormed());
  if (queryScalars.length === 0) {
    return true;
  }
  return contentScalars.some((_, start) =>
    queryScalars.every(
      (scalar, offset) => contentScalars.at(start + offset) === scalar,
    ),
  );
};

describe("filter field labels", () => {
  it("trims and case-folds the query without folding accents", () => {
    const fields = [{ label: "Café status" }, { label: "Case number" }];

    expect(filterFieldsByLabel(fields, " CASE ")).toEqual([
      { label: "Case number" },
    ]);
    expect(filterFieldsByLabel(fields, "cafe")).toEqual([]);
  });

  it("returns every field in input order for an empty or whitespace query", () => {
    const fields = [{ label: "Second" }, { label: "First" }];

    expect(filterFieldsByLabel(fields, "")).toBe(fields);
    expect(filterFieldsByLabel(fields, "   ")).toBe(fields);
  });

  it("matches malformed fields by replacement scalar without matching emoji", () => {
    const fields = [{ label: "\ud800" }, { label: "😀" }];

    expect(filterFieldsByLabel(fields, "\udc00")).toEqual(fields.slice(0, 1));
    expect(filterFieldsByLabel(fields, "\ufffd")).toEqual(fields.slice(0, 1));
  });
});

it("field filtering matches the previous trimmed substring behavior", () => {
  assertProperty(
    "field filtering matches the previous trimmed substring behavior",
    fc.property(
      fc.array(fc.record({ label: searchText }), {
        maxLength: GENERATED_FILTER_FIELDS_MAX_COUNT,
      }),
      searchText,
      (fields, query) => {
        const normalized = query.trim().toLowerCase();
        const expected = normalized
          ? fields.filter((field) =>
              containsPreviousScalarSearchKey(
                field.label.toLowerCase(),
                normalized,
              ),
            )
          : fields;

        expect(filterFieldsByLabel(fields, query)).toEqual(expected);
      },
    ),
  );
});
