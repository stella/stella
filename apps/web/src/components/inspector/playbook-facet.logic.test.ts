import { describe, expect, it } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { filterPlaybooksByName } from "@/components/inspector/playbook-facet.logic";

const SEARCH_TEXT_MAX_CHARACTERS = 24;
const GENERATED_PLAYBOOKS_MAX_COUNT = 40;

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

describe("playbook picker search", () => {
  it("trims and locale-lowercases names while preserving accent distinctions and order", () => {
    const playbooks = [
      { id: "second", name: "CASE" },
      { id: "accent", name: "Café" },
      { id: "first", name: "case review" },
    ];

    expect(
      filterPlaybooksByName(playbooks, " CASE ").map(({ id }) => id),
    ).toEqual(["second", "first"]);
    expect(filterPlaybooksByName(playbooks, "cafe")).toEqual([]);
  });

  it("returns every playbook in input order for an empty query", () => {
    const playbooks = [{ name: "Second" }, { name: "First" }];

    expect(filterPlaybooksByName(playbooks, "")).toBe(playbooks);
    expect(filterPlaybooksByName(playbooks, "  ")).toBe(playbooks);
  });

  it("matches malformed playbook names by replacement scalar without matching emoji", () => {
    const playbooks = [
      { id: "malformed", name: "\ud800" },
      { id: "emoji", name: "😀" },
    ];

    expect(filterPlaybooksByName(playbooks, "\udc00")).toEqual(
      playbooks.slice(0, 1),
    );
    expect(filterPlaybooksByName(playbooks, "\ufffd")).toEqual(
      playbooks.slice(0, 1),
    );
  });
});

it("playbook filtering matches the previous locale-lowercase substring behavior", () => {
  assertProperty(
    "playbook filtering matches the previous locale-lowercase substring behavior",
    fc.property(
      fc.array(fc.record({ id: fc.string(), name: searchText }), {
        maxLength: GENERATED_PLAYBOOKS_MAX_COUNT,
      }),
      searchText,
      (playbooks, query) => {
        const normalizedFilter = query.trim().toLocaleLowerCase();
        const expected =
          normalizedFilter.length === 0
            ? playbooks
            : playbooks.filter((playbook) =>
                containsPreviousScalarSearchKey(
                  playbook.name.toLocaleLowerCase(),
                  normalizedFilter,
                ),
              );

        expect(filterPlaybooksByName(playbooks, query)).toEqual(expected);
      },
    ),
  );
});
