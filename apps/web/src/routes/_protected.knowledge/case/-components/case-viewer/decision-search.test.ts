import { describe, expect, it } from "bun:test";

import { buildSearchResults } from "./decision-search";

describe("buildSearchResults", () => {
  it("matches case-insensitively and ignores diacritics", () => {
    const result = buildSearchResults({
      pieces: [{ id: "p1", text: "Ústavní soud rozhodl." }],
      query: "ustavni",
    });

    expect(result.matchCount).toBe(1);
    expect(result.rangesByPieceId.p1).toEqual([
      { start: 0, end: 7, matchIndex: 0 },
    ]);
  });

  it("treats punctuation and repeated whitespace as separators", () => {
    const result = buildSearchResults({
      pieces: [{ id: "p1", text: "§ 13, odst. 1  obč. zák." }],
      query: "13 odst 1 obc zak",
    });

    expect(result.matchCount).toBe(1);
    expect(result.rangesByPieceId.p1).toEqual([
      { start: 2, end: 23, matchIndex: 0 },
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
      p1: [{ start: 0, end: 5, matchIndex: 0 }],
      p2: [{ start: 12, end: 17, matchIndex: 1 }],
    });
  });

  it("handles contextual lowercasing such as Greek final sigma", () => {
    const result = buildSearchResults({
      pieces: [{ id: "p1", text: "ΟΣ" }],
      query: "ος",
    });

    expect(result.matchCount).toBe(1);
    expect(result.rangesByPieceId.p1).toEqual([
      { start: 0, end: 2, matchIndex: 0 },
    ]);
  });

  it("locates matches after astral-plane characters", () => {
    // U+10348 (Gothic letter hwair, "𐍈") is a non-BMP letter
    // encoded as a UTF-16 surrogate pair. `String.indexOf`
    // reports code-unit offsets, so the normalizer and the
    // offset maps must stay aligned with those units even when
    // a single code point consumes two units in the source.
    const result = buildSearchResults({
      pieces: [{ id: "p1", text: "𐍈abc" }],
      query: "abc",
    });

    expect(result.matchCount).toBe(1);
    expect(result.rangesByPieceId.p1).toEqual([
      { start: 2, end: 5, matchIndex: 0 },
    ]);
  });
});
