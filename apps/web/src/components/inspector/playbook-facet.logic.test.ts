import { describe, expect, it } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { foldSearchMatchText } from "@stll/text-normalize";

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

describe("playbook picker search", () => {
  it("trims and folds case and accents, preserving order", () => {
    const playbooks = [
      { id: "second", name: "CASE" },
      { id: "accent", name: "Café" },
      { id: "first", name: "case review" },
    ];

    expect(
      filterPlaybooksByName(playbooks, " CASE ").map(({ id }) => id),
    ).toEqual(["second", "first"]);
    expect(
      filterPlaybooksByName(playbooks, "cafe").map(({ id }) => id),
    ).toEqual(["accent"]);
    expect(
      filterPlaybooksByName([{ name: "Revisión de contratos" }], "REVISION"),
    ).toEqual([{ name: "Revisión de contratos" }]);
  });

  it("returns every playbook in input order for an empty query", () => {
    const playbooks = [{ name: "Second" }, { name: "First" }];

    expect(filterPlaybooksByName(playbooks, "")).toEqual(playbooks);
    expect(filterPlaybooksByName(playbooks, "  ")).toEqual(playbooks);
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

it("playbook filtering keeps exactly the playbooks whose name matches", () => {
  assertProperty(
    "playbook filtering keeps exactly the playbooks whose name matches",
    fc.property(
      fc.array(fc.record({ id: fc.string(), name: searchText }), {
        maxLength: GENERATED_PLAYBOOKS_MAX_COUNT,
      }),
      searchText,
      (playbooks, query) => {
        const expected = playbooks.filter((playbook) =>
          matchesFolded(playbook.name, query),
        );

        expect(filterPlaybooksByName(playbooks, query)).toEqual(expected);
      },
    ),
  );
});
