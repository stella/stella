import { describe, expect, test } from "bun:test";

import {
  findSearchMatchRanges,
  foldSearchMatchText,
  foldSearchMatchTextWithOffsets,
} from "./search-match.js";

describe("foldSearchMatchText", () => {
  test("strips diacritics and lowercases", () => {
    expect(foldSearchMatchText("Čapek")).toBe("capek");
    expect(foldSearchMatchText("Uherské Hradiště")).toBe("uherske hradiste");
  });

  test("folds decomposed input to the same key as precomposed", () => {
    expect(foldSearchMatchText("C\u030Capek")).toBe(
      foldSearchMatchText("\u010Capek"),
    );
  });

  test("folds compatibility characters", () => {
    expect(foldSearchMatchText("ﬁling")).toBe("filing");
  });

  test("folds letters without a canonical decomposition", () => {
    expect(foldSearchMatchText("Wrocław")).toBe("wroclaw");
    expect(foldSearchMatchText("Søren Đorđe")).toBe("soren dorde");
    expect(foldSearchMatchText("Straße")).toBe("strasse");
  });
});

describe("findSearchMatchRanges", () => {
  test("matches a plain query against accented text", () => {
    expect(findSearchMatchRanges("Karel Čapek", "capek")).toEqual([
      { start: 6, end: 11 },
    ]);
  });

  test("matches an accented query against plain text", () => {
    expect(findSearchMatchRanges("karel capek", "Čapek")).toEqual([
      { start: 6, end: 11 },
    ]);
  });

  test("ranges cover the original characters when folding changes length", () => {
    const content = "smlouva – ﬁnal Čapek";
    const [match] = findSearchMatchRanges(content, "final");
    expect(match).toBeDefined();
    if (match) {
      expect(content.slice(match.start, match.end)).toBe("ﬁnal");
    }
  });

  test("returns non-overlapping occurrences in order", () => {
    expect(findSearchMatchRanges("řada řad neřadí", "řad")).toEqual([
      { start: 0, end: 3 },
      { start: 5, end: 8 },
      { start: 11, end: 14 },
    ]);
  });

  test("respects maxMatches", () => {
    expect(findSearchMatchRanges("a b a b a", "a", { maxMatches: 2 })).toEqual([
      { start: 0, end: 1 },
      { start: 4, end: 5 },
    ]);
  });

  test("accepts pre-folded content", () => {
    const folded = foldSearchMatchTextWithOffsets("Judikát NS");
    expect(findSearchMatchRanges(folded, "judikat")).toEqual([
      { start: 0, end: 7 },
    ]);
  });

  test("returns nothing for an empty query", () => {
    expect(findSearchMatchRanges("Čapek", "  ")).toEqual([]);
  });

  test("ranges cover expanding folds", () => {
    const content = "sídlo: Wrocław, Straße 7";
    const [wroclaw] = findSearchMatchRanges(content, "wroclaw");
    const [strasse] = findSearchMatchRanges(content, "strasse");
    expect(wroclaw && content.slice(wroclaw.start, wroclaw.end)).toBe(
      "Wrocław",
    );
    expect(strasse && content.slice(strasse.start, strasse.end)).toBe("Straße");
  });
});
