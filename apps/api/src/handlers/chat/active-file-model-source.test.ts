import { describe, expect, test } from "bun:test";

import type { FieldContent } from "@/api/db/schema-validators";
import {
  PDF_MIME_TYPE,
  PPTX_MIME_TYPE,
  XLSX_MIME_TYPE,
} from "@/api/mime-types";

import { getActiveFileSourceForModel } from "./active-file-model-source";

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
        mimeType,
      });
    }
  });

  test("preserves PDF and derivative fallbacks", () => {
    expect(getActiveFileSourceForModel(fileContent(PDF_MIME_TYPE))).toEqual({
      type: "pdf",
      fileId: "019864b8-48d0-7f37-94d5-948e3bcf3f44",
      fileName: "office-file",
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
});
