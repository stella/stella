import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { foldSearchMatchText } from "@stll/text-normalize";

import { filterMatterPickerItems } from "@/components/matter-picker-search.logic";

const matters = [
  {
    id: "one",
    name: "Alpha Plan",
    client: { displayName: "Northwind" },
  },
  {
    id: "two",
    name: "Beta Memo",
    client: { displayName: "Southwind" },
  },
  { id: "three", name: "Český návrh", client: null },
];
const PROPERTY_TEXT_PARTS_MAX = 24;
const PROPERTY_MATTERS_MAX = 16;

const filter = (query: string, selectedId?: string | null) =>
  filterMatterPickerItems({
    getClientLabel: (matter) => matter.client?.displayName ?? "",
    items: matters,
    query,
    selectedId,
  });

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

describe("matter picker search", () => {
  test("trims and folds a substring over names or client labels separately", () => {
    expect(filter("  NORTH ").map(({ id }) => id)).toEqual(["one"]);
    expect(filter("beta").map(({ id }) => id)).toEqual(["two"]);
    expect(filter("alpha north")).toEqual([]);
    expect(filter("cesky").map(({ id }) => id)).toEqual(["three"]);
    expect(filter("NAVRH").map(({ id }) => id)).toEqual(["three"]);
    expect(filter("   ")).toEqual(matters);
  });

  test("promotes the selected matter only for an empty query", () => {
    expect(filter("", "two").map(({ id }) => id)).toEqual([
      "two",
      "one",
      "three",
    ]);
    expect(filter("memo", "one").map(({ id }) => id)).toEqual(["two"]);
    expect(filter("", "missing")).toEqual(matters);
  });

  test("handles empty input and keeps every match in source order", () => {
    expect(
      filterMatterPickerItems({
        getClientLabel: () => "",
        items: [],
        query: "alpha",
      }),
    ).toEqual([]);
    const manyMatters = Array.from({ length: 60 }, (_, index) => ({
      id: `matter-${index}`,
      name: `Matter ${index}`,
    }));
    expect(
      filterMatterPickerItems({
        getClientLabel: () => "",
        items: manyMatters,
        query: "matter",
      }),
    ).toEqual(manyMatters);
  });

  test("matches the chat picker's flattened client label", () => {
    const chatMatters = [
      { id: "chat-one", name: "Motion", clientLabel: "Northwind Legal" },
      { id: "chat-two", name: "Letter", clientLabel: "Southwind Legal" },
    ];
    expect(
      filterMatterPickerItems({
        getClientLabel: (matter) => matter.clientLabel,
        items: chatMatters,
        query: "southwind",
      }),
    ).toEqual([
      { id: "chat-two", name: "Letter", clientLabel: "Southwind Legal" },
    ]);
  });

  test("matches malformed names and client labels through the replacement character", () => {
    const malformedMatters = [
      { id: "name", name: "A\ud800lpha", clientLabel: "Northwind" },
      { id: "client", name: "Beta", clientLabel: "South\ud800wind" },
    ];

    expect(
      filterMatterPickerItems({
        getClientLabel: (matter) => matter.clientLabel,
        items: malformedMatters,
        query: "\uFFFD",
      }),
    ).toEqual(malformedMatters);
  });
});

test("matter picker filtering keeps the folded matches and selection rules", () => {
  const text = fc
    .array(
      fc.constantFrom(
        "a",
        "A",
        " ",
        "\t",
        "é",
        "e\u0301",
        "Ł",
        "İ",
        "ı",
        "ß",
        "[",
        ".",
        "😀",
        "\ud800",
        "ع",
      ),
      { maxLength: PROPERTY_TEXT_PARTS_MAX },
    )
    .map((parts) => parts.join(""));

  assertProperty(
    "matter picker filtering keeps the folded matches and selection rules",
    fc.property(
      fc.array(fc.record({ id: text, name: text, clientLabel: text }), {
        maxLength: PROPERTY_MATTERS_MAX,
      }),
      fc.oneof(fc.constant(null), text),
      text,
      (items, selectedId, query) => {
        const matchingItems = items.filter(
          (item) =>
            matchesFolded(item.name, query) ||
            matchesFolded(item.clientLabel, query),
        );
        const selected =
          query.trim().length === 0
            ? matchingItems.find((item) => item.id === selectedId)
            : undefined;
        const expected =
          selected === undefined
            ? matchingItems
            : [
                selected,
                ...matchingItems.filter((item) => item.id !== selectedId),
              ];

        expect(
          filterMatterPickerItems({
            getClientLabel: (item) => item.clientLabel,
            items,
            query,
            selectedId,
          }),
        ).toEqual(expected);
      },
    ),
  );
});
