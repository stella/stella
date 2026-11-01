import { describe, expect, it } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { foldSearchMatchText } from "@stll/text-normalize";

import { filterMentionItems } from "@/components/workspaces/properties/property-input/custom-mention.logic";

const SEARCH_TEXT_MAX_CHARACTERS = 24;
const GENERATED_MENTION_ITEMS_MAX_COUNT = 40;

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

describe("property mention search", () => {
  it("matches labels regardless of case and accents, preserving order", () => {
    const items = [
      { id: "second", label: "CASE" },
      { id: "accent", label: "Café" },
      { id: "first", label: "case file" },
    ];

    expect(filterMentionItems(items, "case").map(({ id }) => id)).toEqual([
      "second",
      "first",
    ]);
    expect(filterMentionItems(items, "cafe").map(({ id }) => id)).toEqual([
      "accent",
    ]);
    expect(
      filterMentionItems([{ id: "fr", label: "Élise Dupré" }], "elise"),
    ).toHaveLength(1);
  });

  it("returns every option for a blank query", () => {
    const items = [
      { id: "b", label: "B" },
      { id: "a", label: "A" },
    ];

    expect(filterMentionItems(items, "")).toEqual(items);
    expect(filterMentionItems(items, " ")).toEqual(items);
  });

  it("matches malformed mention labels by replacement scalar without matching emoji", () => {
    const items = [
      { id: "malformed", label: "\ud800" },
      { id: "emoji", label: "😀" },
    ];

    expect(filterMentionItems(items, "\udc00")).toEqual(items.slice(0, 1));
    expect(filterMentionItems(items, "\ufffd")).toEqual(items.slice(0, 1));
  });
});

it("property mention filtering keeps exactly the options whose label matches", () => {
  assertProperty(
    "property mention filtering keeps exactly the options whose label matches",
    fc.property(
      fc.array(fc.record({ id: fc.string(), label: searchText }), {
        maxLength: GENERATED_MENTION_ITEMS_MAX_COUNT,
      }),
      searchText,
      (items, query) => {
        const expected = items.filter((item) =>
          matchesFolded(item.label, query),
        );

        expect(filterMentionItems(items, query)).toEqual(expected);
      },
    ),
  );
});
