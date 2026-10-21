import { describe, expect, it } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { filterTemplatesByName } from "./new-document-from-template-dialog.logic";

const SEARCH_TEXT_MAX_CHARACTERS = 24;
const GENERATED_TEMPLATES_MAX_COUNT = 40;

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

describe("template picker search", () => {
  it("trims and case-folds the query while keeping accent-sensitive matching and order", () => {
    const templates = [
      { id: "second", name: "CASE note" },
      { id: "accent", name: "Café" },
      { id: "first", name: "Case file" },
    ];

    expect(
      filterTemplatesByName(templates, " CASE ").map(({ id }) => id),
    ).toEqual(["second", "first"]);
    expect(filterTemplatesByName(templates, "cafe")).toEqual([]);
  });

  it("returns all templates in input order for an empty query", () => {
    const templates = [{ name: "Second" }, { name: "First" }];

    expect(filterTemplatesByName(templates, "")).toBe(templates);
    expect(filterTemplatesByName(templates, "  ")).toBe(templates);
  });

  it("matches malformed template names by replacement scalar without matching emoji", () => {
    const templates = [
      { id: "malformed", name: "\ud800" },
      { id: "emoji", name: "😀" },
    ];

    expect(filterTemplatesByName(templates, "\udc00")).toEqual(
      templates.slice(0, 1),
    );
    expect(filterTemplatesByName(templates, "\ufffd")).toEqual(
      templates.slice(0, 1),
    );
  });
});

it("template filtering matches the previous trimmed name substring behavior", () => {
  assertProperty(
    "template filtering matches the previous trimmed name substring behavior",
    fc.property(
      fc.array(fc.record({ id: fc.string(), name: searchText }), {
        maxLength: GENERATED_TEMPLATES_MAX_COUNT,
      }),
      searchText,
      (templates, query) => {
        const normalizedQuery = query.trim().toLowerCase();
        const expected =
          normalizedQuery === ""
            ? templates
            : templates.filter((template) =>
                containsPreviousScalarSearchKey(
                  template.name.toLowerCase(),
                  normalizedQuery,
                ),
              );

        expect(filterTemplatesByName(templates, query)).toEqual(expected);
      },
    ),
  );
});
