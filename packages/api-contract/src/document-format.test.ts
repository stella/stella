import { describe, expect, test } from "bun:test";

import { DESKTOP_EDIT_FILE_TYPE_CONFIG } from "./desktop-edit-file-types";
import { documentFormat } from "./document-format";
import type { DocumentFormatKind } from "./document-format";
import { EML_MIME_TYPE, MSG_MIME_TYPE } from "./email-mime-types";

const kindOf = (mimeType: string | null, fileName?: string) =>
  documentFormat(mimeType, fileName).kind;

describe("documentFormat", () => {
  test("uses the email mark for EML and Outlook MSG files", () => {
    expect(kindOf(EML_MIME_TYPE)).toBe("email");
    expect(kindOf(MSG_MIME_TYPE)).toBe("email");
    expect(kindOf("application/octet-stream", "thread.eml")).toBe("email");
    expect(kindOf("application/octet-stream", "thread.MSG")).toBe("email");
  });

  test("keeps document classes distinct", () => {
    expect(kindOf("application/pdf")).toBe("pdf");
    expect(kindOf(DESKTOP_EDIT_FILE_TYPE_CONFIG.docx.mimeType)).toBe("word");
    expect(kindOf(DESKTOP_EDIT_FILE_TYPE_CONFIG.pptx.mimeType)).toBe(
      "powerpoint",
    );
    expect(kindOf("application/vnd.ms-powerpoint")).toBe("powerpoint");
    expect(kindOf("text/plain")).toBe("text");
  });

  test("recovers formats from file names without a media type", () => {
    const files = [
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
      ["archive.zip", "file"],
    ] as const satisfies readonly (readonly [string, DocumentFormatKind])[];

    for (const [fileName, kind] of files) {
      expect(kindOf(null, fileName)).toBe(kind);
    }
  });

  test("names an unlisted image or text type by its family", () => {
    expect(documentFormat("image/heic", "IMG_0042.HEIC")).toEqual({
      kind: "image",
      label: "HEIC",
    });
    expect(kindOf("image/tiff")).toBe("image");
    expect(kindOf("text/html")).toBe("text");
    expect(kindOf("application/zip", "bundle")).toBe("file");
  });

  // text/csv also starts with text/, so it must win over the text fallback.
  test("separates CSV from workbooks and plain text", () => {
    expect(kindOf("text/csv")).toBe("csv");
    expect(kindOf(DESKTOP_EDIT_FILE_TYPE_CONFIG.xlsx.mimeType)).toBe("excel");
  });

  // Each mark names one format; no format borrows another's.
  test("gives RTF, ODT and ODS their own marks", () => {
    expect(kindOf("application/rtf")).toBe("rtf");
    expect(kindOf("application/vnd.oasis.opendocument.text")).toBe(
      "openDocumentText",
    );
    expect(kindOf("application/vnd.oasis.opendocument.spreadsheet")).toBe(
      "openDocumentSheet",
    );
    expect(kindOf("application/msword")).toBe("word");
    expect(kindOf("application/vnd.ms-excel")).toBe("excel");
  });

  test("classifies Markdown by media type or extension", () => {
    expect(kindOf("text/markdown")).toBe("markdown");
    expect(kindOf("text/markdown; charset=utf-8")).toBe("markdown");
    expect(kindOf("application/octet-stream", "notes.md")).toBe("markdown");
    // Plain text is the weakest hint: the name's extension wins over it.
    expect(kindOf("text/plain", "notes.md")).toBe("markdown");
    expect(kindOf("text/html")).toBe("text");
  });

  test("tags a format by its media type, else by its name's extension", () => {
    const labelOf = (mimeType: string | undefined, fileName?: string) =>
      documentFormat(mimeType, fileName).label;
    expect(labelOf("application/pdf; charset=binary")).toBe("PDF");
    expect(labelOf("Application/MSWord")).toBe("DOC");
    expect(labelOf(DESKTOP_EDIT_FILE_TYPE_CONFIG.docx.mimeType)).toBe("DOCX");
    expect(labelOf("application/octet-stream", "výpis.Xlsx")).toBe("XLSX");
    expect(labelOf("application/octet-stream", "data.json")).toBe("JSON");
    expect(labelOf(undefined, "bez přípony")).toBeUndefined();
    expect(labelOf("constructor", "a.pdf")).toBe("PDF");
    expect(labelOf("__proto__")).toBeUndefined();
  });
});
