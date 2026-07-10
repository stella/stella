import { describe, expect, test } from "bun:test";

import { compareByLocale, getCollator } from "@/lib/collation";

describe("getCollator", () => {
  test("caches one collator instance per locale", () => {
    expect(getCollator("cs")).toBe(getCollator("cs"));
  });

  test("returns a distinct instance per distinct locale", () => {
    expect(getCollator("cs")).not.toBe(getCollator("sk"));
  });
});

describe("compareByLocale", () => {
  test('cs treats "ch" as its own letter, collated after "h" and before "i"', () => {
    // Czech alphabetical order runs ..., h, ch, i, ... — "cha" (the digraph
    // "ch" plus "a") must therefore land strictly between any "h..." and
    // "i..." word, which a codepoint-order (bare, locale-less) sort gets
    // wrong: "cha" < "ha" by codepoint ('c' < 'h'), the opposite of Czech
    // collation order.
    expect(["ia", "cha", "ha"].toSorted(compareByLocale("cs"))).toEqual([
      "ha",
      "cha",
      "ia",
    ]);
  });

  test("orders diacritics next to their base letter", () => {
    expect(["b", "á", "a"].toSorted(compareByLocale("cs"))).toEqual([
      "a",
      "á",
      "b",
    ]);
  });

  test("is usable as a field comparator via a small wrapper", () => {
    const items = [{ name: "ida" }, { name: "chata" }, { name: "hora" }];
    const compare = compareByLocale("cs");
    expect(
      items.toSorted((a, b) => compare(a.name, b.name)).map((i) => i.name),
    ).toEqual(["hora", "chata", "ida"]);
  });
});
