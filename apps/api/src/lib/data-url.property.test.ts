import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import { parseDataUrl, toDataUrl } from "@/api/lib/data-url";

const mimeType = fc.constantFrom(
  "image/png",
  "image/jpeg",
  "application/pdf",
  "text/plain",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
);

const payload = fc.uint8Array({ maxLength: 4096 });

describe("data URL codec (properties)", () => {
  test("parseDataUrl recovers the exact bytes and mime toDataUrl emitted", () => {
    fc.assert(
      fc.property(payload, mimeType, (bytes, mime) => {
        const result = parseDataUrl({
          url: toDataUrl(bytes, mime),
          maxBytes: 1_000_000,
        });
        expect(Result.isOk(result)).toBe(true);
        if (Result.isOk(result)) {
          expect(result.value.mimeType).toBe(mime);
          expect([...result.value.bytes]).toEqual([...bytes]);
        }
      }),
      propertyConfig({ numRuns: 300 }),
    );
  });

  test("a payload larger than maxBytes is always rejected", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 1, maxLength: 4096 }),
        mimeType,
        (bytes, mime) => {
          const result = parseDataUrl({
            url: toDataUrl(bytes, mime),
            maxBytes: bytes.length - 1,
          });
          expect(Result.isError(result)).toBe(true);
        },
      ),
      propertyConfig({ numRuns: 300 }),
    );
  });

  test("a mime type other than expected is always rejected", () => {
    fc.assert(
      fc.property(payload, mimeType, mimeType, (bytes, actual, expected) => {
        fc.pre(actual !== expected);
        const result = parseDataUrl({
          url: toDataUrl(bytes, actual),
          maxBytes: 1_000_000,
          expectedMimeType: expected,
        });
        expect(Result.isError(result)).toBe(true);
      }),
      propertyConfig({ numRuns: 200 }),
    );
  });
});
