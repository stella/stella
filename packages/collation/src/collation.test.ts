import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  BoundedLruCache,
  compareByLocale,
  compareCodeUnit,
  getCollator,
  LOCALE_CACHE_LIMIT,
} from "./collation";

const collationString = fc
  .array(
    fc.constantFrom(
      "a",
      "A",
      "á",
      "ä",
      "c",
      "č",
      "h",
      "i",
      "o",
      "ô",
      "r",
      "ř",
      "0",
      "2",
      "9",
      "😀",
      "\u{E000}",
    ),
    { maxLength: 12 },
  )
  .map((characters) => characters.join(""));

const sign = (value: number): number => (value === 0 ? 0 : Math.sign(value));

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

  test("uses the documented cache bound", () => {
    expect(LOCALE_CACHE_LIMIT).toBe(16);
  });
});

describe("compareByLocale", () => {
  test('cs treats "ch" as its own letter, collated after "h" and before "i"', () => {
    // Czech alphabetical order runs ..., h, ch, i, ... — "cha" (the digraph
    // "ch" plus "a") must therefore land strictly between any "h..." and
    // "i..." word, which a code-unit-order (bare, locale-less) sort gets
    // wrong: "cha" < "ha" by code unit ('c' < 'h'), the opposite of Czech
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

  test("pins Czech tailored letters, accents, and case tiers", () => {
    expect(
      ["řeka", "cibule", "Řeka", "čaj", "rak", "Cibule"].toSorted(
        compareByLocale("cs"),
      ),
    ).toEqual(["cibule", "Cibule", "čaj", "rak", "řeka", "Řeka"]);
  });

  test("pins Slovak ä, ô, and ch ordering", () => {
    expect(
      ["iba", "chata", "hora", "otec", "ôkovať", "auto", "ä", "az"].toSorted(
        compareByLocale("sk"),
      ),
    ).toEqual(["auto", "az", "ä", "hora", "chata", "iba", "otec", "ôkovať"]);
  });

  test("uses variant sensitivity and lexical digit ordering", () => {
    const collator = getCollator("cs");
    expect(collator.resolvedOptions()).toMatchObject({
      numeric: false,
      sensitivity: "variant",
    });
    expect(["2", "10", "a", "A", "á"].toSorted(collator.compare)).toEqual([
      "10",
      "2",
      "a",
      "A",
      "á",
    ]);
  });

  test("defines a total order whose result is sorted consistently", () => {
    assertProperty(
      "defines a total order whose result is sorted consistently",
      fc.property(
        fc.array(collationString, { maxLength: 40 }),
        collationString,
        collationString,
        collationString,
        (values, a, b, c) => {
          const compare = compareByLocale("cs");
          expect(compare(a, a)).toBe(0);
          expect(sign(compare(a, b))).toBe(sign(-compare(b, a)));
          if (compare(a, b) <= 0 && compare(b, c) <= 0) {
            expect(compare(a, c)).toBeLessThanOrEqual(0);
          }

          const sorted = values.toSorted(compare);
          for (let index = 1; index < sorted.length; index += 1) {
            expect(
              compare(sorted[index - 1] ?? "", sorted[index] ?? ""),
            ).toBeLessThanOrEqual(0);
          }
          expect(sorted.toSorted(compare)).toEqual(sorted);
        },
      ),
    );
  });

  test("is usable as a field comparator via a small wrapper", () => {
    const items = [{ name: "ida" }, { name: "chata" }, { name: "hora" }];
    const compare = compareByLocale("cs");
    expect(
      items.toSorted((a, b) => compare(a.name, b.name)).map((i) => i.name),
    ).toEqual(["hora", "chata", "ida"]);
  });
});

describe("compareCodeUnit", () => {
  test("orders by code unit, ignoring locale collation rules", () => {
    // Under cs-CZ collation "ch" sorts after "h", but code-unit order must
    // not follow that rule.
    expect(["ia", "cha", "ha"].toSorted(compareCodeUnit)).toEqual([
      "cha",
      "ha",
      "ia",
    ]);
  });

  test("is antisymmetric and reports equality as 0", () => {
    expect(compareCodeUnit("a", "a")).toBe(0);
    expect(compareCodeUnit("a", "b")).toBe(-1);
    expect(compareCodeUnit("b", "a")).toBe(1);
  });

  test("orders supplementary characters by their UTF-16 surrogates", () => {
    // U+1F600 is encoded as D83D DE00, so it sorts before U+E000 under the
    // code-unit order that JavaScript `<` and the default sort share. Stored
    // orderings depend on this staying put.
    expect(compareCodeUnit("\u{1F600}", "\uE000")).toBe(-1);
  });

  test("code-unit comparison defines a total order", () => {
    assertProperty(
      "code-unit comparison defines a total order",
      fc.property(
        collationString,
        collationString,
        collationString,
        (a, b, c) => {
          expect(compareCodeUnit(a, a)).toBe(0);
          expect(sign(compareCodeUnit(a, b))).toBe(
            sign(-compareCodeUnit(b, a)),
          );
          if (compareCodeUnit(a, b) <= 0 && compareCodeUnit(b, c) <= 0) {
            expect(compareCodeUnit(a, c)).toBeLessThanOrEqual(0);
          }
        },
      ),
    );
  });
});

describe("BoundedLruCache", () => {
  test("evicts the least recently used entry", () => {
    const cache = new BoundedLruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a");
    cache.set("c", 3);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
  });

  test("treats overwriting an entry as a use", () => {
    const cache = new BoundedLruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("a", 10);
    cache.set("c", 3);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(10);
  });

  test("never retains more entries than its bound", () => {
    const cache = new BoundedLruCache<number, object>(LOCALE_CACHE_LIMIT);
    const values = Array.from({ length: LOCALE_CACHE_LIMIT + 1 }, () => ({}));
    for (const [key, value] of values.entries()) {
      cache.set(key, value);
    }
    expect(cache.get(0)).toBeUndefined();
    for (let key = 1; key < values.length; key += 1) {
      expect(cache.get(key)).toBe(values[key]);
    }
  });

  test("reading an undefined value still refreshes its recency", () => {
    const cache = new BoundedLruCache<string, number | undefined>(2);
    cache.set("a", undefined);
    cache.set("b", 2);
    cache.get("a");
    cache.set("c", 3);
    expect(cache.get("b")).toBeUndefined();
    cache.get("a");
    cache.set("d", 4);
    expect(cache.get("c")).toBeUndefined();
  });
});
