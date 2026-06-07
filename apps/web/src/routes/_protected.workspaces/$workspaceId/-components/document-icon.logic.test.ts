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
    expect(getDocumentIconKind("application/octet-stream", "notes.md")).toBe(
      "text",
    );
  });
});
