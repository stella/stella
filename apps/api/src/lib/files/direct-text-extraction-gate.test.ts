import { describe, expect, test } from "bun:test";

import type { FieldContent } from "@/api/db/schema-validators";
import { EXTRACTABLE_MIME_TYPES } from "@/api/lib/search/extractable-mime-types";
import {
  pickExtractionSource,
  requiresDurableNativeExtraction,
} from "@/api/lib/search/process-extraction";

const fileField = (mimeType: string, encrypted = false) =>
  ({
    encrypted,
    fileName: "upload",
    id: "original_file",
    mimeType,
    pdfFileId: null,
    sha256Hex: "a".repeat(64),
    sizeBytes: 128,
    type: "file",
    version: 1,
  }) satisfies FieldContent;

describe("direct file extraction gate", () => {
  test("every registered parser extracts the original before a preview exists", () => {
    for (const mimeType of EXTRACTABLE_MIME_TYPES) {
      const file = fileField(mimeType);

      expect(requiresDurableNativeExtraction(file)).toBe(true);
      expect(pickExtractionSource(file)).toEqual({
        extractionMimeType: mimeType,
        fileId: "original_file",
        storageMimeType: mimeType,
      });
    }
  });

  test("an image waits for its preview text layer", () => {
    expect(requiresDurableNativeExtraction(fileField("image/png"))).toBe(false);
  });

  test("an encrypted file never enters extraction", () => {
    for (const mimeType of EXTRACTABLE_MIME_TYPES) {
      expect(requiresDurableNativeExtraction(fileField(mimeType, true))).toBe(
        false,
      );
    }
  });
});
