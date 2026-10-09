import { describe, expect, it } from "bun:test";

import { buildSearchResults } from "./reader-search";

describe("buildSearchResults", () => {
  it("matches case-insensitively and ignores diacritics", () => {
    const result = buildSearchResults({
      pieces: [{ id: "p1", text: "Ústavní soud rozhodl." }],
      query: "ustavni",
    });

    expect(result.matchCount).toBe(1);
    expect(result.rangesByPieceId["p1"]).toEqual([
      { type: "search", start: 0, end: 7, matchIndex: 0 },
    ]);
  });

  // The corpus almost never repeats the reader's phrase verbatim, so a
  // multi-word query is its words: each one marked where the text uses it,
  // apart and in the publisher's own spelling.
  it("marks every word of the query, wherever it is used", () => {
    const text = "Náhrada škody a jiné újmy.";
    const result = buildSearchResults({
      pieces: [{ id: "p1", text }],
      query: "náhrada újmy",
    });

    expect(result.matchCount).toBe(2);
    expect(
      result.rangesByPieceId["p1"]?.map((range) =>
        text.slice(range.start, range.end),
      ),
    ).toEqual(["Náhrada", "újmy"]);
  });

  // An inflected corpus writes the word the sentence needs, not the one the
  // reader typed; marking the prefix alone would leave a stray ending behind.
  it("marks the whole inflected word, not the prefix that matched", () => {
    const result = buildSearchResults({
      pieces: [{ id: "p1", text: "Rozsah odpovědnosti žalovaného." }],
      query: "odpovědnost",
    });

    expect(result.matchCount).toBe(1);
    const [range] = result.rangesByPieceId["p1"] ?? [];
    expect(
      "Rozsah odpovědnosti žalovaného.".slice(range?.start, range?.end),
    ).toBe("odpovědnosti");
  });

  it("does not mark the middle of an unrelated word", () => {
    expect("doprava").toContain("pra");

    const result = buildSearchResults({
      pieces: [{ id: "p1", text: "Doprava a pravidlo." }],
      query: "pra",
    });

    expect(result.matchCount).toBe(1);
    expect(result.rangesByPieceId["p1"]).toEqual([
      { type: "search", start: 10, end: 18, matchIndex: 0 },
    ]);
  });

  it("treats punctuation and repeated whitespace as separators", () => {
    const result = buildSearchResults({
      pieces: [{ id: "p1", text: "§ 13, odst. 1  obč. zák." }],
      query: "odst obc zak",
    });

    expect(result.matchCount).toBe(3);
    expect(result.rangesByPieceId["p1"]).toEqual([
      { type: "search", start: 6, end: 10, matchIndex: 0 },
      { type: "search", start: 15, end: 18, matchIndex: 1 },
      { type: "search", start: 20, end: 23, matchIndex: 2 },
    ]);
  });

  it("counts matches across multiple pieces in render order", () => {
    const result = buildSearchResults({
      pieces: [
        { id: "p1", text: "Smith v. Jones" },
        { id: "p2", text: "Jones cited Smith again." },
      ],
      query: "smith",
    });

    expect(result.matchCount).toBe(2);
    expect(result.rangesByPieceId).toEqual({
      p1: [{ type: "search", start: 0, end: 5, matchIndex: 0 }],
      p2: [{ type: "search", start: 12, end: 17, matchIndex: 1 }],
    });
  });

  it("has nothing to mark for a query of words too short to mean anything", () => {
    const result = buildSearchResults({
      pieces: [{ id: "p1", text: "Za to je odpovědný." }],
      query: "za to",
    });

    expect(result.matchCount).toBe(0);
    expect(result.rangesByPieceId).toEqual({});
  });

  it("handles contextual lowercasing such as Greek final sigma", () => {
    const result = buildSearchResults({
      pieces: [{ id: "p1", text: "ΛΟΓΟΣ" }],
      query: "λόγος",
    });

    expect(result.matchCount).toBe(1);
    expect(result.rangesByPieceId["p1"]).toEqual([
      { type: "search", start: 0, end: 5, matchIndex: 0 },
    ]);
  });

  it("folds Arabic presentation forms copied from a PDF", () => {
    const result = buildSearchResults({
      pieces: [{ id: "p1", text: "ﺍﺣﻤﺪ" }],
      query: "احمد",
    });

    expect(result.matchCount).toBe(1);
  });

  it("folds decomposed Arabic hamza marks copied from OCR", () => {
    // Alef followed by a combining hamza above, as OCR emits it.
    // Decomposed here rather than written as a literal: a formatter or an
    // editor may compose the literal back into one code point and leave the
    // decomposition this test is about untested. The length says it did not.
    const decomposed = "أحمد".normalize("NFD");
    expect(decomposed).toHaveLength(5);

    const result = buildSearchResults({
      pieces: [{ id: "p1", text: decomposed }],
      query: "احمد",
    });

    expect(result.matchCount).toBe(1);
    expect(result.rangesByPieceId["p1"]).toEqual([
      { type: "search", start: 0, end: 5, matchIndex: 0 },
    ]);
  });

  it("folds Arabic alef-hamza and teh-marbuta variants", () => {
    const result = buildSearchResults({
      pieces: [{ id: "p1", text: "خدمة أحمد" }],
      query: "خدمه احمد",
    });

    expect(result.matchCount).toBe(2);
    expect(result.rangesByPieceId["p1"]).toEqual([
      { type: "search", start: 0, end: 4, matchIndex: 0 },
      { type: "search", start: 5, end: 9, matchIndex: 1 },
    ]);
  });

  it("ignores Arabic tatweel and folds Arabic-Indic digits", () => {
    const result = buildSearchResults({
      pieces: [{ id: "p1", text: "رقم ٢٠٢٤" }],
      query: "2024",
    });

    expect(result.matchCount).toBe(1);
    expect(result.rangesByPieceId["p1"]).toEqual([
      { type: "search", start: 4, end: 8, matchIndex: 0 },
    ]);
  });

  // The word starts with an astral letter, so "abc" is inside it, not at a
  // word start: a unit-wise boundary check would mark the tail of the word.
  it("does not mark inside a word that opens with an astral letter", () => {
    const result = buildSearchResults({
      pieces: [{ id: "p1", text: "\u{10348}abc" }],
      query: "abc",
    });

    expect(result.matchCount).toBe(0);
  });

  it("locates matches after astral-plane characters", () => {
    // U+10348 (Gothic letter hwair, "𐍈") is a non-BMP letter encoded as a
    // UTF-16 surrogate pair. Offsets are code-unit offsets, so the normalizer
    // and the offset maps must stay aligned with those units even when a
    // single code point consumes two of them in the source.
    const result = buildSearchResults({
      pieces: [{ id: "p1", text: "𐍈 abc" }],
      query: "abc",
    });

    expect(result.matchCount).toBe(1);
    expect(result.rangesByPieceId["p1"]).toEqual([
      { type: "search", start: 3, end: 6, matchIndex: 0 },
    ]);
  });
});
