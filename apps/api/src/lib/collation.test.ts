import { describe, expect, test } from "bun:test";

import {
  compareByLocale,
  compareCodepoint,
  getCollator,
} from "@/api/lib/collation";

describe("getCollator", () => {
  test("caches one collator instance per locale", () => {
    expect(getCollator("cs")).toBe(getCollator("cs"));
    expect(getCollator("cs")).not.toBe(getCollator("sk"));
  });
});

describe("compareByLocale", () => {
  test('cs-CZ treats "ch" as its own letter, collated after "h"', () => {
    expect(["ia", "cha", "ha"].toSorted(compareByLocale("cs-CZ"))).toEqual([
      "ha",
      "cha",
      "ia",
    ]);
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
});
