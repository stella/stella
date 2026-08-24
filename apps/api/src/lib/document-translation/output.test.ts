import { describe, expect, test } from "bun:test";

import { DOC_MIME_TYPE, DOCX_MIME_TYPE, PDF_MIME_TYPE } from "@/api/mime-types";

import { buildBilingualFileName, resolveTranslatedOutput } from "./output";

describe("document translation output metadata", () => {
  test("normalizes legacy DOC translations to DOCX", () => {
    expect(
      resolveTranslatedOutput({
        sourceFileName: "Agreement.doc",
        sourceMimeType: DOC_MIME_TYPE,
        targetLang: "DE",
      }),
    ).toEqual({
      fileName: "Agreement (DE).docx",
      mimeType: DOCX_MIME_TYPE,
    });
  });

  test("adds a DOCX extension when legacy DOC metadata has no extension", () => {
    expect(
      resolveTranslatedOutput({
        sourceFileName: "Agreement",
        sourceMimeType: DOC_MIME_TYPE,
        targetLang: "DE",
      }).fileName,
    ).toBe("Agreement (DE).docx");
  });

  test("preserves non-DOC MIME type and extension", () => {
    expect(
      resolveTranslatedOutput({
        sourceFileName: "Bundle.pdf",
        sourceMimeType: PDF_MIME_TYPE,
        targetLang: "FR",
      }),
    ).toEqual({
      fileName: "Bundle (FR).pdf",
      mimeType: PDF_MIME_TYPE,
    });
  });

  test("names bilingual DOCX output with both language tags", () => {
    expect(
      buildBilingualFileName({
        sourceFileName: "Agreement.docx",
        sourceLang: "cs",
        targetLang: "en",
      }),
    ).toBe("Agreement (CS-EN).docx");
  });
});
