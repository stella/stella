import { describe, expect, test } from "bun:test";

import { resolvePrimaryDownloadVariant } from "@/components/inspector/file-download-service.logic";
import { DOCX_MIME, PDF_MIME } from "@/lib/consts";

describe("primary download variant", () => {
  test("hands over the reference copy of a readable DOCX whose version is referenced", () => {
    expect(
      resolvePrimaryDownloadVariant({
        encrypted: false,
        mimeType: DOCX_MIME,
        reference: "2026/001/015.v3",
      }),
    ).toBe("reference");
  });

  // The matter's own reference is not the signal: a version created before
  // the matter got one is stamped null, and the server refuses to build a
  // reference copy of it.
  test("keeps the original when the version carries no reference or none is resolved yet", () => {
    for (const reference of [null, undefined, ""]) {
      expect(
        resolvePrimaryDownloadVariant({
          encrypted: false,
          mimeType: DOCX_MIME,
          reference,
        }),
      ).toBe("original");
    }
  });

  test("keeps the original for formats that cannot carry a reference", () => {
    for (const mimeType of [PDF_MIME, "text/plain", undefined]) {
      expect(
        resolvePrimaryDownloadVariant({
          encrypted: false,
          mimeType,
          reference: "2026/001/015.v3",
        }),
      ).toBe("original");
    }
  });

  test("keeps the original when the bytes are encrypted or unresolved", () => {
    for (const encrypted of [true, undefined]) {
      expect(
        resolvePrimaryDownloadVariant({
          encrypted,
          mimeType: DOCX_MIME,
          reference: "2026/001/015.v3",
        }),
      ).toBe("original");
    }
  });
});
