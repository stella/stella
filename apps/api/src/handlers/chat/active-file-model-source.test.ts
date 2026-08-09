import { describe, expect, test } from "bun:test";

import type { FieldContent } from "@/api/db/schema-validators";
import {
  PDF_MIME_TYPE,
  PPTX_MIME_TYPE,
  XLSX_MIME_TYPE,
} from "@/api/mime-types";

import {
  getActiveFileModelBinding,
  getActiveFileSourceForModel,
} from "./active-file-model-source";

type FileFieldContent = Extract<FieldContent, { type: "file" }>;

const fileContent = (mimeType: string): FileFieldContent => ({
  encrypted: false,
  fileName: "office-file",
  id: "019864b8-48d0-7f37-94d5-948e3bcf3f44",
  mimeType,
  pdfFileId: null,
  sha256Hex: "a".repeat(64),
  sizeBytes: 123,
  type: "file",
  version: 1,
});

describe("active-file model source", () => {
  test("uses extracted text for native Office files without derivatives", () => {
    for (const mimeType of [PPTX_MIME_TYPE, XLSX_MIME_TYPE]) {
      expect(getActiveFileSourceForModel(fileContent(mimeType))).toEqual({
        type: "extracted-text",
        fileId: "019864b8-48d0-7f37-94d5-948e3bcf3f44",
        fileName: "office-file",
        knownSizeBytes: 123,
        mimeType,
      });
    }
  });

  test("preserves PDF and derivative fallbacks", () => {
    expect(getActiveFileSourceForModel(fileContent(PDF_MIME_TYPE))).toEqual({
      type: "pdf",
      fileId: "019864b8-48d0-7f37-94d5-948e3bcf3f44",
      fileName: "office-file",
      knownSizeBytes: 123,
      mimeType: PDF_MIME_TYPE,
    });

    expect(
      getActiveFileSourceForModel({
        ...fileContent("application/msword"),
        pdfFileId: "019864b8-48d0-7f37-94d5-948e3bcf3f45",
      }),
    ).toEqual({
      type: "pdf",
      fileId: "019864b8-48d0-7f37-94d5-948e3bcf3f45",
      fileName: "office-file",
      knownSizeBytes: null,
      mimeType: PDF_MIME_TYPE,
    });
  });

  test("never attaches encrypted sources", () => {
    expect(
      getActiveFileSourceForModel({
        ...fileContent(XLSX_MIME_TYPE),
        encrypted: true,
      }),
    ).toBeNull();
  });

  test("uses durable extraction only for the exact current version", () => {
    const content = fileContent(XLSX_MIME_TYPE);
    const extractedContent = {
      charCount: 10,
      sourceEntityVersionId: "version-current",
      sourceFieldId: "field-current",
      sourceFileId: content.id,
      sourceSha256Hex: content.sha256Hex,
    };

    expect(
      getActiveFileModelBinding({
        content,
        currentVersionId: "version-current",
        extractedContent,
        fieldId: "field-current",
        fieldVersionId: "version-current",
      }),
    ).toEqual({ type: "durable-current" });

    expect(
      getActiveFileModelBinding({
        content,
        currentVersionId: "version-current",
        extractedContent,
        fieldId: "field-current",
        fieldVersionId: "version-historical",
      }),
    ).toEqual({
      type: "direct",
      source: {
        type: "extracted-text",
        fileId: "019864b8-48d0-7f37-94d5-948e3bcf3f44",
        fileName: "office-file",
        knownSizeBytes: 123,
        mimeType: XLSX_MIME_TYPE,
      },
      version: "historical",
    });

    for (const mismatchedExtraction of [
      { ...extractedContent, sourceEntityVersionId: "version-previous" },
      { ...extractedContent, sourceFieldId: "field-other" },
      { ...extractedContent, sourceFileId: "file-other" },
      { ...extractedContent, sourceSha256Hex: "b".repeat(64) },
    ]) {
      expect(
        getActiveFileModelBinding({
          content,
          currentVersionId: "version-current",
          extractedContent: mismatchedExtraction,
          fieldId: "field-current",
          fieldVersionId: "version-current",
        }),
      ).toEqual({
        type: "direct",
        source: {
          type: "extracted-text",
          fileId: "019864b8-48d0-7f37-94d5-948e3bcf3f44",
          fileName: "office-file",
          knownSizeBytes: 123,
          mimeType: XLSX_MIME_TYPE,
        },
        version: "current",
      });
    }
  });
});
