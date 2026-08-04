import { describe, expect, test } from "bun:test";

import type { FieldContent } from "@/api/db/schema-validators";
import {
  DOCX_MIME_TYPE,
  PDF_MIME_TYPE,
  PPTX_MIME_TYPE,
  XLSX_MIME_TYPE,
} from "@/api/mime-types";

import { pickExtractionSource } from "./process-extraction";

const fileField = (overrides: {
  fileName?: string;
  mimeType?: string;
  pdfFileId?: string | null;
}) =>
  ({
    encrypted: false,
    fileName: "file.bin",
    id: "file_original",
    mimeType: PDF_MIME_TYPE,
    pdfFileId: null,
    sha256Hex: "a".repeat(64),
    sizeBytes: 128,
    type: "file",
    version: 1,
    ...overrides,
  }) satisfies FieldContent;

describe("pickExtractionSource", () => {
  /**
   * The Gotenberg derivative exists for the preview UI and is a
   * paginated rendering: spreadsheets are scaled to fit a page and
   * columns past the fit are absent from the PDF entirely. Reading
   * the original is the entire point of parsing these formats
   * natively, so the derivative must not win once a parser exists.
   */
  test("reads the original for formats with a direct parser", () => {
    for (const mimeType of [XLSX_MIME_TYPE, PPTX_MIME_TYPE, DOCX_MIME_TYPE]) {
      expect(
        pickExtractionSource(
          fileField({ mimeType, pdfFileId: "file_derivative" }),
        ),
      ).toEqual({
        fileId: "file_original",
        storageMimeType: mimeType,
        extractionMimeType: mimeType,
      });
    }
  });

  test("falls back to the derivative for formats with no parser", () => {
    expect(
      pickExtractionSource(
        fileField({
          fileName: "scan.png",
          mimeType: "image/png",
          pdfFileId: "file_derivative",
        }),
      ),
    ).toEqual({
      fileId: "file_derivative",
      storageMimeType: PDF_MIME_TYPE,
      extractionMimeType: PDF_MIME_TYPE,
    });
  });

  test("reads the original when no derivative was generated", () => {
    expect(
      pickExtractionSource(
        fileField({ fileName: "contract.pdf", mimeType: PDF_MIME_TYPE }),
      ),
    ).toEqual({
      fileId: "file_original",
      storageMimeType: PDF_MIME_TYPE,
      extractionMimeType: PDF_MIME_TYPE,
    });
  });

  /**
   * Browsers routinely upload office documents as
   * `application/octet-stream`; recovering the type by extension is
   * what keeps those files off the derivative.
   */
  test("recovers the parser from the file name when the stored type is generic", () => {
    expect(
      pickExtractionSource(
        fileField({
          fileName: "schedule.xlsx",
          mimeType: "application/octet-stream",
          pdfFileId: "file_derivative",
        }),
      ),
    ).toEqual({
      fileId: "file_original",
      storageMimeType: "application/octet-stream",
      extractionMimeType: XLSX_MIME_TYPE,
    });
  });
});
