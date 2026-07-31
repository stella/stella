import { describe, expect, test } from "bun:test";

import { createEmptyDocument } from "@stll/folio-core";

import {
  findDocumentSearchResult,
  findDocumentSearchMatches,
  findNormalizedSearchTextMatches,
  findSearchTextMatches,
  getSearchTextCandidates,
  normalizeSearchText,
} from "@/lib/document-search";

describe("document search highlighting", () => {
  test("uses the native document find behavior across text runs", () => {
    expect(
      findSearchTextMatches("Meridian supply agreement", "SUPPLY"),
    ).toEqual([{ start: 9, end: 15 }]);
  });

  test("does not create matches for an empty query", () => {
    expect(findSearchTextMatches("Meridian", "  ")).toEqual([]);
  });

  test("retains one-character Unicode terms", () => {
    expect(getSearchTextCandidates("法")).toEqual(["法"]);
    expect(findSearchTextMatches("準拠法", "法")).toEqual([
      { start: 2, end: 3 },
    ]);
    expect(findNormalizedSearchTextMatches("Š", "s")).toEqual([
      { start: 0, end: 1 },
    ]);
  });

  test("falls back to web-search terms when an exact query is absent", () => {
    expect(
      findSearchTextMatches("Due Diligence Report", "Due_Diligence_Report"),
    ).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 13 },
      { start: 14, end: 20 },
    ]);
  });

  test("maps a diacritic-insensitive match back to original offsets", () => {
    expect(
      findNormalizedSearchTextMatches("zápis odštepení", "odštěpení"),
    ).toEqual([{ start: 6, end: 15 }]);
    expect(normalizeSearchText("ODŠTĚPENÍ")).toBe("odstepeni");
  });

  test("finds every fallback term and maps unaccented DOCX queries", () => {
    const document = createEmptyDocument({
      initialText: "Plán odštěpení a následné assignment povinností",
    });

    expect(
      findDocumentSearchMatches(document, "odstepeni assignment").map(
        ({ startOffset, endOffset, text }) => ({
          startOffset,
          endOffset,
          text,
        }),
      ),
    ).toEqual([
      { startOffset: 5, endOffset: 14, text: "odštěpení" },
      { startOffset: 26, endOffset: 36, text: "assignment" },
    ]);
  });

  test("bounds DOCX matches at one past the display cap", () => {
    const exactlyAtCap = createEmptyDocument({
      initialText: "hit ".repeat(200),
    });
    const overCap = createEmptyDocument({
      initialText: "hit ".repeat(201),
    });

    expect(
      findDocumentSearchResult({
        document: exactlyAtCap,
        maxMatches: 200,
        searchText: "hit",
      }),
    ).toMatchObject({ matches: { length: 200 }, truncated: false });
    expect(
      findDocumentSearchResult({
        document: overCap,
        maxMatches: 200,
        searchText: "hit",
      }),
    ).toMatchObject({ matches: { length: 200 }, truncated: true });
  });
});
