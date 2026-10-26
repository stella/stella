import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  READER_PDF_PAGE_NUMBER_MAX,
  readerPdfPageAnchorId,
  readerPdfPageNumber,
} from "./legal-reader-annotations";

test("a PDF page anchor names back the page it was made for", () => {
  assertProperty(
    "a PDF page anchor names back the page it was made for",
    fc.property(
      fc.integer({ min: 1, max: READER_PDF_PAGE_NUMBER_MAX }),
      (pageNumber) => {
        expect(readerPdfPageNumber(readerPdfPageAnchorId(pageNumber))).toBe(
          pageNumber,
        );
      },
    ),
  );
});

test("an anchor that is not a page's names no page", () => {
  assertProperty(
    "an anchor that is not a page's names no page",
    fc.property(fc.string({ maxLength: 12 }), (anchorId) => {
      fc.pre(!/^page-[1-9][0-9]{0,5}$/u.test(anchorId));
      expect(readerPdfPageNumber(anchorId)).toBeNull();
    }),
  );
  for (const anchorId of [
    "page-0",
    "page-01",
    `page-${String(READER_PDF_PAGE_NUMBER_MAX + 1)}`,
    "P3",
    "p1",
  ]) {
    expect(readerPdfPageNumber(anchorId)).toBeNull();
  }
});
