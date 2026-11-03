import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { MATTER_DOCUMENT_ANNOTATION_REFUSALS } from "@stll/api-contract/legal-reader-annotations";
import {
  placeReaderMarks,
  readerTextQuoteContext,
} from "@stll/legal-ast/reader-text-quote";
import { assertProperty } from "@stll/property-testing";

import { pdfPageTextSha256 } from "@/api/lib/files/pdf-page-text";
import { placeDocumentSpans } from "@/api/lib/legal-search/reader-annotations/matter-document.logic";

const PAGE_TWO =
  "Article 4\nThe seller shall deliver the goods\nwithin thirty days.";

describe("a span on a matter document's page", () => {
  test("keeps the page's own words, its anchor and the page text's digest", () => {
    const start = PAGE_TWO.indexOf("deliver");
    const placed = placeDocumentSpans({
      pages: new Map([[2, PAGE_TWO]]),
      spans: [
        {
          pageNumber: 2,
          startOffset: start,
          endOffset: start + "deliver the goods".length,
          quote: "deliver the goods",
        },
      ],
    });
    expect(Result.isOk(placed)).toBe(true);
    if (Result.isError(placed)) {
      return;
    }
    expect(placed.value.spans).toEqual([
      {
        blockAnchorId: "page-2",
        startOffset: start,
        endOffset: start + 17,
        quote: "deliver the goods",
        ...readerTextQuoteContext(PAGE_TWO, {
          startOffset: start,
          endOffset: start + 17,
        }),
      },
    ]);
    expect(placed.value.pageTextSha256ByAnchorId.get("page-2")).toBe(
      pdfPageTextSha256(PAGE_TWO),
    );
  });

  test("a placed PDF mark follows its quoted passage after a reparse while retaining its original page digest", () => {
    const quote = "deliver the goods";
    const startOffset = PAGE_TWO.indexOf(quote);
    const placed = placeDocumentSpans({
      pages: new Map([[2, PAGE_TWO]]),
      spans: [
        {
          pageNumber: 2,
          startOffset,
          endOffset: startOffset + quote.length,
          quote,
        },
      ],
    }).unwrap();
    const span = placed.spans.at(0);
    expect(span).toBeDefined();
    if (span === undefined) {
      return;
    }
    const current = `Summary: deliver the goods promptly.\n${PAGE_TWO.replaceAll("\n", " ")}`;
    const relocated = placeReaderMarks(
      [span],
      [{ anchorId: "page-3", text: current }],
    );
    expect(relocated.orphaned).toEqual([]);
    expect(relocated.placed).toHaveLength(1);
    expect(relocated.placed.at(0)).toMatchObject({
      blockAnchorId: "page-3",
      startOffset: current.lastIndexOf(quote),
      endOffset: current.lastIndexOf(quote) + quote.length,
      quote,
    });
    expect(placed.pageTextSha256ByAnchorId.get("page-2")).toBe(
      pdfPageTextSha256(PAGE_TWO),
    );
    expect(placed.pageTextSha256ByAnchorId.get("page-2")).not.toBe(
      pdfPageTextSha256(current),
    );
  });

  test("is placed exactly when the quote is the page's words at its offsets", () => {
    assertProperty(
      "is placed exactly when the quote is the page's words at its offsets",
      fc.property(
        fc.string({ minLength: 1, maxLength: 80 }),
        fc.nat(),
        fc.nat(),
        fc.string({ minLength: 1, maxLength: 12 }),
        (text, a, b, otherQuote) => {
          fc.pre(text.trim().length > 0);
          const startOffset = a % text.length;
          const endOffset = startOffset + 1 + (b % (text.length - startOffset));
          const pageWords = text.slice(startOffset, endOffset);
          for (const quote of [pageWords, otherQuote]) {
            const placed = placeDocumentSpans({
              pages: new Map([[1, text]]),
              spans: [{ pageNumber: 1, startOffset, endOffset, quote }],
            });
            if (quote === pageWords) {
              expect(Result.isOk(placed)).toBe(true);
            } else {
              expect(placed).toEqual(
                Result.err({
                  code: MATTER_DOCUMENT_ANNOTATION_REFUSALS.quoteMismatch,
                  pageNumber: 1,
                }),
              );
            }
          }
        },
      ),
    );
  });

  test("past the end of the page's text is refused rather than clipped", () => {
    expect(
      placeDocumentSpans({
        pages: new Map([[1, "short"]]),
        spans: [
          { pageNumber: 1, startOffset: 0, endOffset: 9, quote: "short" },
        ],
      }),
    ).toEqual(
      Result.err({
        code: MATTER_DOCUMENT_ANNOTATION_REFUSALS.quoteMismatch,
        pageNumber: 1,
      }),
    );
  });

  test("on a page the document does not have is refused", () => {
    expect(
      placeDocumentSpans({
        pages: new Map([[1, PAGE_TWO]]),
        spans: [{ pageNumber: 7, startOffset: 0, endOffset: 4, quote: "Arti" }],
      }),
    ).toEqual(
      Result.err({
        code: MATTER_DOCUMENT_ANNOTATION_REFUSALS.pageMissing,
        pageNumber: 7,
      }),
    );
  });

  test("on a page without extracted text is refused with the OCR refusal", () => {
    expect(
      placeDocumentSpans({
        pages: new Map([[3, " \n "]]),
        spans: [{ pageNumber: 3, startOffset: 0, endOffset: 1, quote: " " }],
      }),
    ).toEqual(
      Result.err({
        code: MATTER_DOCUMENT_ANNOTATION_REFUSALS.pageWithoutText,
        pageNumber: 3,
      }),
    );
  });
});

describe("a page text digest", () => {
  test("is the standard SHA-256 of the text's UTF-8, as the viewer computes it", () => {
    expect(pdfPageTextSha256("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    // Non-ASCII text hashes its UTF-8 bytes, not UTF-16 units.
    expect(pdfPageTextSha256("é")).toBe(
      "4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c",
    );
  });
});
