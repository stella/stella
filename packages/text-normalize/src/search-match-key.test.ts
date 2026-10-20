import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import {
  containsSearchMatchKey,
  findSearchMatchKeyRanges,
} from "@stll/text-normalize/search-match-key";

describe("literal search match keys", () => {
  test("does not add case, accent, compatibility, or whitespace folding", () => {
    expect(containsSearchMatchKey("Čapkovým", "čap")).toBe(false);
    expect(containsSearchMatchKey("čapkovým", "cap")).toBe(false);
    expect(containsSearchMatchKey("čapkovým", "čapkov")).toBe(true);
    expect(containsSearchMatchKey("ﬁle", "file")).toBe(false);
    expect(containsSearchMatchKey("a b", " b ")).toBe(false);
    expect(containsSearchMatchKey("οσ", "ς")).toBe(false);
    expect(containsSearchMatchKey("Čapek", "")).toBe(true);
    expect(containsSearchMatchKey("", "")).toBe(true);
    expect(containsSearchMatchKey("", "x")).toBe(false);
  });

  test("treats punctuation literally and replaces lone surrogates on both sides", () => {
    expect(containsSearchMatchKey("Novák [a.b]+", "[a.b]+")).toBe(true);
    expect(containsSearchMatchKey("Novák axb", "a.b")).toBe(false);
    expect(containsSearchMatchKey("aaaa", "aaa")).toBe(true);
    expect(containsSearchMatchKey("😀", "\ude00")).toBe(false);
    expect(containsSearchMatchKey("a\ud800b", "\udc00")).toBe(true);
    expect(containsSearchMatchKey("a�b", "\ud800")).toBe(true);
  });
});

describe("literal search match-key ranges", () => {
  test("keeps Unicode, inflections, punctuation, and UTF-16 offsets literal", () => {
    expect(
      findSearchMatchKeyRanges("😀 Čapkovým Čapkovým", "Čapkovým"),
    ).toEqual([
      { start: 3, end: 11 },
      { start: 12, end: 20 },
    ]);
    expect(findSearchMatchKeyRanges("a+b ab a+b", "a+b")).toEqual([
      { start: 0, end: 3 },
      { start: 7, end: 10 },
    ]);
    expect(findSearchMatchKeyRanges("Čapkovým", "čapkovým")).toEqual([]);
    expect(findSearchMatchKeyRanges("čapkovým", "capkovym")).toEqual([]);
    expect(findSearchMatchKeyRanges("C\u030Capek", "Čapek")).toEqual([]);
    expect(findSearchMatchKeyRanges("οσ ﬁle", "ς")).toEqual([]);
    expect(findSearchMatchKeyRanges("οσ ﬁle", "file")).toEqual([]);
    expect(findSearchMatchKeyRanges("😀", "\ude00")).toEqual([]);
    expect(findSearchMatchKeyRanges("a\ud800b", "\udc00")).toEqual([
      { start: 1, end: 2 },
    ]);
    expect(findSearchMatchKeyRanges("a�b", "\ud800")).toEqual([
      { start: 1, end: 2 },
    ]);
    expect(findSearchMatchKeyRanges("a\ud800b", "\ud800")).toEqual([
      { start: 1, end: 2 },
    ]);
  });

  test("does not trim and reports adjacent, non-overlapping occurrences", () => {
    expect(findSearchMatchKeyRanges("aaaaa", "aa")).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
    expect(findSearchMatchKeyRanges(" a a ", " ")).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 3 },
      { start: 4, end: 5 },
    ]);
    expect(findSearchMatchKeyRanges("a", " a ")).toEqual([]);
    expect(findSearchMatchKeyRanges("a", "")).toEqual([]);
    expect(findSearchMatchKeyRanges("", "a")).toEqual([]);
  });

  test("bounds matches without shifting their content offsets", () => {
    const content = "aba aba aba";
    expect(
      findSearchMatchKeyRanges(content, "aba", { start: 1, end: 10 }),
    ).toEqual([{ start: 4, end: 7 }]);
    expect(
      findSearchMatchKeyRanges(content, "aba", { start: 4, end: 7 }),
    ).toEqual([{ start: 4, end: 7 }]);
    expect(findSearchMatchKeyRanges(content, "aba", { maxMatches: 1 })).toEqual(
      [{ start: 0, end: 3 }],
    );
    expect(
      findSearchMatchKeyRanges(content, "aba", { start: 4, maxMatches: 1 }),
    ).toEqual([{ start: 4, end: 7 }]);
  });

  test("clamps bounds and floors limits with explicit empty-window behavior", () => {
    expect(
      findSearchMatchKeyRanges("a a a", "a", {
        start: -Infinity,
        end: Infinity,
        maxMatches: Infinity,
      }),
    ).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 3 },
      { start: 4, end: 5 },
    ]);
    expect(
      findSearchMatchKeyRanges("a a a", "a", {
        start: 1.9,
        end: 5.9,
        maxMatches: 1.9,
      }),
    ).toEqual([{ start: 2, end: 3 }]);
    expect(findSearchMatchKeyRanges("a a a", "a", { maxMatches: 0 })).toEqual(
      [],
    );
    expect(findSearchMatchKeyRanges("a a a", "a", { maxMatches: -1 })).toEqual(
      [],
    );
    expect(findSearchMatchKeyRanges("a a a", "a", { maxMatches: 0.9 })).toEqual(
      [],
    );
    expect(
      findSearchMatchKeyRanges("a a a", "a", { start: 4, end: 2 }),
    ).toEqual([]);
    expect(findSearchMatchKeyRanges("a a a", "a", { start: Infinity })).toEqual(
      [],
    );
    expect(findSearchMatchKeyRanges("a a a", "a", { end: -1 })).toEqual([]);
    expect(
      findSearchMatchKeyRanges("a a a", "a", { start: Number.NaN }),
    ).toEqual([]);
    expect(findSearchMatchKeyRanges("a a a", "a", { end: Number.NaN })).toEqual(
      [],
    );
    expect(
      findSearchMatchKeyRanges("a a a", "a", { maxMatches: Number.NaN }),
    ).toEqual([]);
  });

  test("literal ranges agree with bounded string partitioning", () => {
    const TEXT_PARTS_MAX = 30;
    const QUERY_PARTS_MAX = 6;
    const OFFSET_BOUND = 40;
    const MATCH_LIMIT_MAX = 12;
    const part = fc.constantFrom(
      "a",
      "b",
      "Č",
      "č",
      "á",
      "e\u0301",
      " ",
      "\n",
      "[",
      ".",
      "+",
      "😀",
      "\ud800",
      "\ude00",
    );
    const text = fc
      .array(part, { maxLength: TEXT_PARTS_MAX })
      .map((parts) => parts.join(""));
    const query = fc
      .array(part, { maxLength: QUERY_PARTS_MAX })
      .map((parts) => parts.join(""));
    assertProperty(
      "literal ranges agree with bounded string partitioning",
      fc.property(
        text,
        query,
        fc.integer({ min: 0, max: OFFSET_BOUND }),
        fc.integer({ min: 0, max: OFFSET_BOUND }),
        fc.integer({ min: 0, max: MATCH_LIMIT_MAX }),
        (content, needle, lower, upper, maxMatches) => {
          const haystack = content.toWellFormed();
          const pattern = needle.toWellFormed();
          const start = Math.min(content.length, lower);
          const end = Math.min(content.length, upper);
          const expected = [];
          if (pattern.length > 0 && start < end) {
            let cursor = start;
            const parts = haystack.slice(start, end).split(pattern);
            for (const partBeforeMatch of parts.slice(0, -1)) {
              cursor += partBeforeMatch.length;
              expected.push({ start: cursor, end: cursor + pattern.length });
              cursor += pattern.length;
            }
          }
          expect(
            findSearchMatchKeyRanges(content, needle, {
              start: lower,
              end: upper,
              maxMatches,
            }),
          ).toEqual(expected.slice(0, maxMatches));
        },
      ),
    );
  });
});
