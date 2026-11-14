import { expect, test } from "bun:test";

import { resolvePDFPageSource } from "@/lib/pdf/pdf-page-source";

test("document pages are kept even when a one-page PDF attaches PDFs", () => {
  expect(
    resolvePDFPageSource({
      pageSource: "document",
      documentPageCount: 1,
      attachmentCount: 2,
    }),
  ).toBe("document");
});

test("a portfolio opens its attachments only as a one-page container", () => {
  expect(
    resolvePDFPageSource({
      pageSource: "portfolio",
      documentPageCount: 1,
      attachmentCount: 1,
    }),
  ).toBe("portfolio");
  expect(
    resolvePDFPageSource({
      pageSource: "portfolio",
      documentPageCount: 2,
      attachmentCount: 1,
    }),
  ).toBe("document");
  expect(
    resolvePDFPageSource({
      pageSource: "portfolio",
      documentPageCount: 1,
      attachmentCount: 0,
    }),
  ).toBe("document");
});
