import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty, propertyConfig } from "@stll/property-testing";
import { foldLikePostgresSearch } from "@stll/text-normalize/postgres-search-fold";

import { splitByMatch } from "@/components/workspaces/table/find-highlight.logic";

const joined = (text: string, term: string): string =>
  splitByMatch(text, term)
    .map((segment) => segment.text)
    .join("");

const markedRuns = (text: string, term: string): string[] =>
  splitByMatch(text, term)
    .filter((segment) => segment.matched)
    .map((segment) => segment.text);

const PROPERTY_TEXT_PARTS_MAX = 12;
const PROPERTY_UNICODE_TOKENS = Object.freeze([
  "a",
  "A",
  " ",
  "\t",
  "é",
  "é",
  "́",
  "Ł",
  "İ",
  "ı",
  "ß",
  "Æ",
  "％",
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

describe("splitting rendered text on a find term", () => {
  test("marks every occurrence, whatever its case", () => {
    expect(splitByMatch("Lease and lease", "LEASE")).toEqual([
      { matched: true, start: 0, text: "Lease" },
      { matched: false, start: 5, text: " and " },
      { matched: true, start: 10, text: "lease" },
    ]);
  });

  test("marks what the server matched whatever accents were typed", () => {
    // The server folds both sides through `search_fold`: these are the rows
    // a find for the plain term returns, so their marks must be drawn.
    expect(markedRuns("Antonín Dvořák", "dvorak")).toEqual(["Dvořák"]);
    expect(markedRuns("Jürgen Müller", "MULLER")).toEqual(["Müller"]);
    expect(markedRuns("Élise Moreau", "elise")).toEqual(["Élise"]);
    expect(markedRuns("smlouva dvorak", "Dvořák")).toEqual(["dvorak"]);
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

  test("keeps UTF-16 offsets across folds that change length", () => {
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
    // A decomposed accent stays on the letter it belongs to.
    expect(splitByMatch("café noir", "café")).toEqual([
      { matched: true, start: 0, text: "café" },
      { matched: false, start: 5, text: " noir" },
    ]);
    // An expansion is marked whole.
    expect(splitByMatch("Straße", "strass")).toEqual([
      { matched: true, start: 0, text: "Straß" },
      { matched: false, start: 5, text: "e" },
    ]);
  });

  test("does not fold beyond what the server folds", () => {
    // `unaccent` has no rule for final sigma, so `σ` never matched `ς` on
    // the server and must not be marked here.
    expect(markedRuns("ΟΔΟΣ ος", "σ")).toEqual(["Σ"]);
  });

  test("lowers one code point to one, as the server does", () => {
    expect(markedRuns("İstanbul", "istanbul")).toEqual(["İstanbul"]);
  });

  test("matches malformed text through replacement but never half an astral scalar", () => {
    expect(splitByMatch("a\ud800b", "�")).toEqual([
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
      fc.property(
        fc.oneof(fc.string(), unicodeText),
        fc.oneof(fc.string(), unicodeText),
        (text, term) => {
          expect(joined(text, term)).toBe(text);
        },
      ),
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

  test("text is marked exactly when the server's fold of it contains the term", () => {
    assertProperty(
      "text is marked exactly when the server's fold of it contains the term",
      fc.property(unicodeText, unicodeText, (text, term) => {
        const needle = foldLikePostgresSearch(term);
        fc.pre(needle !== "");
        const runs = markedRuns(text, term);

        expect(runs.length > 0).toBe(
          foldLikePostgresSearch(text).includes(needle),
        );
        for (const run of runs) {
          expect(foldLikePostgresSearch(run).includes(needle)).toBe(true);
        }
      }),
      propertyConfig(),
    );
  });
});
