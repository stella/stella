import { describe, expect, it } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { foldSearchMatchText } from "@stll/text-normalize";

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

describe("flow run entity search", () => {
  it("matches names regardless of case and accents, in source order", () => {
    const entities = [
      { id: "later", name: "CASE file" },
      { id: "accent", name: "Café" },
      { id: "first", name: "Case note" },
    ];

    expect(filterEntitiesByName(entities, "case").map(({ id }) => id)).toEqual([
      "later",
      "first",
    ]);
    expect(filterEntitiesByName(entities, "cafe").map(({ id }) => id)).toEqual([
      "accent",
    ]);
    expect(
      filterEntitiesByName([{ id: "pl", name: "Umowa Łódź" }], "lodz"),
    ).toEqual([{ id: "pl", name: "Umowa Łódź" }]);
  });

  it("includes unnamed entities only for a blank query", () => {
    const entities = [
      { id: "unnamed", name: null },
      { id: "named", name: "Record" },
    ];

    expect(filterEntitiesByName(entities, "")).toEqual(entities);
    expect(filterEntitiesByName(entities, " ")).toEqual(entities);
    expect(filterEntitiesByName(entities, "rec")).toEqual(entities.slice(1));
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

it("flow entity filtering keeps exactly the entities whose name matches", () => {
  assertProperty(
    "flow entity filtering keeps exactly the entities whose name matches",
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
          matchesFolded(entity.name, query),
        );

        expect(filterEntitiesByName(entities, query)).toEqual(expected);
      },
    ),
  );
});
