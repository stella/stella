import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import type { Block, DocumentAst } from "@stll/legal-ast/document-ast";
import {
  createReaderTextQuoteLocator,
  type ReaderTextPiece,
  type ReaderTextQuoteSelector,
} from "@stll/legal-ast/reader-text-quote";

import { decisionAnnotationTextPieces } from "@/api/handlers/legal-reader/annotations/decision-text-pieces";

const paragraph = (anchorId: string, text: string): Block => ({
  anchorId,
  id: `id-${anchorId}`,
  inlines: [{ text, type: "text" }],
  plainText: text,
  type: "paragraph",
});

const astOf = (blocks: Block[]): DocumentAst => ({
  version: 1,
  source: { system: "test", documentId: "d-1", webUrl: "", printUrl: "" },
  metadata: {
    caseNumber: "1 C 1/2026",
    ecli: null,
    court: null,
    decisionDate: null,
    decisionType: null,
    keywords: [],
    statutes: [],
  },
  blocks,
});

const SUMMARY = "The tenant may withhold rent only after written notice.";
const BODY = "The court dismissed the appeal in its entirety.";

/** A mark as the reader stores it: a position and the words around it. */
const markOn = (
  piece: ReaderTextPiece,
  quote: string,
): ReaderTextQuoteSelector => {
  const startOffset = piece.text.indexOf(quote);
  expect(startOffset).toBeGreaterThanOrEqual(0);
  const endOffset = startOffset + quote.length;
  return {
    blockAnchorId: piece.anchorId,
    startOffset,
    endOffset,
    quote,
    quotePrefix: piece.text.slice(Math.max(0, startOffset - 32), startOffset),
    quoteSuffix: piece.text.slice(endOffset, endOffset + 32),
  };
};

const pieceWith = (
  pieces: readonly ReaderTextPiece[],
  text: string,
): ReaderTextPiece =>
  pieces.find((piece) => piece.text.includes(text)) ??
  panic(`no piece holds ${JSON.stringify(text)}`);

describe("decisionAnnotationTextPieces", () => {
  // The decision's blocks carry no marked-up headnote, so the reader draws
  // the publisher's summary field above the body, and a mark made there is
  // stored against that supplement's anchor.
  const pieces = decisionAnnotationTextPieces({
    ast: astOf([paragraph("p-1", BODY)]),
    caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
    fulltext: null,
    metadata: { summary: SUMMARY },
  });
  const locate = createReaderTextQuoteLocator(pieces);

  test("places a mark made on the publisher's summary", () => {
    const summary = pieceWith(pieces, SUMMARY);
    expect(summary.anchorId).toBe("supplement-summary:0");
    expect(locate(markOn(summary, "withhold rent"))).toEqual({
      status: "placed",
      blockAnchorId: "supplement-summary:0",
      startOffset: SUMMARY.indexOf("withhold rent"),
      endOffset: SUMMARY.indexOf("withhold rent") + "withhold rent".length,
    });
  });

  test("still places a mark on the body", () => {
    expect(locate(markOn(pieceWith(pieces, BODY), "dismissed"))).toMatchObject({
      status: "placed",
      blockAnchorId: "p-1",
    });
  });

  test("reports a quote the reader shows nowhere as not found", () => {
    expect(
      locate({
        blockAnchorId: "supplement-summary:0",
        startOffset: 0,
        endOffset: 12,
        quote: "never stated",
        quotePrefix: "",
        quoteSuffix: "",
      }),
    ).toEqual({ status: "orphaned", reason: "quote_not_found" });
  });

  test("places a mark on the plain text of a decision without an AST", () => {
    const plain = decisionAnnotationTextPieces({
      ast: null,
      caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
      fulltext: BODY,
      metadata: {},
    });
    expect(
      createReaderTextQuoteLocator(plain)(
        markOn(pieceWith(plain, BODY), "the appeal"),
      ),
    ).toMatchObject({ status: "placed" });
  });
});
