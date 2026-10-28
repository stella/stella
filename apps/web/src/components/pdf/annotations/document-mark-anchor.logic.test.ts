import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { READER_ANNOTATION_QUOTE_MAX_LENGTH } from "@stll/api-contract/legal-reader-annotations";
import {
  DETACHED_REASON,
  findWordsOnPage,
  placeMark,
} from "@stll/api-contract/pdf-mark-placement";
import type {
  MarkAnchor,
  MarkPageText,
} from "@stll/api-contract/pdf-mark-placement";
import { assertProperty } from "@stll/property-testing";

import {
  locateSelection,
  SELECTION_REFUSAL,
} from "@/components/pdf/annotations/document-mark-anchor.logic";

const FIELD = "field-version-1";
const OTHER_FIELD = "field-version-2";

/** A page as LibPDF reads it: one box per unit, none for the line breaks. */
const pageOf = (text: string, sha256 = `sha:${text}`): MarkPageText => ({
  boxesByOffset: Array.from(text, (unit, index) =>
    unit === "\n" ? null : { x: index * 10, y: 700, width: 10, height: 12 },
  ),
  sha256,
  text,
});

const PAGE =
  "Article 4\nThe seller shall deliver the goods\nwithin thirty days.";
const QUOTE = "deliver the goods";
const START = PAGE.indexOf(QUOTE);

const anchorOn = (overrides: Partial<MarkAnchor> = {}): MarkAnchor => ({
  endOffset: START + QUOTE.length,
  fieldId: FIELD,
  pageNumber: 2,
  pageTextSha256: `sha:${PAGE}`,
  quote: QUOTE,
  startOffset: START,
  ...overrides,
});

describe("a mark on the page the viewer shows", () => {
  test("is drawn over its stored offsets while the page reads as it did", () => {
    const placement = placeMark({
      anchor: anchorOn(),
      page: pageOf(PAGE),
      pagesRead: true,
      viewedFieldId: FIELD,
    });
    expect(placement).toMatchObject({
      type: "placed",
      range: { start: START, end: START + QUOTE.length },
    });
    // One merged box from the first glyph to the last.
    expect(placement.type === "placed" && placement.boxes).toEqual([
      { x: START * 10, y: 700, width: QUOTE.length * 10, height: 12 },
    ]);
  });

  test("on another version is drawn when that page reads exactly the same", () => {
    expect(
      placeMark({
        anchor: anchorOn({ fieldId: OTHER_FIELD }),
        page: pageOf(PAGE),
        pagesRead: true,
        viewedFieldId: FIELD,
      }),
    ).toMatchObject({ type: "placed" });
  });

  test("on another version whose page reads differently is detached, even where its words recur", () => {
    const changed = `Preamble\n${PAGE}`;
    expect(
      placeMark({
        anchor: anchorOn({ fieldId: OTHER_FIELD }),
        page: pageOf(changed),
        pagesRead: true,
        viewedFieldId: FIELD,
      }),
    ).toEqual({ type: "detached", reason: DETACHED_REASON.otherVersion });
  });

  test("on this file read differently follows its words to where they now are", () => {
    const shifted = `Preamble\n${PAGE}`;
    expect(
      placeMark({
        anchor: anchorOn(),
        page: pageOf(shifted),
        pagesRead: true,
        viewedFieldId: FIELD,
      }),
    ).toMatchObject({
      type: "placed",
      range: { start: shifted.indexOf(QUOTE) },
    });
    expect(
      placeMark({
        anchor: anchorOn(),
        page: pageOf("Article 4\nThe buyer pays on delivery."),
        pagesRead: true,
        viewedFieldId: FIELD,
      }),
    ).toEqual({ type: "detached", reason: DETACHED_REASON.textChanged });
  });

  test("waits for the page text, then is detached when the file has no such page", () => {
    const missing = {
      anchor: anchorOn({ fieldId: OTHER_FIELD }),
      page: undefined,
      viewedFieldId: FIELD,
    };
    expect(placeMark({ ...missing, pagesRead: false })).toEqual({
      type: "reading",
    });
    expect(placeMark({ ...missing, pagesRead: true })).toEqual({
      type: "detached",
      reason: DETACHED_REASON.otherVersion,
    });
  });
});

describe("words found on a page", () => {
  test("match whatever whitespace either extractor put between them", () => {
    assertProperty(
      "match whatever whitespace either extractor put between them",
      fc.property(
        fc
          .array(fc.stringMatching(/^[a-zA-Zčřž0-9.,]{1,8}$/u))
          .filter((words) => words.length > 0),
        fc.array(fc.constantFrom(" ", "\n", "  ", " \n")),
        fc.nat(),
        fc.nat(),
        (words, gaps, from, length) => {
          const pageText = words
            .map((word, index) => `${word}${gaps.at(index) ?? " "}`)
            .join("");
          const first = from % words.length;
          const last = Math.min(words.length - 1, first + (length % 4));
          const selected = words.slice(first, last + 1).join(" ");
          const range = findWordsOnPage({ near: 0, pageText, words: selected });
          expect(range).not.toBeNull();
          if (range === null) {
            return;
          }
          const squeeze = (text: string) => text.replaceAll(/\s/gu, "");
          expect(squeeze(pageText.slice(range.start, range.end))).toBe(
            squeeze(selected),
          );
        },
      ),
    );
  });

  test("prefer the occurrence nearest where the selection began", () => {
    const pageText = "the goods\nthe goods\nthe goods";
    expect(findWordsOnPage({ near: 0, pageText, words: "the goods" })).toEqual({
      start: 0,
      end: 9,
    });
    expect(findWordsOnPage({ near: 19, pageText, words: "the goods" })).toEqual(
      { start: 20, end: 29 },
    );
  });
});

describe("a selection becoming an anchor", () => {
  test("names the page's own words at offsets the server can check", () => {
    // pdf.js joined the lines with a space where LibPDF broke the line.
    const located = locateSelection({
      layers: [
        {
          pageNumber: 2,
          text: "shall deliver the goods within",
          before: 18,
          total: 60,
        },
      ],
      pages: new Map([[2, pageOf(PAGE)]]),
    });
    expect(located).toEqual({
      type: "located",
      spans: [
        {
          pageNumber: 2,
          startOffset: PAGE.indexOf("shall"),
          endOffset: PAGE.indexOf("within") + "within".length,
          quote: "shall deliver the goods\nwithin",
        },
      ],
    });
  });

  test("is refused on a page without text, for words not on it, or past the quote limit", () => {
    expect(
      locateSelection({
        layers: [{ pageNumber: 1, text: "words", before: 0, total: 5 }],
        pages: new Map([[1, pageOf(" \n ")]]),
      }),
    ).toEqual({
      type: "refused",
      reason: SELECTION_REFUSAL.noText,
      pageNumber: 1,
    });
    expect(
      locateSelection({
        layers: [{ pageNumber: 2, text: "the buyer", before: 0, total: 9 }],
        pages: new Map([[2, pageOf(PAGE)]]),
      }),
    ).toEqual({
      type: "refused",
      reason: SELECTION_REFUSAL.notFound,
      pageNumber: 2,
    });
    const long = "word ".repeat(READER_ANNOTATION_QUOTE_MAX_LENGTH);
    expect(
      locateSelection({
        layers: [{ pageNumber: 3, text: long, before: 0, total: long.length }],
        pages: new Map([[3, pageOf(long)]]),
      }),
    ).toEqual({
      type: "refused",
      reason: SELECTION_REFUSAL.tooLong,
      pageNumber: 3,
    });
  });
});
