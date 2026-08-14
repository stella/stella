import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { DocumentOcrProviderError } from "@/api/lib/document-processing-ocr-result";
import { LIMITS } from "@/api/lib/limits";
import { recognizePdfTextLocally } from "@/api/lib/ocr-local/recognize-local";

/**
 * The class these pin: size limits on untrusted input must be enforced
 * before the input is materialized, and a backend that cannot declare a
 * size must still be bounded after the read — in both cases before any
 * subprocess is spawned.
 */

const baseOptions = {
  idempotencyKey: "ocr:test",
  signal: new AbortController().signal,
  sourceKey: "org/ws/file",
  sourceUrl: "https://storage.example/presigned",
  // The configuration gate sits before the behavior under test.
  resolveModelDir: () => "/tmp/ocr-models-test-env",
};

describe("recognizePdfTextLocally size bounds", () => {
  test("a declared oversized source is refused before the object is read", async () => {
    let readCalled = false;
    const result = await recognizePdfTextLocally({
      ...baseOptions,
      readSourceSize: async () => LIMITS.documentOcrSourceMaxBytes + 1,
      readSource: async () => {
        readCalled = true;
        return new ArrayBuffer(1);
      },
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toBeInstanceOf(DocumentOcrProviderError);
      expect(result.error.code).toBe("response_too_large");
    }
    expect(readCalled).toBe(false);
  });

  test("an undeclared size is still bounded after the read, before any spawn", async () => {
    const result = await recognizePdfTextLocally({
      ...baseOptions,
      readSourceSize: async () => null,
      readSource: async () =>
        new ArrayBuffer(LIMITS.documentOcrSourceMaxBytes + 1),
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.code).toBe("response_too_large");
    }
  });
});
