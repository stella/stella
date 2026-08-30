import { describe, expect, test } from "bun:test";

import { PDF_MIME_TYPE } from "@/consts";
import { DOCX_MIME, EML_MIME, MSG_MIME, PPTX_MIME } from "@/lib/consts";

import { getDocumentIconKind } from "./document-icon.logic";
import type { DocumentIconKind } from "./document-icon.logic";

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
    expect(getDocumentIconKind(PPTX_MIME)).toBe("powerpoint");
    expect(getDocumentIconKind("application/vnd.ms-powerpoint")).toBe(
      "powerpoint",
    );
    expect(getDocumentIconKind("text/plain")).toBe("text");
  });

  test("recovers supported document kinds from historical filenames without MIME metadata", () => {
    const historicalFiles = [
      ["agreement.docx", "word"],
      ["legacy.doc", "word"],
      ["evidence.pdf", "pdf"],
      ["schedule.xlsx", "excel"],
      ["legacy.xls", "excel"],
      ["hearing.pptx", "powerpoint"],
      ["legacy.ppt", "powerpoint"],
      ["notes.rtf", "rtf"],
      ["filing.odt", "openDocumentText"],
      ["ledger.ods", "openDocumentSheet"],
      ["export.csv", "csv"],
      ["scan.PNG", "image"],
      ["message.eml", "email"],
      ["readme.md", "markdown"],
      ["notes.txt", "text"],
    ] as const satisfies readonly (readonly [string, DocumentIconKind])[];

    for (const [fileName, expectedKind] of historicalFiles) {
      expect(getDocumentIconKind(null, fileName)).toBe(expectedKind);
    }
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

  // Each mark names one format. A format must never borrow another's mark,
  // so every member of the old catch-all "word"/"spreadsheet" groups is pinned.
  test("gives RTF, ODT, and ODS their own marks", () => {
    expect(getDocumentIconKind("application/rtf")).toBe("rtf");
    expect(getDocumentIconKind("application/vnd.oasis.opendocument.text")).toBe(
      "openDocumentText",
    );
    expect(
      getDocumentIconKind("application/vnd.oasis.opendocument.spreadsheet"),
    ).toBe("openDocumentSheet");
    expect(getDocumentIconKind("application/msword")).toBe("word");
    expect(getDocumentIconKind("application/vnd.ms-excel")).toBe("excel");
  });

  test("classifies markdown by MIME or extension", () => {
    expect(getDocumentIconKind("text/markdown")).toBe("markdown");
    expect(getDocumentIconKind("application/octet-stream", "notes.md")).toBe(
      "markdown",
    );
  });
});
