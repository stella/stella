import { describe, expect, test } from "bun:test";

import { isPdfMimeType, shownDocumentOf } from "./shown-document";

const URL_SHOWN = "https://fixture-library.test/decisions/42";

describe("what a tab's top document is", () => {
  test("a PDF by the type Chrome loaded it with, whatever its address", () => {
    expect(
      shownDocumentOf({ contentType: "application/pdf", url: URL_SHOWN }),
    ).toEqual({ type: "pdf", url: URL_SHOWN });
    expect(
      shownDocumentOf({ contentType: "application/x-pdf", url: URL_SHOWN }),
    ).toEqual({ type: "pdf", url: URL_SHOWN });
  });

  test("a page named like a PDF is still a page", () => {
    expect(
      shownDocumentOf({
        contentType: "text/html",
        url: "https://fixture-library.test/decisions/42.pdf",
      }),
    ).toEqual({ type: "page" });
    expect(
      shownDocumentOf({ contentType: "application/xhtml+xml", url: URL_SHOWN }),
    ).toEqual({ type: "page" });
  });

  test("an answer outside the operation's shape says nothing", () => {
    expect(shownDocumentOf(undefined)).toBeNull();
    expect(shownDocumentOf({ contentType: "application/pdf" })).toBeNull();
    expect(
      shownDocumentOf({
        contentType: "application/pdf",
        extra: true,
        url: URL_SHOWN,
      }),
    ).toBeNull();
  });
});

describe("a PDF's MIME type", () => {
  test("is matched without parameters and case", () => {
    expect(isPdfMimeType("Application/PDF; charset=binary")).toBe(true);
    expect(isPdfMimeType(" application/pdf")).toBe(true);
    expect(isPdfMimeType("application/pdfx")).toBe(false);
    expect(isPdfMimeType("")).toBe(false);
  });
});
