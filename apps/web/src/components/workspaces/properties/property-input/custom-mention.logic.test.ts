import { describe, expect, it } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

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

describe("property mention search", () => {
  it("matches labels case-insensitively, preserves order, and remains accent-sensitive", () => {
    const items = [
      { id: "second", label: "CASE" },
      { id: "accent", label: "Café" },
      { id: "first", label: "case file" },
    ];

    expect(filterMentionItems(items, "case").map(({ id }) => id)).toEqual([
      "second",
      "first",
    ]);
    expect(filterMentionItems(items, "cafe")).toEqual([]);
  });

  it("returns every option for an empty query", () => {
    const items = [
      { id: "b", label: "B" },
      { id: "a", label: "A" },
    ];

    expect(filterMentionItems(items, "")).toEqual(items);
    expect(filterMentionItems(items, " ")).toEqual([]);
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

it("property mention filtering matches the previous label substring behavior", () => {
  assertProperty(
    "property mention filtering matches the previous label substring behavior",
    fc.property(
      fc.array(fc.record({ id: fc.string(), label: searchText }), {
        maxLength: GENERATED_MENTION_ITEMS_MAX_COUNT,
      }),
      searchText,
      (items, query) => {
        const expected = items.filter((item) =>
          containsPreviousScalarSearchKey(
            item.label.toLowerCase(),
            query.toLowerCase(),
          ),
        );

        expect(filterMentionItems(items, query)).toEqual(expected);
      },
    ),
  );
});
