import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import type { ResolvedFile } from "@/api/lib/workflow/generate-batch-shared";
import {
  DOCX_MIME_TYPE,
  PDF_MIME_TYPE,
  PPTX_MIME_TYPE,
  XLSX_MIME_TYPE,
} from "@/api/mime-types";

import {
  canPrepareNativeImageFile,
  isAISupportedFile,
} from "./ai-file-support";

const resolvedFile = (mimeType: string): ResolvedFile => ({
  encrypted: false,
  fileFieldId: toSafeId<"field">("019864b8-48d0-7f37-94d5-948e3bcf3f44"),
  fileId: "019864b8-48d0-7f37-94d5-948e3bcf3f45",
  mimeType,
  pdfFileId: null,
  sha256Hex: "a".repeat(64),
});

describe("AI file support", () => {
  test("accepts native Office files through extracted text", () => {
    for (const mimeType of [PPTX_MIME_TYPE, XLSX_MIME_TYPE]) {
      expect(isAISupportedFile(resolvedFile(mimeType))).toBe(true);
    }
  });

  test("preserves existing PDF, derivative, and DOCX paths", () => {
    expect(isAISupportedFile(resolvedFile(PDF_MIME_TYPE))).toBe(true);
    expect(isAISupportedFile(resolvedFile(DOCX_MIME_TYPE))).toBe(true);
    expect(
      isAISupportedFile({
        ...resolvedFile("application/msword"),
        pdfFileId: "019864b8-48d0-7f37-94d5-948e3bcf3f46",
      }),
    ).toBe(true);
  });

  test("rejects native Office files that cannot be extracted", () => {
    expect(
      isAISupportedFile({ ...resolvedFile(XLSX_MIME_TYPE), encrypted: true }),
    ).toBe(false);
    expect(isAISupportedFile(resolvedFile("application/zip"))).toBe(false);
  });

  test("native image preparation accepts only unencrypted HEIC/HEIF originals without a PDF derivative", () => {
    for (const mimeType of ["image/heic", "image/heif"]) {
      const file = resolvedFile(mimeType);
      expect(canPrepareNativeImageFile(file)).toBe(true);
      expect(canPrepareNativeImageFile({ ...file, encrypted: true })).toBe(
        false,
      );
      expect(
        canPrepareNativeImageFile({ ...file, pdfFileId: "existing-pdf" }),
      ).toBe(false);
      expect(isAISupportedFile(file)).toBe(false);
    }
    for (const mimeType of [
      "image/heic-sequence",
      "image/heif-sequence",
      "image/jpeg",
      PDF_MIME_TYPE,
    ]) {
      expect(canPrepareNativeImageFile(resolvedFile(mimeType))).toBe(false);
    }
  });
});
