import { describe, expect, it } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { foldSearchMatchText } from "@stll/text-normalize";

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

describe("template picker search", () => {
  it("trims and folds case and accents on both sides, keeping order", () => {
    const templates = [
      { id: "second", name: "CASE note" },
      { id: "accent", name: "Café" },
      { id: "first", name: "Case file" },
    ];

    expect(
      filterTemplatesByName(templates, " CASE ").map(({ id }) => id),
    ).toEqual(["second", "first"]);
    expect(
      filterTemplatesByName(templates, "cafe").map(({ id }) => id),
    ).toEqual(["accent"]);
    expect(
      filterTemplatesByName(
        [{ name: "Smlouva Dvořák" }, { name: "Kaufvertrag Straße" }],
        "DVORAK",
      ),
    ).toEqual([{ name: "Smlouva Dvořák" }]);
  });

  it("returns all templates in input order for an empty query", () => {
    const templates = [{ name: "Second" }, { name: "First" }];

    expect(filterTemplatesByName(templates, "")).toEqual(templates);
    expect(filterTemplatesByName(templates, "  ")).toEqual(templates);
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

it("template filtering keeps exactly the templates whose name matches", () => {
  assertProperty(
    "template filtering keeps exactly the templates whose name matches",
    fc.property(
      fc.array(fc.record({ id: fc.string(), name: searchText }), {
        maxLength: GENERATED_TEMPLATES_MAX_COUNT,
      }),
      searchText,
      (templates, query) => {
        const expected = templates.filter((template) =>
          matchesFolded(template.name, query),
        );

        expect(filterTemplatesByName(templates, query)).toEqual(expected);
      },
    ),
  );
});
