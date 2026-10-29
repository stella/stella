import { describe, expect, test } from "bun:test";

import {
  findSearchMatchRanges,
  foldSearchMatchText,
  foldSearchMatchTextWithOffsets,
  hasFoldedSearchMatch,
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

  test("keeps spacing marks that are text, not accents", () => {
    expect(foldSearchMatchText("コーヒー")).toBe("コーヒー");
    expect(findSearchMatchRanges("コーヒーとコヒ", "コヒ")).toEqual([
      { start: 5, end: 7 },
    ]);
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

  test("reports an expanding fold once and reaches later hits", () => {
    expect(findSearchMatchRanges("ßs", "s")).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 2 },
    ]);
    expect(findSearchMatchRanges("ßs", "s", { maxMatches: 2 })).toHaveLength(2);
  });

  test("treats final and medial sigma alike", () => {
    expect(findSearchMatchRanges("ΟΣ", "σ")).toEqual([{ start: 1, end: 2 }]);
    expect(findSearchMatchRanges("οσ", "ς")).toEqual([{ start: 1, end: 2 }]);
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

describe("search match options", () => {
  const content = "ČEZ ESCO, a.s. a čezký cez";
  const matched = (
    query: string,
    options: Parameters<typeof findSearchMatchRanges>[2],
  ) =>
    findSearchMatchRanges(content, query, options).map(({ start, end }) =>
      content.slice(start, end),
    );

  test("match case keeps diacritic folding", () => {
    expect(matched("ČEZ", { matchCase: true })).toEqual(["ČEZ"]);
    expect(matched("CEZ", { matchCase: true })).toEqual(["ČEZ"]);
    expect(matched("čez", { matchCase: true })).toEqual(["čez", "cez"]);
  });

  test("match diacritics keeps case folding and never splits an accent", () => {
    expect(matched("čez", { matchDiacritics: true })).toEqual(["ČEZ", "čez"]);
    expect(matched("cez", { matchDiacritics: true })).toEqual(["cez"]);
    // A decomposed caron in the content still matches a composed query.
    expect(
      findSearchMatchRanges("C\u030CEZ", "Č", { matchDiacritics: true }),
    ).toEqual([{ start: 0, end: 2 }]);
    expect(
      findSearchMatchRanges("C\u030CEZ", "C", { matchDiacritics: true }),
    ).toEqual([]);
  });

  test("match case and diacritics together match as written", () => {
    expect(matched("ČEZ", { matchCase: true, matchDiacritics: true })).toEqual([
      "ČEZ",
    ]);
    expect(matched("CEZ", { matchCase: true, matchDiacritics: true })).toEqual(
      [],
    );
  });

  test("whole words rejects a match inside a word", () => {
    expect(matched("čez", { wholeWords: true })).toEqual(["ČEZ", "cez"]);
    expect(matched("a", { wholeWords: true })).toEqual(["a", "a"]);
    // A query edge that is punctuation needs no boundary on that side.
    expect(matched("a.s.", { wholeWords: true })).toEqual(["a.s."]);
    expect(
      findSearchMatchRanges("Wrocławski", "wroclaw", { wholeWords: true }),
    ).toEqual([]);
  });

  test("whole words skips a rejected hit and finds a later one", () => {
    expect(
      findSearchMatchRanges("xab ab", "ab", {
        maxMatches: 1,
        wholeWords: true,
      }),
    ).toEqual([{ start: 4, end: 6 }]);
  });

  test("hasFoldedSearchMatch agrees with the ranges", () => {
    const options = { matchDiacritics: true, wholeWords: true };
    const folded = foldSearchMatchText(content, options);
    const query = (value: string) => foldSearchMatchText(value, options);
    expect(hasFoldedSearchMatch(folded, query("cez"), options)).toBe(true);
    expect(hasFoldedSearchMatch(folded, query("esc"), options)).toBe(false);
    expect(hasFoldedSearchMatch(folded, query("čezký"), options)).toBe(true);
    expect(hasFoldedSearchMatch(folded, "", options)).toBe(false);
  });

  test("default options keep the existing folds", () => {
    expect(foldSearchMatchText("Čapek", {})).toBe(foldSearchMatchText("Čapek"));
    expect(matched("cez", {})).toEqual(["ČEZ", "čez", "cez"]);
  });
});
