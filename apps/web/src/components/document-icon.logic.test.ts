import { describe, expect, test } from "bun:test";

import { PDF_MIME_TYPE } from "@/consts";
import { DOCX_MIME, EML_MIME, MSG_MIME } from "@/lib/consts";

import { getDocumentIconKind } from "./document-icon.logic";

describe("document icon MIME classification", () => {
  test("uses the email icon for EML and Outlook MSG files", () => {
    expect(getDocumentIconKind(EML_MIME)).toBe("email");
    expect(getDocumentIconKind(MSG_MIME)).toBe("email");
    expect(getDocumentIconKind("application/octet-stream", "thread.eml")).toBe(
      "email",
    );
    expect(getDocumentIconKind("application/octet-stream", "thread.MSG")).toBe(
      "email",
    );
  });

  test("keeps existing document classes distinct", () => {
    expect(getDocumentIconKind(PDF_MIME_TYPE)).toBe("pdf");
    expect(getDocumentIconKind(DOCX_MIME)).toBe("word");
    expect(getDocumentIconKind("text/plain")).toBe("text");
  });

  // text/csv also matches the generic text/ prefix, so it must be classified
  // before the text fallback to keep its own icon.
  test("separates CSV from spreadsheet workbooks and plain text", () => {
    expect(getDocumentIconKind("text/csv")).toBe("csv");
    expect(
      getDocumentIconKind(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ),
    ).toBe("excel");
  });

  // The Excel mark is brand-specific: a spreadsheet that is not an Excel
  // workbook must not carry it.
  test("keeps non-Excel spreadsheets off the Excel mark", () => {
    expect(
      getDocumentIconKind("application/vnd.oasis.opendocument.spreadsheet"),
    ).toBe("spreadsheet");
    expect(getDocumentIconKind("application/vnd.ms-excel")).toBe("excel");
  });

  test("classifies markdown by MIME or extension", () => {
    expect(getDocumentIconKind("text/markdown")).toBe("markdown");
    expect(getDocumentIconKind("application/octet-stream", "notes.md")).toBe(
      "markdown",
    );
  });
});
