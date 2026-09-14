import { describe, expect, test } from "bun:test";

import type { OutlineItem } from "@stll/ui/outline-rail";

import {
  clampSelectedIndex,
  outlineMatchItems,
  rankOutlineMatches,
} from "@/components/legal-reader/outline-jump-field.logic";

/**
 * A § act, with the near-misses `10` drags in: the suffixed section, the
 * three-digit sections it prefixes, a section merely containing it, and a
 * container whose printed range does.
 */
const items: OutlineItem[] = [
  {
    id: "cast-1",
    label: "Část první",
    level: 0,
    meta: "§ 1–310",
    title: "Obecná část",
  },
  { id: "hlava-1", label: "Hlava I", level: 1, meta: "§ 1–9" },
  {
    id: "p-10",
    label: "§ 10",
    level: 2,
    title: "Zastoupení členem domácnosti",
  },
  { id: "p-10a", label: "§ 10a", level: 2 },
  { id: "p-100", label: "§ 100", level: 2 },
  { id: "p-105", label: "§ 105", level: 2 },
  { id: "p-210", label: "§ 210", level: 2 },
];

const matchedIds = (query: string): string[] =>
  rankOutlineMatches(items, query).matches.map((match) => match.item.id);

describe("rankOutlineMatches", () => {
  test("puts the section a bare number names above the ones containing it", () => {
    expect(matchedIds("10")).toEqual([
      "p-10",
      "p-10a",
      "p-100",
      "p-105",
      "cast-1",
      "p-210",
    ]);
    expect(rankOutlineMatches(items, "10").exactId).toBe("p-10");
  });

  test("spelling out the marker keeps the numbering, drops the incidental", () => {
    // § 210 and the part whose range prints `310` state the digits `10`
    // without being about § 10; a spelled-out designation is not a substring.
    expect(matchedIds("§ 10")).toEqual(["p-10", "p-10a", "p-100", "p-105"]);
    expect(rankOutlineMatches(items, "§10").exactId).toBe("p-10");
  });

  test("a suffixed section is named exactly, not as a prefix", () => {
    expect(rankOutlineMatches(items, "10a").exactId).toBe("p-10a");
    expect(matchedIds("10a").at(0)).toBe("p-10a");
  });

  test("a marker the act does not number by names nothing", () => {
    const articles: OutlineItem[] = [
      { id: "art-10", label: "Art. 10", level: 0 },
    ];

    expect(rankOutlineMatches(items, "čl. 10")).toEqual({
      exactId: null,
      matches: [],
    });
    expect(rankOutlineMatches(articles, "§ 10").matches).toEqual([]);
  });

  test("a bare number reaches whichever marker the act prints", () => {
    const articles: OutlineItem[] = [
      { id: "art-10", label: "Art. 10", level: 0 },
    ];

    expect(rankOutlineMatches(articles, "10").exactId).toBe("art-10");
  });

  test("titles match without their diacritics, and name nothing exactly", () => {
    const byTitle = rankOutlineMatches(items, "zastoupeni clenem");

    expect(byTitle.matches.map((match) => match.item.id)).toEqual(["p-10"]);
    expect(byTitle.exactId).toBeNull();
  });

  test("an empty field leaves the outline to the caller", () => {
    expect(rankOutlineMatches(items, "   ")).toEqual({
      exactId: null,
      matches: [],
    });
  });

  test("a query the act has no answer for matches nothing", () => {
    expect(rankOutlineMatches(items, "§ 9999")).toEqual({
      exactId: null,
      matches: [],
    });
    expect(rankOutlineMatches(items, "zzz").matches).toEqual([]);
  });
});

describe("outlineMatchItems", () => {
  test("flattens the results and steps back everything but the named one", () => {
    const result = outlineMatchItems(rankOutlineMatches(items, "10"));

    expect(result.map((item) => item.level)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(result.map((item) => item.emphasis)).toEqual([
      undefined,
      "secondary",
      "secondary",
      "secondary",
      "secondary",
      "secondary",
    ]);
  });

  test("leaves every result primary when the query names nothing", () => {
    const result = outlineMatchItems(
      rankOutlineMatches(items, "zastoupeni clenem"),
    );

    expect(result.map((item) => item.emphasis)).toEqual([undefined]);
  });

  test("carries the entry's own text through to the row", () => {
    const [first] = outlineMatchItems(rankOutlineMatches(items, "10"));

    expect(first?.label).toBe("§ 10");
    expect(first?.title).toBe("Zastoupení členem domácnosti");
  });
});

describe("clampSelectedIndex", () => {
  test("a selection the list outgrew lands on its last entry", () => {
    // The reader had selected the eighth match and the act's next
    // consolidation states three: the highlight must not vanish.
    expect(clampSelectedIndex({ count: 3, index: 7 })).toBe(2);
  });

  test("a list with nothing in it selects nothing to move", () => {
    expect(clampSelectedIndex({ count: 0, index: 4 })).toBe(0);
  });

  test("moving past either end stays at that end", () => {
    expect(clampSelectedIndex({ count: 3, index: -1 })).toBe(0);
    expect(clampSelectedIndex({ count: 3, index: 1 })).toBe(1);
  });
});
