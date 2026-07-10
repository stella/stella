import { describe, expect, test } from "bun:test";

import { compareByLocale, getCollator } from "@/api/lib/collation";

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
