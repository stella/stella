import { expect, test } from "bun:test";
import fc from "fast-check";

import {
  READER_PDF_PAGE_NUMBER_MAX,
  readerPdfPageAnchorId,
} from "@stll/api-contract/legal-reader-annotations";
import { assertProperty } from "@stll/property-testing";

import { pdfPageNumberOfAnchor } from "@/api/lib/legal-search/reader-annotations/pdf-page-anchor";

test("a PDF page anchor names back the page it was made for", () => {
  assertProperty(
    "a PDF page anchor names back the page it was made for",
    fc.property(
      fc.integer({ min: 1, max: READER_PDF_PAGE_NUMBER_MAX }),
      (pageNumber) => {
        expect(pdfPageNumberOfAnchor(readerPdfPageAnchorId(pageNumber))).toBe(
          pageNumber,
        );
      },
    ),
  );
});

test("an anchor that is not a page's names no page", () => {
  assertProperty(
    "an anchor that is not a page's names no page",
    fc.property(fc.string(), (anchorId) => {
      fc.pre(!/^page-[1-9][0-9]{0,5}$/u.test(anchorId));
      expect(pdfPageNumberOfAnchor(anchorId)).toBeNull();
    }),
  );
  for (const anchorId of [
    "page-0",
    "page-01",
    "page--3",
    `page-${String(READER_PDF_PAGE_NUMBER_MAX + 1)}`,
    "P3",
    "p-1",
  ]) {
    expect(pdfPageNumberOfAnchor(anchorId)).toBeNull();
  }
});
