import { describe, expect, test } from "bun:test";

import { resolvePrimaryDownloadVariant } from "@/components/inspector/file-download-service.logic";
import { DOCX_MIME, PDF_MIME } from "@/lib/consts";

describe("primary download variant", () => {
  test("hands over the reference copy of a readable DOCX in a referenced matter", () => {
    expect(
      resolvePrimaryDownloadVariant({
        encrypted: false,
        hasReference: true,
        mimeType: DOCX_MIME,
      }),
    ).toBe("reference");
  });

  test("keeps the original when the version carries no reference", () => {
    expect(
      resolvePrimaryDownloadVariant({
        encrypted: false,
        hasReference: false,
        mimeType: DOCX_MIME,
      }),
    ).toBe("original");
  });

  test("keeps the original for formats that cannot carry a reference", () => {
    for (const mimeType of [PDF_MIME, "text/plain", undefined]) {
      expect(
        resolvePrimaryDownloadVariant({
          encrypted: false,
          hasReference: true,
          mimeType,
        }),
      ).toBe("original");
    }
  });

  test("keeps the original when the bytes are encrypted or unresolved", () => {
    for (const encrypted of [true, undefined]) {
      expect(
        resolvePrimaryDownloadVariant({
          encrypted,
          hasReference: true,
          mimeType: DOCX_MIME,
        }),
      ).toBe("original");
    }
  });
});
