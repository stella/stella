import { describe, expect, test } from "bun:test";

import { createEmptyDocument } from "@stll/folio-core";
import {
  findSearchMatchRanges,
  foldSearchMatchText,
} from "@stll/text-normalize";

import {
  findDocumentSearchResult,
  findDocumentSearchMatches,
  findSearchTextMatches,
} from "@/lib/document-search";
import { getSearchTextCandidates } from "@/lib/search-text";

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
    expect(findSearchMatchRanges("Š", "s")).toEqual([{ start: 0, end: 1 }]);
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

  test("keeps independently marked server terms independent", () => {
    const searchText = {
      type: "separate-terms" as const,
      terms: ["alpha", "beta"],
    };

    expect(findSearchTextMatches("alpha beta alpha", searchText)).toEqual([
      { start: 0, end: 5 },
      { start: 6, end: 10 },
      { start: 11, end: 16 },
    ]);
    const document = createEmptyDocument({ initialText: "alpha beta alpha" });
    expect(findDocumentSearchMatches(document, searchText)).toMatchObject([
      { startOffset: 0, endOffset: 5 },
      { startOffset: 6, endOffset: 10 },
      { startOffset: 11, endOffset: 16 },
    ]);
  });

  test("prefers the longest marked term when candidates overlap", () => {
    expect(
      findSearchTextMatches("foobar", {
        type: "separate-terms",
        terms: ["foo", "foobar"],
      }),
    ).toEqual([{ start: 0, end: 6 }]);

    const document = createEmptyDocument({ initialText: "bar foobar" });
    expect(
      findDocumentSearchMatches(document, {
        type: "separate-terms",
        terms: ["bar", "foobar"],
      }),
    ).toMatchObject([
      { startOffset: 0, endOffset: 3 },
      { startOffset: 4, endOffset: 10 },
    ]);
  });

  test("maps a diacritic-insensitive match back to original offsets", () => {
    expect(findSearchMatchRanges("zápis odštepení", "odštěpení")).toEqual([
      { start: 6, end: 15 },
    ]);
    expect(foldSearchMatchText("ODŠTĚPENÍ")).toBe("odstepeni");
  });

  test("case-folds final sigma while mapping source offsets", () => {
    expect(foldSearchMatchText("ΟΣ")).toBe("οσ");
    expect(findSearchMatchRanges("ΟΣ", "ος")).toEqual([{ start: 0, end: 2 }]);
    expect(findSearchMatchRanges("ΟΣ", "σ")).toEqual([{ start: 1, end: 2 }]);
  });

  test("uses canonical Arabic folds while preserving source offsets", () => {
    expect(findSearchMatchRanges("مدرسة", "مدرسه")).toEqual([
      { start: 0, end: 5 },
    ]);
    expect(findSearchMatchRanges("مـحـمـد", "محمد")).toEqual([
      { start: 0, end: 7 },
    ]);
    expect(findSearchMatchRanges("٢٠٢٤", "2024")).toEqual([
      { start: 0, end: 4 },
    ]);
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

  test("unions exact and normalized matches without duplicating exact spans", () => {
    expect(
      findSearchTextMatches("odštěpení odstepeni ODŠTĚPENÍ", "odštěpení"),
    ).toEqual([
      { start: 0, end: 9 },
      { start: 10, end: 19 },
      { start: 20, end: 29 },
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

  test("keeps DOCX matches ordered when normalized and exact hits coexist", () => {
    const document = createEmptyDocument({
      initialText: "odštěpení odstepeni ODŠTĚPENÍ",
    });

    expect(findDocumentSearchMatches(document, "odštěpení")).toMatchObject([
      { startOffset: 0, endOffset: 9 },
      { startOffset: 10, endOffset: 19 },
      { startOffset: 20, endOffset: 29 },
    ]);
    expect(
      findDocumentSearchResult({
        document,
        maxMatches: 2,
        searchText: "odštěpení",
      }),
    ).toMatchObject({
      matches: [
        { startOffset: 0, endOffset: 9 },
        { startOffset: 10, endOffset: 19 },
      ],
      truncated: true,
    });
  });

  test("applies the DOCX cap after globally ordering fallback-term matches", () => {
    const document = createEmptyDocument({ initialText: "beta alpha alpha" });

    expect(
      findDocumentSearchResult({
        document,
        maxMatches: 1,
        searchText: "alpha beta",
      }),
    ).toMatchObject({
      matches: [{ startOffset: 0, endOffset: 4 }],
      truncated: true,
    });
  });
});
