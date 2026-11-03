/**
 * The indexed reader search against the definition it replaces: a scan of
 * every position of the folded text with the shared word-prefix rule. The
 * index only changes how the words are found, so both must mark the same
 * spans, in the same order, with the same numbers.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { textAnchorSegmentOwnsRange } from "./document-ast-text";
import {
  queryFindTokens,
  queryMarkRanges,
  wordPrefixMatchEnd,
} from "./query-marks";
import { createReaderSearchIndex, searchReaderIndex } from "./reader-search";
import type { ReaderSearchMatchRange, SearchResults } from "./reader-search";

/**
 * Letters the reader folds (case, diacritics, letters that fold to two,
 * ligatures, Greek final sigma, Arabic variants and digits, an astral letter,
 * a decomposed mark, a character that folds around a separator), next to the
 * separators it splits on.
 */
const CHARACTERS = [
  "a",
  "b",
  "o",
  "d",
  "p",
  "S",
  "Á",
  "á",
  "č",
  "Č",
  "é",
  "ß",
  "ẞ",
  "ﬁ",
  "Æ",
  "ł",
  "½",
  "İ",
  "Σ",
  "σ",
  "ς",
  "أ",
  "ة",
  "ه",
  "ـ",
  "٢",
  "2",
  "\u{10348}",
  "😀",
  "_",
  " ",
  "  ",
  ".",
  "§",
  "\t",
  "-",
] as const;

/** Words that share prefixes, so one token reaches several of them. */
const WORDS = [
  "odpověd",
  "Odpovědnost",
  "odpovědnosti",
  "ODPOVĚDNÝ",
  "abc",
  "abcd",
  "Ábčd",
  "e\u0301abc",
  "\u{10348}abc",
  "Straße",
  "STRASSE",
  "ﬁnále",
  "Łódź",
  "ΣΟΦΟΣ",
  "σοφος",
  "أحمد",
  "احمد",
  "٢٠٢٤",
  "2024",
  "a_b",
] as const;

const SEPARATORS = [" ", "  ", ". ", ", ", "§ ", "\t", "-", "_"] as const;

/** Words between separators, or loose characters, or both mixed. */
const textArb = fc
  .array(
    fc.oneof(
      fc
        .tuple(fc.constantFrom(...WORDS), fc.constantFrom(...SEPARATORS))
        .map(([word, separator]) => word + separator),
      fc.constantFrom(...CHARACTERS),
    ),
    { maxLength: 30 },
  )
  .map((parts) => parts.join(""));

const piecesArb = fc
  .array(textArb, { minLength: 1, maxLength: 6 })
  .map((texts) =>
    texts.map((text, index) => ({ id: `p${String(index)}`, text })),
  );

/** One to three words, each possibly cut short, or loose text. */
const queryArb = fc.oneof(
  fc
    .array(
      fc
        .tuple(fc.constantFrom(...WORDS), fc.integer({ min: 1, max: 12 }))
        .map(([word, length]) => word.slice(0, length)),
      { minLength: 1, maxLength: 3 },
    )
    .map((words) => words.join(" ")),
  textArb,
);

/** The scan the index replaced, over the index's own folded text. */
const scanResults = (
  index: ReturnType<typeof createReaderSearchIndex>,
  query: string,
): SearchResults => {
  const tokens = queryFindTokens(query);
  const rangesByPieceId: Record<string, ReaderSearchMatchRange[]> = {};
  let matchCount = 0;
  if (tokens.length === 0) {
    return { matchCount, rangesByPieceId };
  }
  for (const piece of index.pieces) {
    const { endMap, startMap, text } = piece.folded;
    let position = 0;
    while (position < text.length) {
      const end = wordPrefixMatchEnd(text, position, tokens);
      if (end === null || end === position) {
        position += 1;
        continue;
      }
      const start = startMap[position];
      const last = endMap[end - 1];
      if (start !== undefined && last !== undefined) {
        const ranges = rangesByPieceId[piece.id] ?? [];
        ranges.push({
          end: last,
          matchIndex: matchCount,
          start,
          type: "search",
        });
        rangesByPieceId[piece.id] = ranges;
        matchCount += 1;
      }
      position = end;
    }
  }
  return { matchCount, rangesByPieceId };
};

describe("indexed reader search", () => {
  test("random citation run splits preserve its text and choose one badge owner", () => {
    const citation = "sp.\u00a0zn. II. ÚS 1852/22";
    assertProperty(
      "random citation run splits preserve its text and choose one badge owner",
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: citation.length - 1 }), {
          maxLength: citation.length - 1,
        }),
        (generatedCuts) => {
          const cuts = [
            0,
            ...generatedCuts.toSorted((a, b) => a - b),
            citation.length,
          ];
          const runs = cuts.slice(0, -1).map((start, index) => ({
            start,
            text: citation.slice(start, cuts[index + 1]),
          }));

          expect(runs.map(({ text }) => text).join("")).toBe(citation);
          expect(
            runs.filter(({ start }) =>
              textAnchorSegmentOwnsRange({ start: 0 }, start),
            ),
          ).toHaveLength(1);
        },
      ),
    );
  });

  test("indexed search marks exactly what a scan of the folded text marks", () => {
    assertProperty(
      "indexed search marks exactly what a scan of the folded text marks",
      fc.property(piecesArb, queryArb, (pieces, query) => {
        const index = createReaderSearchIndex(pieces);
        expect(searchReaderIndex(index, query)).toEqual(
          scanResults(index, query),
        );
      }),
    );
  });

  /**
   * The results table marks a headnote with `queryMarkRanges`; the reader
   * marks the decision with its index. Same text, same query, same runs.
   */
  test("the reader's find marks exactly what a headnote mark marks", () => {
    assertProperty(
      "the reader's find marks exactly what a headnote mark marks",
      fc.property(piecesArb, queryArb, (pieces, query) => {
        const { rangesByPieceId } = searchReaderIndex(
          createReaderSearchIndex(pieces),
          query,
        );
        const tokens = queryFindTokens(query);
        for (const piece of pieces) {
          expect(
            (rangesByPieceId[piece.id] ?? []).map(({ end, start }) => ({
              end,
              start,
            })),
          ).toEqual(queryMarkRanges(piece.text, tokens));
        }
      }),
    );
  });

  test("the generated text reaches matches the scan finds", () => {
    // Guards the property above against a generator that never matches: a
    // fixed piece built from the same characters has hits both ways.
    const index = createReaderSearchIndex([
      { id: "p0", text: "Ábč ábčd éab \u{10348}abc ΣΣΣ abc_abc" },
    ]);
    const scanned = scanResults(index, "abc");
    expect(scanned.matchCount).toBeGreaterThan(1);
    expect(searchReaderIndex(index, "abc")).toEqual(scanned);
  });
});
