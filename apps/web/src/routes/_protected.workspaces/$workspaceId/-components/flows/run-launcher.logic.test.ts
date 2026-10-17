import { describe, expect, it } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { filterEntitiesByName } from "./run-launcher.logic";

const SEARCH_TEXT_MAX_CHARACTERS = 24;
const GENERATED_ENTITIES_MAX_COUNT = 40;

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

describe("flow run entity search", () => {
  it("matches names case-insensitively, but keeps accent distinctions and source order", () => {
    const entities = [
      { id: "later", name: "CASE file" },
      { id: "accent", name: "Café" },
      { id: "first", name: "Case note" },
    ];

    expect(filterEntitiesByName(entities, "case").map(({ id }) => id)).toEqual([
      "later",
      "first",
    ]);
    expect(filterEntitiesByName(entities, "cafe")).toEqual([]);
  });

  it("includes unnamed entities for an empty query", () => {
    const entities = [
      { id: "unnamed", name: null },
      { id: "named", name: "Record" },
    ];

    expect(filterEntitiesByName(entities, "")).toEqual(entities);
    expect(filterEntitiesByName(entities, " ")).toEqual([]);
  });

  it("matches malformed entity names by replacement scalar without matching emoji", () => {
    const entities = [
      { id: "malformed", name: "\ud800" },
      { id: "emoji", name: "😀" },
    ];

    expect(filterEntitiesByName(entities, "\udc00")).toEqual(
      entities.slice(0, 1),
    );
    expect(filterEntitiesByName(entities, "\ufffd")).toEqual(
      entities.slice(0, 1),
    );
  });
});

it("flow entity filtering matches the previous name substring behavior", () => {
  assertProperty(
    "flow entity filtering matches the previous name substring behavior",
    fc.property(
      fc.array(
        fc.record({
          id: fc.string(),
          name: fc.option(searchText, { nil: null }),
        }),
        { maxLength: GENERATED_ENTITIES_MAX_COUNT },
      ),
      searchText,
      (entities, query) => {
        const expected = entities.filter((entity) =>
          containsPreviousScalarSearchKey(
            (entity.name ?? "").toLowerCase(),
            query.toLowerCase(),
          ),
        );

        expect(filterEntitiesByName(entities, query)).toEqual(expected);
      },
    ),
  );
});
