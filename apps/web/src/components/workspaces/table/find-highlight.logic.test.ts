import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty, propertyConfig } from "@stll/property-testing";

import {
  splitByMatch,
  type TextSegment,
} from "@/components/workspaces/table/find-highlight.logic";

const joined = (text: string, term: string): string =>
  splitByMatch(text, term)
    .map((segment) => segment.text)
    .join("");

const PROPERTY_TEXT_PARTS_MAX = 12;
const PROPERTY_UNICODE_TOKENS = Object.freeze([
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
  "+",
  "😀",
  "\ud800",
  "\udc00",
]);

const unicodeText = fc
  .array(fc.constantFrom(...PROPERTY_UNICODE_TOKENS), {
    maxLength: PROPERTY_TEXT_PARTS_MAX,
  })
  .map((parts) => parts.join(""));

const previousSplitByMatch = (text: string, term: string): TextSegment[] => {
  if (term === "" || text === "") {
    return text === "" ? [] : [{ matched: false, start: 0, text }];
  }

  const haystack = text.toLocaleLowerCase().toWellFormed();
  const needle = term.toLocaleLowerCase().toWellFormed();
  if (haystack.length !== text.length || needle.length === 0) {
    return [{ matched: false, start: 0, text }];
  }

  const segments: TextSegment[] = [];
  let cursor = 0;
  for (
    let at = haystack.indexOf(needle);
    at !== -1;
    at = haystack.indexOf(needle, cursor)
  ) {
    if (at > cursor) {
      segments.push({
        matched: false,
        start: cursor,
        text: text.slice(cursor, at),
      });
    }
    segments.push({
      matched: true,
      start: at,
      text: text.slice(at, at + needle.length),
    });
    cursor = at + needle.length;
  }
  if (cursor < text.length) {
    segments.push({ matched: false, start: cursor, text: text.slice(cursor) });
  }
  return segments;
};

describe("splitting rendered text on a find term", () => {
  test("marks every occurrence, whatever its case", () => {
    expect(splitByMatch("Lease and lease", "LEASE")).toEqual([
      { matched: true, start: 0, text: "Lease" },
      { matched: false, start: 5, text: " and " },
      { matched: true, start: 10, text: "lease" },
    ]);
  });

  test("marks nothing for an empty term", () => {
    expect(splitByMatch("Lease", "")).toEqual([
      { matched: false, start: 0, text: "Lease" },
    ]);
  });

  test("marks adjacent occurrences separately", () => {
    expect(splitByMatch("aaaa", "aa")).toEqual([
      { matched: true, start: 0, text: "aa" },
      { matched: true, start: 2, text: "aa" },
    ]);
  });

  test("treats punctuation literally and leaves overlapping hits unmarked", () => {
    expect(splitByMatch("a+b ab a+b", "a+b")).toEqual([
      { matched: true, start: 0, text: "a+b" },
      { matched: false, start: 3, text: " ab " },
      { matched: true, start: 7, text: "a+b" },
    ]);
    expect(splitByMatch("aaa", "aa")).toEqual([
      { matched: true, start: 0, text: "aa" },
      { matched: false, start: 2, text: "a" },
    ]);
  });

  test("keeps UTF-16 offsets and does not add accent folding", () => {
    const text = "⚖️ Lease";
    const start = "⚖️ ".length;
    expect(splitByMatch(text, "lease")).toEqual([
      { matched: false, start: 0, text: "⚖️ " },
      { matched: true, start, text: "Lease" },
    ]);
    expect(splitByMatch("a\udc00b", "\udc00")).toEqual([
      { matched: false, start: 0, text: "a" },
      { matched: true, start: 1, text: "\udc00" },
      { matched: false, start: 2, text: "b" },
    ]);
    expect(splitByMatch("café", "cafe")).toEqual([
      { matched: false, start: 0, text: "café" },
    ]);
    expect(splitByMatch("cafe\u0301", "café")).toEqual([
      { matched: false, start: 0, text: "cafe\u0301" },
    ]);
  });

  test("leaves text unmarked when lowercase expansion changes its UTF-16 length", () => {
    const text = "İ";
    const lowered = text.toLocaleLowerCase();
    expect(lowered).not.toBe(text);
    expect(splitByMatch(text, lowered)).toEqual([
      { matched: false, start: 0, text },
    ]);
  });

  test("matches malformed text through replacement but never half an astral scalar", () => {
    expect(splitByMatch("a\ud800b", "\uFFFD")).toEqual([
      { matched: false, start: 0, text: "a" },
      { matched: true, start: 1, text: "\ud800" },
      { matched: false, start: 2, text: "b" },
    ]);
    expect(splitByMatch("😀", "\ude00")).toEqual([
      { matched: false, start: 0, text: "😀" },
    ]);
  });

  test("uses whitespace as a literal term rather than trimming it", () => {
    expect(splitByMatch("a b", " ")).toEqual([
      { matched: false, start: 0, text: "a" },
      { matched: true, start: 1, text: " " },
      { matched: false, start: 2, text: "b" },
    ]);
  });

  test("a segment starts where the input says it does", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (text, term) => {
        for (const segment of splitByMatch(text, term)) {
          expect(
            text.slice(segment.start, segment.start + segment.text.length),
          ).toBe(segment.text);
        }
      }),
      propertyConfig(),
    );
  });

  test("segments always reassemble into the input", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (text, term) => {
        expect(joined(text, term)).toBe(text);
      }),
      propertyConfig(),
    );
  });

  test("every marked segment equals the term, case-insensitively", () => {
    fc.assert(
      fc.property(fc.string(), fc.string({ minLength: 1 }), (text, term) => {
        for (const segment of splitByMatch(text, term)) {
          if (segment.matched) {
            expect(segment.text.toLocaleLowerCase().toWellFormed()).toBe(
              term.toLocaleLowerCase().toWellFormed(),
            );
          }
        }
      }),
      propertyConfig(),
    );
  });

  test("an empty term never marks anything", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        expect(splitByMatch(text, "").some((segment) => segment.matched)).toBe(
          false,
        );
      }),
      propertyConfig(),
    );
  });

  test("rendered search segments preserve the previous Unicode substring behavior", () => {
    assertProperty(
      "rendered search segments preserve the previous Unicode substring behavior",
      fc.property(
        fc.oneof(fc.string(), unicodeText),
        fc.oneof(fc.string(), unicodeText),
        (text, term) => {
          expect(splitByMatch(text, term)).toEqual(
            previousSplitByMatch(text, term),
          );
        },
      ),
      propertyConfig(),
    );
  });
});
