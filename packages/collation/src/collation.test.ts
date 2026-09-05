import { describe, expect, test } from "bun:test";

import { compareByLocale, compareCodepoint, getCollator } from "./collation";

describe("getCollator", () => {
  test("caches one collator instance per locale", () => {
    expect(getCollator("cs")).toBe(getCollator("cs"));
  });

  test("returns a distinct instance per distinct locale", () => {
    expect(getCollator("cs")).not.toBe(getCollator("sk"));
  });

  test("evicts the least recently used locale when the cache is full", () => {
    const original = getCollator("en-x-cache-origin");

    for (let index = 0; index < 16; index += 1) {
      getCollator(`en-x-cache-${String(index)}`);
    }

    expect(getCollator("en-x-cache-origin")).not.toBe(original);
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

describe("compareCodepoint", () => {
  test("orders by codepoint, ignoring locale collation rules", () => {
    // Under cs-CZ collation "ch" sorts after "h", but codepoint order must
    // not follow that rule.
    expect(["ia", "cha", "ha"].toSorted(compareCodepoint)).toEqual([
      "cha",
      "ha",
      "ia",
    ]);
  });

  test("is antisymmetric and reports equality as 0", () => {
    expect(compareCodepoint("a", "a")).toBe(0);
    expect(compareCodepoint("a", "b")).toBe(-1);
    expect(compareCodepoint("b", "a")).toBe(1);
  });

  test("orders supplementary characters by their UTF-16 surrogates", () => {
    // U+1F600 is encoded as D83D DE00, so it sorts before U+E000 under the
    // code-unit order that JavaScript `<` and the default sort share. Stored
    // orderings depend on this staying put.
    expect(compareCodepoint("\u{1F600}", "\uE000")).toBe(-1);
  });
});
