import { describe, expect, test } from "bun:test";

import {
  readerSelectionMatches,
  visibleReaderAnchorPiecesOf,
} from "./case-law-reader.js";
import { DECISION_IDENTIFIER_TYPES } from "./decision-identifier.js";
import type { Block, DocumentAst } from "./document-ast.js";

const astOf = (blocks: Block[]): DocumentAst => ({
  version: 1,
  source: { system: "test", documentId: "1", webUrl: "", printUrl: "" },
  metadata: {
    caseNumber: "23 Cdo 1192/2019",
    ecli: null,
    court: "Nejvyšší soud",
    decisionDate: null,
    decisionType: null,
    keywords: [],
    statutes: [],
  },
  blocks,
});

const ast = astOf([
  {
    type: "paragraph",
    id: "docket",
    anchorId: "docket",
    role: "case-number",
    inlines: [{ type: "text", text: "23 Cdo 1192/2019" }],
    plainText: "23 Cdo 1192/2019",
  },
  {
    type: "heading",
    id: "h",
    anchorId: "h-1",
    level: 2,
    inlines: [{ type: "text", text: "Odůvodnění" }],
    plainText: "Odůvodnění",
  },
  {
    type: "paragraph",
    id: "p",
    anchorId: "p-1",
    inlines: [
      { type: "text", text: "Viz " },
      {
        type: "citation",
        cite: "23 Cdo 1192/2019",
        children: [{ type: "text", text: "23 Cdo 1192/2019" }],
      },
      { type: "line-break" },
      { type: "text", text: "dále" },
    ],
    plainText: "Viz 23 Cdo 1192/2019\ndále",
  },
  {
    type: "table",
    id: "t",
    anchorId: "t-1",
    rows: [
      [
        { inlines: [{ type: "text", text: "A" }], plainText: "A" },
        { inlines: [{ type: "text", text: "B" }], plainText: "B" },
      ],
    ],
    plainText: "A B",
  },
  {
    type: "table",
    id: "related",
    anchorId: "related-1",
    role: "related-proceedings",
    rows: [
      [
        {
          inlines: [{ type: "text", text: "21 Co 4/2018" }],
          plainText: "21 Co 4/2018",
        },
      ],
    ],
    plainText: "21 Co 4/2018",
  },
  {
    type: "image",
    id: "i",
    anchorId: "i-1",
    src: "https://example.test/i.png",
    plainText: "",
  },
]);

describe("visibleReaderAnchorPiecesOf", () => {
  test("lists what the reader shows: headings, paragraphs and each cell of a shown table", () => {
    expect(
      visibleReaderAnchorPiecesOf(ast, DECISION_IDENTIFIER_TYPES.CASE_NUMBER),
    ).toEqual([
      { anchorId: "h-1", text: "Odůvodnění" },
      { anchorId: "p-1", text: "Viz 23 Cdo 1192/2019\ndále" },
      { anchorId: "table:t:0:0", text: "A" },
      { anchorId: "table:t:0:1", text: "B" },
    ]);
  });

  test("keeps the case-number paragraph when the docket is not the reference line", () => {
    expect(
      visibleReaderAnchorPiecesOf(
        ast,
        DECISION_IDENTIFIER_TYPES.NEUTRAL_CITATION,
      ).at(0),
    ).toEqual({ anchorId: "docket", text: "23 Cdo 1192/2019" });
  });

  test("has no pieces without an AST", () => {
    expect(
      visibleReaderAnchorPiecesOf(null, DECISION_IDENTIFIER_TYPES.CASE_NUMBER),
    ).toEqual([]);
  });
});

describe("readerSelectionMatches", () => {
  const pieces = visibleReaderAnchorPiecesOf(
    ast,
    DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
  );
  const matches = (
    anchorId: string,
    [startOffset, endOffset]: [number, number],
    quote: string,
  ) =>
    readerSelectionMatches(pieces, [
      { anchorId, startOffset, endOffset, quote },
    ]);

  test("accepts exactly the text at a selection's offsets in its piece", () => {
    expect(matches("h-1", [0, 10], "Odůvodnění")).toBe(true);
    expect(matches("p-1", [4, 20], "23 Cdo 1192/2019")).toBe(true);
    expect(matches("table:t:0:1", [0, 1], "B")).toBe(true);
  });

  test("refuses a hidden, container or textless piece and any offset or quote drift", () => {
    expect(matches("table:related:0:0", [0, 12], "21 Co 4/2018")).toBe(false);
    expect(matches("docket", [0, 16], "23 Cdo 1192/2019")).toBe(false);
    expect(matches("t-1", [0, 1], "A")).toBe(false);
    expect(matches("i-1", [0, 0], "")).toBe(false);
    expect(matches("p-1", [4, 20], "23 Cdo 1192/2020")).toBe(false);
    expect(matches("p-1", [-1, 3], "Viz")).toBe(false);
    expect(matches("p-1", [3, 3], "")).toBe(false);
    expect(matches("h-1", [0, 99], "Odůvodnění")).toBe(false);
  });

  test("accepts spans over several pieces in reading order and refuses repeats, reversals and none", () => {
    const heading = {
      anchorId: "h-1",
      startOffset: 2,
      endOffset: 10,
      quote: "ůvodnění",
    };
    const cell = {
      anchorId: "table:t:0:1",
      startOffset: 0,
      endOffset: 1,
      quote: "B",
    };
    expect(readerSelectionMatches(pieces, [heading, cell])).toBe(true);
    expect(readerSelectionMatches(pieces, [cell, heading])).toBe(false);
    expect(readerSelectionMatches(pieces, [heading, heading])).toBe(false);
    expect(readerSelectionMatches(pieces, [])).toBe(false);
    expect(
      readerSelectionMatches(pieces, [
        heading,
        {
          anchorId: "docket",
          startOffset: 0,
          endOffset: 16,
          quote: "23 Cdo 1192/2019",
        },
      ]),
    ).toBe(false);
  });
});
