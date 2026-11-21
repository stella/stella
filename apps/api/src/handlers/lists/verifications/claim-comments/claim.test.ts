import { describe, expect, test } from "bun:test";

import { READER_ANNOTATION_QUOTE_MAX_LENGTH } from "@stll/api-contract/legal-reader-annotations";

import { claimCommentSpan, claimQuote } from "./claim";

describe("a claim comment's span", () => {
  test("covers the claim's anchor on its DOCX block", () => {
    expect(
      claimCommentSpan({
        anchor: { type: "docx-block", blockId: "p7", start: 4, end: 31 },
        text: "The parties met on 4 March.",
      }),
    ).toEqual({
      blockAnchorId: "p7",
      startOffset: 4,
      endOffset: 31,
      quote: "The parties met on 4 March.",
      quotePrefix: "",
      quoteSuffix: "",
    });
  });

  test("names the page of a PDF claim", () => {
    expect(
      claimCommentSpan({
        anchor: { type: "pdf-page", pageNumber: 3, start: 0, end: 5 },
        text: "Paid.",
      }).blockAnchorId,
    ).toBe("page-3");
  });

  test("cuts a long claim to the quote limit without splitting a character", () => {
    const astral = "𝔄";
    const text = `${"a".repeat(READER_ANNOTATION_QUOTE_MAX_LENGTH - 1)}${astral}tail`;
    const quote = claimQuote(text);
    expect(quote).toBe("a".repeat(READER_ANNOTATION_QUOTE_MAX_LENGTH - 1));
    expect(claimQuote("short")).toBe("short");
  });
});
